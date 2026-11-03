import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { runtimeEnvironment } from "./runtime-env.mjs";

export const SANDBOX_DISTRO = "ModelChatSandbox";
export const SANDBOX_TOOL = "run_python";
export const SANDBOX_RUNS_PER_REPLY = 8;
const limitSchema = z.object({
  wallSeconds: z.number().int().positive(), cpuSeconds: z.number().int().positive(), memoryBytes: z.number().int().positive(),
  pids: z.number().int().positive(), cpus: z.number().int().positive(), workBytes: z.number().int().positive(),
  inputBytes: z.number().int().positive(), inputFiles: z.number().int().positive(), codeBytes: z.number().int().positive(),
  outputFiles: z.number().int().positive(), outputBytes: z.number().int().positive(), fileBytes: z.number().int().positive(),
  logBytes: z.number().int().positive(),
});
export type SandboxLimits = z.infer<typeof limitSchema>;
const configSchema = z.object({
  distro: z.literal(SANDBOX_DISTRO), ready: z.literal(true), libraries: z.array(z.string().max(80)).max(200),
  extraApt: z.array(z.string().max(80)).max(200).default([]), extraPip: z.array(z.string().max(160)).max(200).default([]),
  limits: limitSchema,
});
export type SandboxConfig = z.infer<typeof configSchema>;
export function sandboxConfig(): SandboxConfig | null {
  if (process.env.MODEL_CHAT_DISABLE_SANDBOX === "1") return null;
  const file = path.join(dataDirectory, "sandbox-config.json");
  if (!existsSync(file)) return null;
  try { return configSchema.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { return null; }
}
export function sandboxStatus() {
  const config = sandboxConfig();
  if (!config) return { ready: false, message: "The code runner is not set up. The host owner can run npm run setup:sandbox on this computer.", libraries: [] as string[], limits: null };
  return {
    ready: true, message: "Code runner available: Python in a disposable WSL sandbox with no internet.",
    libraries: [...config.libraries, ...config.extraApt, ...config.extraPip], limits: config.limits,
  };
}

export interface SandboxInput { name: string; size: number; chunks: () => Iterable<Buffer> }
export interface SandboxOutput { name: string; bytes: Buffer }
const resultSchema = z.object({
  type: z.literal("result"),
  status: z.enum(["ok", "error", "timeout", "cancelled", "memory_limit", "cpu_limit", "rejected"]),
  exitCode: z.number().int().nullable(), durationMs: z.number().nonnegative(),
  stdout: z.string().max(100_000), stderr: z.string().max(100_000),
  stdoutTruncated: z.boolean().optional(), stderrTruncated: z.boolean().optional(),
  error: z.string().max(400).optional(), processLimitReached: z.boolean(),
  rejected: z.array(z.object({ name: z.string().max(200), reason: z.string().max(60) })).max(600),
});
const fileSchema = z.object({ type: z.literal("file"), name: z.string().min(1).max(200), size: z.number().int().nonnegative() });
export interface SandboxResult {
  status: z.infer<typeof resultSchema>["status"]; exitCode: number | null; durationMs: number;
  stdout: string; stderr: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; error?: string;
  processLimitReached: boolean; rejected: { name: string; reason: string }[]; files: SandboxOutput[];
}

function frame(header: object, payload?: Buffer): Buffer[] {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return payload ? [length, json, payload] : [length, json];
}
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private header: z.infer<typeof fileSchema> | null = null;
  private parts: Buffer[] = [];
  private received = 0;
  files: SandboxOutput[] = [];
  result: z.infer<typeof resultSchema> | null = null;
  total = 0;
  constructor(private limits: { files: number; bytes: number; fileBytes: number }) {}
  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.result) { if (this.buffer.length) throw new AppError(502, "The sandbox sent data after its result."); return; }
      if (this.header) {
        const take = Math.min(this.header.size - this.received, this.buffer.length);
        if (take) { this.parts.push(this.buffer.subarray(0, take)); this.received += take; this.buffer = this.buffer.subarray(take); }
        if (this.received < this.header.size) return;
        this.files.push({ name: this.header.name, bytes: Buffer.concat(this.parts) });
        this.header = null; this.parts = []; this.received = 0;
        continue;
      }
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32BE(0);
      if (!length || length > 1024 * 1024) throw new AppError(502, "The sandbox sent an invalid frame.");
      if (this.buffer.length < 4 + length) return;
      let value: unknown;
      try { value = JSON.parse(this.buffer.subarray(4, 4 + length).toString("utf8")); }
      catch { throw new AppError(502, "The sandbox sent an invalid frame."); }
      this.buffer = this.buffer.subarray(4 + length);
      const file = fileSchema.safeParse(value);
      if (file.success) {
        this.total += file.data.size;
        if (this.files.length >= this.limits.files || file.data.size > this.limits.fileBytes || this.total > this.limits.bytes) {
          throw new AppError(502, "The sandbox returned more output than allowed.");
        }
        this.header = file.data;
        continue;
      }
      const result = resultSchema.safeParse(value);
      if (!result.success) throw new AppError(502, "The sandbox sent an unexpected frame.");
      this.result = result.data;
    }
  }
}

