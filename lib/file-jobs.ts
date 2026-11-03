import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { isMediaExtension } from "./contracts";
import { processMediaFile, type MediaFrame } from "./media";
import type { Store } from "./store";
import { UploadStore, type FileJob } from "./upload-store";
import { requireDiskCapacity } from "./upload-io";

interface ProcessedFile { textPath: string; notes: string; mimeType: string; frames?: MediaFrame[]; image?: Buffer }
async function documentFile(input: string, output: string, extension: string, signal: AbortSignal, check: () => void, progress: (stage: string, fraction: number) => void): Promise<ProcessedFile> {
  if (["txt", "md", "csv", "json", "log", "yaml", "yml", "xml"].includes(extension)) {
    const size = (await stat(input)).size;
    const target = await open(output, "wx", 0o600);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    try {
      for await (const part of createReadStream(input, { highWaterMark: 64 * 1024 })) {
        check(); signal.throwIfAborted();
        const text = decoder.decode(part, { stream: true });
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new AppError(422, "The text file contains binary control data.");
        await target.writeFile(text);
        bytes += part.length;
        progress("Reading UTF-8 text", size ? bytes / size * 0.8 : 0);
      }
      await target.writeFile(decoder.decode());
    } catch (error) {
      if (error instanceof TypeError) throw new AppError(422, "Text files must use UTF-8 encoding.");
      throw error;
    } finally { await target.close(); }
    return { textPath: output, notes: "UTF-8 text indexed in full. Code and formulas are not executed; JSON/XML syntax is treated as text.", mimeType: "text/plain" };
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve("scripts", "extract-file.mjs"), {
      workerData: { inputPath: input, outputPath: output, extension },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let finished = false;
    const finish = (error?: Error, result?: ProcessedFile) => {
      if (finished) return;
      finished = true; clearInterval(monitor); signal.removeEventListener("abort", abort);
      void worker.terminate().catch(cause => console.error("[model-chat] Parser cleanup failed:", cause.name));
      if (error) reject(error); else if (result) resolve(result);
    };
    const abort = () => finish(new AppError(499, "File processing was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    const monitor = setInterval(() => { try { check(); } catch (error) { finish(error instanceof Error ? error : new AppError(403, "Access ended.")); } }, 500);
    worker.on("message", (value: unknown) => {
      const update = z.object({ progress: z.number(), stage: z.string().max(100) }).safeParse(value);
      if (update.success) { try { progress(update.data.stage, update.data.progress * 0.8); } catch (error) { finish(error instanceof Error ? error : new AppError(409, "Job changed.")); } return; }
      const result = z.object({ ok: z.literal(true), notes: z.string(), mimeType: z.string(), analysisBytes: z.instanceof(Uint8Array).optional() }).safeParse(value);
      if (result.success) finish(undefined, { textPath: output, notes: result.data.notes, mimeType: result.data.mimeType, image: result.data.analysisBytes ? Buffer.from(result.data.analysisBytes) : undefined });
      else {
        const error = z.object({ ok: z.literal(false), error: z.string() }).safeParse(value);
        finish(new AppError(422, error.success ? error.data.error : "The document parser returned an invalid result."));
      }
    });
    worker.once("error", () => finish(new AppError(422, "The isolated document parser failed or exhausted its memory budget. The original upload is retained.")));
    worker.once("exit", () => { if (!finished) finish(new AppError(422, "The document parser stopped unexpectedly.")); });
    if (signal.aborted) abort();
  });
}

export class FileJobQueue {
  private active = new Map<string, AbortController>();
  private work = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private polling = false;
  readonly uploads: UploadStore;
  constructor(private store: Store) { this.uploads = new UploadStore(store); }
  start() {
    if (this.timer) return;
    this.uploads.recover();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.work);
  }
  tick() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      for (const lane of ["media", "document"]) {
        if (this.active.has(lane)) continue;
        const job = this.uploads.claim(lane === "media");
        if (!job) continue;
        const controller = new AbortController();
        this.active.set(lane, controller);
        const work = this.process(job, controller.signal).catch(error => console.error("[model-chat] Background file job failed:", error instanceof Error ? error.name : "Unknown"))
          .finally(() => { this.active.delete(lane); this.work.delete(work); this.tick(); });
        this.work.add(work);
      }
    } finally { this.polling = false; }
  }
  private async process(job: FileJob, signal: AbortSignal) {
    const root = path.join(dataDirectory, "processing");
    let directory: string | undefined;
    const check = () => { signal.throwIfAborted(); this.uploads.check(job); };
    let lastProgress = 0;
    const progress = (stage: string, fraction: number) => {
      check();
      if (Date.now() - lastProgress > 350) { this.uploads.progress(job, stage, fraction); lastProgress = Date.now(); }
    };
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(root, "job-"));
      check();
      const size = (this.store.db.prepare("SELECT size FROM app_file WHERE id=?").get(job.fileId) as { size: number }).size;
      await requireDiskCapacity(size);
      const input = path.join(directory, `original.${job.extension}`);
      const file = await open(input, "wx", 0o600);
      try {
        let written = 0;
        for (const chunk of this.uploads.rawChunks(job.fileId)) {
          check(); await file.writeFile(chunk); written += chunk.length;
          progress("Preparing file", size ? written / size * 0.05 : 0);
        }
      } finally { await file.close(); }
      const output = path.join(directory, "text.txt");
      const processed: ProcessedFile = isMediaExtension(job.extension)
        ? await processMediaFile(job.extension, input, directory, signal, check, value => progress(value.stage, value.fraction))
        : await documentFile(input, output, job.extension, signal, check, progress);
      check();
      const textSize = (await stat(processed.textPath)).size;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "", position = 0, characters = 0, consumed = 0;
      const insert = this.store.db.prepare("INSERT INTO app_text_chunk(fileId,position,content) VALUES (?,?,?)");
      const writeChunk = (text: string) => { insert.run(job.fileId, position++, text); characters += text.length; };
      for await (const bytes of createReadStream(processed.textPath, { highWaterMark: 32 * 1024 })) {
        check();
        pending += decoder.decode(bytes, { stream: true });
        this.store.db.transaction(() => {
          check();
          while (pending.length >= 4000) {
            const end = /[\uD800-\uDBFF]/.test(pending[3999]) ? 3999 : 4000;
            writeChunk(pending.slice(0, end)); pending = pending.slice(end);
          }
        })();
        consumed += bytes.length;
        if (consumed % (1024 * 1024) < bytes.length) await requireDiskCapacity(1024 * 1024);
        progress("Indexing extracted text", 0.9 + (textSize ? consumed / textSize * 0.09 : 0));
      }
      pending += decoder.decode();
      if (pending) writeChunk(pending);
      this.store.db.transaction(() => {
        check();
        for (const [index, frame] of (processed.frames || []).entries()) {
          this.store.db.prepare("INSERT INTO app_media_frame VALUES (?,?,?,?,?,?)").run(randomUUID(), job.fileId, index, frame.seconds, frame.mimeType, frame.bytes);
        }
        if (processed.image) this.store.db.prepare("INSERT INTO app_analysis_image VALUES (?,?,?)").run(job.fileId, "image/jpeg", processed.image);
        this.store.db.prepare("UPDATE app_file SET text='',characters=?,notes=?,mimeType=? WHERE id=?").run(characters, processed.notes, processed.mimeType, job.fileId);
        this.store.db.prepare("UPDATE app_file_job SET status='ready',stage='Ready',progress=1,error=NULL,lease=NULL,updatedAt=? WHERE fileId=?").run(Date.now(), job.fileId);
        this.uploads.audit(job, "allowed", "ready");
      })();
    } catch (error) {
      const message = error instanceof AppError ? error.message : signal.aborted ? "Processing was interrupted." : "This file could not be processed. The original upload is retained; retry or download it.";
      this.uploads.fail(job, message, this.stopped, error instanceof AppError && error.status === 403);
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}

const state = globalThis as typeof globalThis & { modelChatFileQueue?: FileJobQueue; modelChatStopFileQueue?: () => void };
export function startFileJobs(store: Store) {
  if (!state.modelChatFileQueue) {
    state.modelChatFileQueue = new FileJobQueue(store);
    state.modelChatStopFileQueue = () => state.modelChatFileQueue?.stop();
    state.modelChatFileQueue.start();
  }
  return state.modelChatFileQueue;
}
