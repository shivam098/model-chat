import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { networkPolicy } from "./network-policy.mjs";

export const NODE = ["node.exe", "node"];
export const CLOUDFLARED = ["cloudflared.exe", "cloudflared"];
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

export function processImage(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
    for (const line of (result.stdout || "").split(/\r?\n/)) {
      const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (match && Number(match[2]) === pid) return match[1].toLowerCase();
    }
    return null;
  }
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase(); } catch { return null; }
}
export const isCloudflared = pid => CLOUDFLARED.includes(processImage(pid));
export const isNode = pid => NODE.includes(processImage(pid));

export function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [pscustomobject]@{ name = $p.Name; commandLine = $p.CommandLine; created = $p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }`;
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
      const info = JSON.parse(result.stdout.trim());
      return { name: String(info.name).toLowerCase(), commandLine: String(info.commandLine || ""), created: Date.parse(info.created) };
    }
    return {
      name: readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase(),
      commandLine: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "),
      created: statSync(`/proc/${pid}`).ctimeMs,
    };
  } catch { return null; }
}
// A recorded PID is trusted only if it is the expected program and started before it was recorded:
// a reused PID (for example after a reboot) always belongs to a process created later.
export function sameProcess(pid, recordedAt, names, commandParts = []) {
  const at = typeof recordedAt === "number" ? recordedAt : Date.parse(recordedAt);
  const info = processInfo(pid);
  if (!info || !names.includes(info.name) || !Number.isFinite(at) || !(info.created <= at + 2000)) return false;
  const command = info.commandLine.toLowerCase();
  return commandParts.every(part => command.includes(part.toLowerCase()));
}

// The tunnel status file is trusted only while it names this app's live cloudflared process for this port.
export function readTunnelState(file, port) {
  let state;
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  if (state?.version !== 2 || state.port !== port || !Number.isSafeInteger(state.pid)) return null;
  try { networkPolicy(port, state.url); } catch { return null; }
  if (new URL(state.url).hostname === "api.trycloudflare.com") return null;
  const owned = sameProcess(state.pid, state.createdAt, CLOUDFLARED, [path.join(path.dirname(path.resolve(file)), "quick-tunnel.yml"), `http://127.0.0.1:${port}`]);
  return owned ? { url: state.url, pid: state.pid, port, createdAt: state.createdAt } : null;
}