const state = globalThis as typeof globalThis & { modelChatSandboxRuns?: Map<string, { subjectId: string; actorId: string }> };
const active = state.modelChatSandboxRuns ||= new Map();
export const SANDBOX_APP_CONCURRENCY = 2;
export function reserveSandbox(runId: string, subjectId: string, actorId: string) {
  if (active.size >= SANDBOX_APP_CONCURRENCY || [...active.values()].some(run => run.subjectId === subjectId || run.actorId === actorId)) {
    throw new AppError(429, "The code runner is busy. One run per account and two per app can run at once.");
  }
  active.set(runId, { subjectId, actorId });
  return () => { active.delete(runId); };
}

export async function runSandbox(code: string, inputs: SandboxInput[], options: { signal: AbortSignal; limits?: Partial<SandboxLimits> }): Promise<SandboxResult> {
  const config = sandboxConfig();
  if (!config) throw new AppError(503, sandboxStatus().message);
  const limits = { ...config.limits };
  for (const [key, value] of Object.entries(options.limits || {})) {
    const name = key as keyof SandboxLimits;
    if (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < limits[name]) limits[name] = value as number;
  }
  const program = Buffer.from(code, "utf8");
  if (!program.length || program.length > limits.codeBytes) throw new AppError(400, "The program is empty or too large for the sandbox.");
  if (inputs.length > limits.inputFiles || inputs.reduce((sum, input) => sum + input.size, 0) > limits.inputBytes) {
    throw new AppError(413, "The selected input files exceed the sandbox input limit.");
  }
  options.signal.throwIfAborted();
  const wsl = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wsl.exe");
  const child = spawn(wsl, ["-d", SANDBOX_DISTRO, "-u", "root", "--cd", "/", "--exec", "/usr/bin/python3", "-I", "/opt/modelchat/bin/run-job.py"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: runtimeEnvironment() as NodeJS.ProcessEnv,
  });
  const reader = new FrameReader({ files: limits.outputFiles, bytes: limits.outputBytes, fileBytes: limits.fileBytes });
  let failure: Error | undefined;
  let writeFailure: Error | undefined;
  let diagnostics = "";
  const exited = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
  child.once("error", error => { failure ||= new AppError(503, `The sandbox could not start (${error.message}). The host owner can run npm run setup:sandbox.`); });
  child.stdin.on("error", error => { writeFailure ||= error; });
  child.stdout.on("data", (chunk: Buffer) => {
    try { reader.push(chunk); } catch (error) { failure ||= error as Error; child.kill(); }
  });
  child.stderr.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString("utf8")).slice(-2000); });
  const cancel = () => { if (!child.stdin.destroyed) child.stdin.end(); setTimeout(() => { if (child.exitCode === null) child.kill(); }, 10_000).unref(); };
  options.signal.addEventListener("abort", cancel, { once: true });
  const hardStop = setTimeout(() => { failure ||= new AppError(504, "The sandbox did not respond in time."); child.kill(); }, (limits.wallSeconds + 60) * 1000);
  const write = (parts: Buffer[]) => new Promise<void>((resolve, reject) => {
    if (writeFailure || child.stdin.destroyed || child.exitCode !== null) return reject(writeFailure || new AppError(499, "The sandbox input closed."));
    const done = (error?: Error) => { child.stdin.off("drain", drained); child.stdin.off("error", done); child.off("close", closed); if (error) reject(error); else resolve(); };
    const drained = () => done();
    const closed = () => done(new AppError(499, "The sandbox input closed."));
    if (child.stdin.write(Buffer.concat(parts))) return resolve();
    child.stdin.once("drain", drained); child.stdin.once("error", done); child.once("close", closed);
  });
  try {
    await write(frame({ type: "job", limits }));
    await write(frame({ type: "code", size: program.length }, program));
    for (const input of inputs) {
      options.signal.throwIfAborted();
      await write(frame({ type: "file", name: input.name, size: input.size }));
      let written = 0;
      for (const chunk of input.chunks()) {
        options.signal.throwIfAborted();
        written += chunk.length;
        if (written > input.size) throw new AppError(500, "An input file changed while it was being copied.");
        await write([chunk]);
      }
      if (written !== input.size) throw new AppError(500, "An input file changed while it was being copied.");
    }
    await write(frame({ type: "end" }));
  } catch (error) {
    if (!options.signal.aborted && !(error instanceof AppError && error.status === 499)) writeFailure ||= error as Error;
    cancel();
  }
  const exitCode = await exited;
  clearTimeout(hardStop);
  options.signal.removeEventListener("abort", cancel);
  if (failure) throw failure;
  if (!reader.result) {
    if (options.signal.aborted) return { status: "cancelled", exitCode: null, durationMs: 0, stdout: "", stderr: "", processLimitReached: false, rejected: [], files: [] };
    if (writeFailure instanceof AppError) throw writeFailure;
    console.error("[model-chat] Sandbox ended without a result:", exitCode, diagnostics.replace(/\s+/g, " ").slice(-300));
    throw new AppError(503, "The sandbox ended without a result. The host owner can run npm run setup:sandbox -- --status.");
  }
  const { type: _type, ...result } = reader.result;
  return { ...result, files: result.status === "cancelled" ? [] : reader.files };
}
