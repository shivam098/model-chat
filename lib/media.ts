import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { LIMITS, isMediaExtension } from "./contracts";
import { runtimeEnvironment } from "./runtime-env.mjs";

export interface MediaFrame { seconds: number; mimeType: "image/jpeg"; bytes: Buffer }
export interface ProcessingProgress { stage: string; fraction: number }
const configSchema = z.object({ python: z.string(), modelPath: z.string(), modelName: z.string() });
function readConfig() {
  const file = path.join(dataDirectory, "media-config.json");
  if (!existsSync(file)) throw new AppError(503, "Local audio/video processing is not configured. The host owner needs to run npm run setup:media.");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { throw new AppError(503, "The local media configuration could not be read. Run npm run setup:media."); }
  const result = configSchema.safeParse(value);
  if (!result.success || !path.isAbsolute(result.data.python) || !path.isAbsolute(result.data.modelPath) ||
      !existsSync(result.data.python) || !existsSync(path.join(result.data.modelPath, "model.bin"))) {
    throw new AppError(503, "The configured Python or local Whisper model is unavailable. Run npm run setup:media.");
  }
  return result.data;
}
export function mediaStatus() {
  try { const config = readConfig(); return { ready: true, model: config.modelName, message: "Local background transcription and sampled video frames are available." }; }
  catch (error) {
    if (error instanceof AppError) return { ready: false, model: null, message: error.message };
    throw error;
  }
}
export async function processMediaFile(extension: string, input: string, directory: string, signal: AbortSignal, authorize: () => void, progress: (value: ProcessingProgress) => void) {
  if (!isMediaExtension(extension)) throw new AppError(400, "Unsupported media format.");
  const config = readConfig();
  authorize(); signal.throwIfAborted();
  let result: unknown;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.python, [
      path.resolve("scripts", "media-worker.py"), "--input", input, "--output", directory, "--model", config.modelPath, "--model-name", config.modelName,
    ], { cwd: directory, env: { ...runtimeEnvironment(), NODE_ENV: process.env.NODE_ENV || "production", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let buffer = "";
    let failure: Error | undefined;
    let settled = false;
    const stop = (error: Error) => { failure ||= error; child.kill(); };
    const abort = () => stop(new AppError(499, "Media processing was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    const monitor = setInterval(() => {
      try { authorize(); } catch (error) { stop(error instanceof Error ? error : new AppError(403, "Access ended.")); }
    }, 500);
    const line = (text: string) => {
      if (!text.trim()) return;
      const value: unknown = JSON.parse(text);
      const update = z.object({ event: z.literal("progress"), stage: z.enum(["sampling_frames", "starting_transcription", "transcribing"]), seconds: z.number().nonnegative(), duration: z.number().nonnegative().nullable() }).safeParse(value);
      if (update.success) {
        authorize();
        const seconds = Math.round(update.data.seconds);
        progress({ stage: `${update.data.stage === "sampling_frames" ? "Sampling video" : "Transcribing"} · ${seconds}s processed`,
          fraction: update.data.duration ? Math.min(0.9, update.data.seconds / update.data.duration * 0.9) : 0 });
      } else result = value;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearInterval(monitor); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        buffer += chunk.toString("utf8");
        if (buffer.length > 4 * 1024 * 1024) throw new AppError(422, "The media processor emitted invalid oversized metadata.");
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const text of lines) line(text);
      } catch (error) { stop(error instanceof AppError ? error : new AppError(422, "Invalid media progress output.")); }
    });
    child.stderr.resume();
    child.once("error", () => finish(new AppError(503, "The local Python media processor could not start. Run npm run setup:media.")));
    child.once("close", code => {
      try { if (buffer.trim()) line(buffer); } catch { failure ||= new AppError(422, "Invalid media result."); }
      const reported = z.object({ ok: z.literal(false), error: z.string().max(500) }).safeParse(result);
      finish(failure || (reported.success ? new AppError(422, reported.data.error) : code !== 0 ? new AppError(422, "The media processor stopped unexpectedly. The original upload is retained.") : undefined));
    });
    if (signal.aborted) abort();
  });
  authorize(); signal.throwIfAborted();
  const parsed = z.object({
    ok: z.literal(true), textFile: z.literal("text.txt"), notes: z.string().max(2000),
    mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "audio/aac", "audio/mp4", "audio/webm", "audio/x-matroska", "video/mp4", "video/webm", "video/x-matroska", "video/x-msvideo"]),
    frames: z.array(z.object({ seconds: z.number().nonnegative(), mimeType: z.literal("image/jpeg"), data: z.string().max(700_000).regex(/^[A-Za-z0-9+/]*={0,2}$/) })).max(LIMITS.videoFrames),
  }).safeParse(result);
  if (!parsed.success) throw new AppError(422, "The media processor returned an invalid result.");
  const frames = parsed.data.frames.map(frame => {
    const bytes = Buffer.from(frame.data, "base64");
    if (!bytes.length || bytes.length > LIMITS.videoFrameBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new AppError(422, "A sampled frame is invalid.");
    return { seconds: frame.seconds, mimeType: frame.mimeType, bytes };
  });
  return { textPath: path.join(directory, "text.txt"), notes: parsed.data.notes, mimeType: parsed.data.mimeType, frames };
}

// Convenience wrapper for direct local checks; the upload queue uses the file-based path.
export async function processMedia(extension: string, bytes: Buffer, signal: AbortSignal, authorize: () => void) {
  if (!isMediaExtension(extension)) throw new AppError(400, "Unsupported media format.");
  if (!bytes.length) throw new AppError(400, "The file is empty.");
  const root = path.join(dataDirectory, "processing");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, "media-"));
  try {
    const input = path.join(directory, `input.${extension}`);
    await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
    const result = await processMediaFile(extension, input, directory, signal, authorize, () => {});
    return { ...result, text: await readFile(result.textPath, "utf8") };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
