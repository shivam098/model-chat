import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { LIMITS, isMediaExtension } from "./contracts";
import { runtimeEnvironment } from "./runtime-env.mjs";

export interface MediaFrame { seconds: number; mimeType: "image/jpeg"; bytes: Buffer }
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
  try { const config = readConfig(); return { ready: true, model: config.modelName, message: "Local transcription and sampled video frames are available." }; }
  catch (error) {
    if (error instanceof AppError) return { ready: false, model: null, message: error.message };
    throw error;
  }
}
export async function processMedia(extension: string, bytes: Buffer, signal: AbortSignal, authorize: () => void): Promise<{ text: string; notes: string; mimeType: string; frames: MediaFrame[] }> {
  if (!isMediaExtension(extension) || !bytes.length || bytes.length > LIMITS.mediaBytes) throw new AppError(400, "Use a nonempty supported media file of at most 25 MB.");
  const config = readConfig();
  authorize(); signal.throwIfAborted();
  const root = path.join(dataDirectory, "processing");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(root, "media-"));
  const input = path.join(directory, `input.${extension}`);
  try {
    await writeFile(input, bytes, { mode: 0o600, flag: "wx" });
    let exitCode: number | null = null;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.python, [
        path.resolve("scripts", "media-worker.py"), "--input", input, "--model", config.modelPath, "--model-name", config.modelName,
      ], { cwd: directory, env: { ...runtimeEnvironment(), NODE_ENV: process.env.NODE_ENV || "production", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let total = 0;
      let failure: Error | undefined;
      let settled = false;
      const stop = (error: Error) => { failure ||= error; child.kill(); };
      const abort = () => stop(new AppError(499, "Media processing was cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => stop(new AppError(422, "Media processing exceeded 90 seconds. Try a shorter recording.")), 90_000);
      const monitor = setInterval(() => {
        try { authorize(); } catch (error) { stop(error instanceof Error ? error : new AppError(403, "Access ended.")); }
      }, 500);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); clearInterval(monitor); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(stdout);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > 4 * 1024 * 1024) stop(new AppError(422, "Media output exceeded the safe size limit."));
        else stdout += chunk.toString("utf8");
      });
      child.stderr.resume();
      child.once("error", () => finish(new AppError(503, "The local Python media processor could not start. Run npm run setup:media.")));
      child.once("close", code => { exitCode = code; finish(failure); });
      if (signal.aborted) abort();
    });
    authorize(); signal.throwIfAborted();
    let parsed: unknown;
    try { parsed = JSON.parse(output.trim()); } catch { throw new AppError(422, "The media processor returned an invalid result. Try a shorter standard recording."); }
    const result = z.object({
      ok: z.literal(true), text: z.string().min(1).max(LIMITS.fileCharacters), notes: z.string().max(2000),
      mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/flac", "audio/ogg", "audio/aac", "audio/mp4", "audio/webm", "audio/x-matroska", "video/mp4", "video/webm", "video/x-matroska", "video/x-msvideo"]),
      frames: z.array(z.object({
        seconds: z.number().min(0).max(LIMITS.mediaSeconds + 0.5), mimeType: z.literal("image/jpeg"),
        data: z.string().max(700_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })).max(LIMITS.videoFrames),
    }).safeParse(parsed);
    if (!result.success) {
      const error = z.object({ ok: z.literal(false), error: z.string().max(500) }).safeParse(parsed);
      throw new AppError(422, error.success ? error.data.error : "The media processor returned an unsupported result.");
    }
    if (exitCode !== 0) throw new AppError(422, "The media processor stopped before completing successfully.");
    const frames = result.data.frames.map(frame => {
      const content = Buffer.from(frame.data, "base64");
      if (!content.length || content.length > LIMITS.videoFrameBytes || content[0] !== 0xff || content[1] !== 0xd8) throw new AppError(422, "A sampled frame is invalid or too large.");
      return { seconds: frame.seconds, mimeType: frame.mimeType, bytes: content };
    });
    return { text: result.data.text, notes: result.data.notes, mimeType: result.data.mimeType, frames };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
