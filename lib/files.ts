import { Worker } from "node:worker_threads";
import path from "node:path";
import { AppError } from "./errors";
import { LIMITS } from "./contracts";

export function validateFileName(name: string) {
  if (!name || name.length > 160 || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) || name.endsWith(".") || name.endsWith(" ")) {
    throw new AppError(400, "Use a simple file name (up to 160 characters, without paths or special characters).");
  }
  const extension = name.split(".").at(-1)?.toLowerCase() || "";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "mp4", "mov", "webm", "mkv", "avi"].includes(extension)) {
    throw new AppError(415, "This Copilot SDK exposes native image input, not audio/video understanding. Attach a transcript or still images instead; no separate transcription service is enabled.");
  }
  if (!["txt", "md", "csv", "json", "log", "yaml", "yml", "xml", "pdf", "docx", "xlsx", "png", "jpg", "jpeg", "webp", "gif"].includes(extension)) {
    throw new AppError(415, "Use a supported document, UTF-8 text file, or PNG/JPEG/WebP/static GIF image. Executables and arbitrary archives are not supported.");
  }
  return extension;
}
export async function extractFile(name: string, bytes: Buffer): Promise<{ text: string; notes: string; mimeType?: string }> {
  const extension = validateFileName(name);
  if (!bytes.length) throw new AppError(400, "The file is empty.");
  if (bytes.length > LIMITS.fileBytes) throw new AppError(413, "Each file must be 5 MB or smaller.");
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve("scripts", "extract-file.mjs"), {
      workerData: { bytes, extension },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let finished = false;
    const finish = (error?: Error, result?: { text: string; notes: string; mimeType?: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate().catch(cause => console.error("[model-chat] Parser cleanup failed:", cause.name));
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const timer = setTimeout(() => finish(new AppError(422, "File parsing took more than 20 seconds. Try a smaller or simpler document.")), 20_000);
    worker.once("message", (data: unknown) => {
      if (!data || typeof data !== "object") return finish(new AppError(422, "The file parser returned an invalid result."));
      if ("ok" in data && data.ok && "text" in data && typeof data.text === "string" && "notes" in data && typeof data.notes === "string" &&
          data.text.length <= LIMITS.fileCharacters) {
        const mimeType = "mimeType" in data && typeof data.mimeType === "string" ? data.mimeType : "text/plain";
        if (!["text/plain", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)) return finish(new AppError(422, "The parser returned an unsupported media type."));
        finish(undefined, { text: data.text, notes: data.notes, mimeType });
      } else {
        finish(new AppError(422, "error" in data && typeof data.error === "string" ? data.error : "The file could not be read."));
      }
    });
    worker.once("error", () => finish(new AppError(422, "The file parser failed or ran out of memory. Try a smaller document.")));
    worker.once("exit", () => { if (!finished) finish(new AppError(422, "The file parser stopped unexpectedly.")); });
  });
}
