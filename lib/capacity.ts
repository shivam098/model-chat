import os from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Replies run in parallel without a fixed cap. Each one starts its own Copilot runtime process; measured on this PC (2026-11-26) one
 * uses about 95 MB of RAM (working set) and 116–131 MB committed with its session open (see the README). A new reply waits to start,
 * never fails, only while starting it would leave less than MEMORY_RESERVE_MB available, counting replies that started moments ago.
 */
export const REPLY_MEMORY_MB = 256;
export const MEMORY_RESERVE_MB = 1024;
const STARTING_MS = 30_000;
export const WAITING_STAGE = "Waiting to start: this computer is short of memory. It starts by itself as soon as memory frees up; Stop cancels it.";

export interface MemoryProbe { available?: () => number; pollMs?: number }
const state = globalThis as typeof globalThis & { modelChatReplyStarts?: Map<symbol, number> };
// Replies that started moments ago: their runtimes may not show in the available memory yet. A reservation ends when the reply finishes or after 30 s.
const starts = state.modelChatReplyStarts ||= new Map<symbol, number>();

/** Memory available to new processes, in MB. macOS reports only completely free pages to Node, so inactive and purgeable pages count too. */
export function availableMemoryMB(): number {
  if (process.platform === "darwin") {
    const result = spawnSync("vm_stat", [], { encoding: "utf8", timeout: 5000 });
    const page = Number(/page size of (\d+) bytes/.exec(result.stdout || "")?.[1]);
    const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(result.stdout || "")?.[1] ?? 0);
    if (page > 0) return Math.floor((pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page / 1048576);
  }
  return Math.floor(os.freemem() / 1048576);
}

/** Takes a start reservation right away if memory allows (null otherwise). Release it when the reply ends. */
export function reserveMemory(probe: MemoryProbe = {}): (() => void) | null {
  const available = probe.available ?? availableMemoryMB;
  const now = Date.now();
  for (const [key, at] of starts) if (now - at > STARTING_MS) starts.delete(key);
  if (available() < MEMORY_RESERVE_MB + REPLY_MEMORY_MB * (starts.size + 1)) return null;
  const key = Symbol("reply");
  starts.set(key, now);
  return () => { starts.delete(key); };
}

/** Resolves when a new reply can start, with whether it had to wait and a release for when it ends. Rejects with an AbortError if `signal` aborts while waiting. */
export async function waitForMemory(signal: AbortSignal, onWaiting: () => void, probe: MemoryProbe = {}): Promise<{ waited: boolean; release: () => void }> {
  let waited = false;
  for (;;) {
    signal.throwIfAborted();
    const release = reserveMemory(probe);
    if (release) return { waited, release };
    if (!waited) { waited = true; onWaiting(); }
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
      const stop = () => { done(); reject(new DOMException("Reply cancelled", "AbortError")); };
      const timer = setTimeout(() => { done(); resolve(); }, probe.pollMs ?? 2000);
      signal.addEventListener("abort", stop, { once: true });
    });
  }
}
