import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { networkPolicy } from "./network-policy.mjs";

export const NODE = ["node.exe", "node"];
export const CLOUDFLARED = ["cloudflared.exe", "cloudflared"];
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// Starts a long-lived background process with no window. On Windows it is created through WMI, so it runs
// outside any job object of the caller: closing or updating the terminal or agent app that ran the command
// (which kills everything in its job) cannot end it. Returns the new process ID.
export function launchDetached(commandLine, cwd) {
  if (process.platform !== "win32") {
    const child = spawn("/bin/sh", ["-c", commandLine], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    return child.pid;
  }
  const script = "$s = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; "
    + "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:MODEL_CHAT_LAUNCH; CurrentDirectory = $env:MODEL_CHAT_LAUNCH_CWD; ProcessStartupInformation = $s }; "
    + "[pscustomobject]@{ code = [int]$r.ReturnValue; pid = [int]$r.ProcessId } | ConvertTo-Json -Compress";
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, MODEL_CHAT_LAUNCH: commandLine, MODEL_CHAT_LAUNCH_CWD: cwd },
  });
  let launched;
  try { launched = JSON.parse(result.stdout.trim()); } catch { throw new Error(`Could not start a background process: ${(result.stderr || "no output").trim().slice(0, 300)}`); }
  if (launched.code !== 0 || !launched.pid) throw new Error(`Windows refused to start a background process (WMI result ${launched.code}).`);
  return launched.pid;
}
// Quotes a path for a command line (cmd.exe on Windows, /bin/sh elsewhere); rejects characters either shell would interpret.
export function quotePath(value) {
  if (/["%^&|<>!\r\n]/.test(value) || (process.platform !== "win32" && /[$`\\]/.test(value))) throw new Error(`Unsupported characters in path: ${value}`);
  return `"${value}"`;
}

// Linux exposes processes under /proc; macOS has no /proc, so ps answers instead.
const hasProc = process.platform !== "win32" && existsSync("/proc/self");
function ps(pid, field) {
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", `${field}=`], { encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}
// ps elapsed time: [[dd-]hh:]mm:ss
function elapsedMs(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

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
  if (!hasProc) return path.basename(ps(pid, "comm")).toLowerCase() || null;
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
    if (!hasProc) {
      const elapsed = elapsedMs(ps(pid, "etime"));
      const name = path.basename(ps(pid, "comm")).toLowerCase();
      if (elapsed === null || !name) return null;
      // etime has one-second resolution, so this is the earliest the process can have started.
      return { name, commandLine: ps(pid, "args"), created: Date.now() - elapsed - 999 };
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
