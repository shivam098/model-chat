import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import env from "@next/env";
import { runtimeEnvironment } from "../lib/runtime-env.mjs";
import { networkPolicy } from "../lib/network-policy.mjs";

env.loadEnvConfig(process.cwd());
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex < 0 ? process.env.PORT || 3210 : process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
if (!existsSync(path.resolve(".next", "BUILD_ID"))) throw new Error("Run npm run build before starting the tunnel.");
mkdirSync(data, { recursive: true, mode: 0o700 });
const serverLock = path.join(data, "server.lock");
if (existsSync(serverLock)) {
  const pid = Number(readFileSync(serverLock, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid server.lock; verify no app is running before removing it.");
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
  if (alive) throw new Error("Stop the current app server first. npm run tunnel starts both the app and tunnel.");
}
const configPath = path.join(data, "quick-tunnel.yml");
const statusPath = path.join(data, "tunnel.json");
writeFileSync(configPath, "# App-owned Quick Tunnel config; no account credentials or named tunnel.\nno-autoupdate: true\n", { mode: 0o600 });
let tunnel;
let app;
let shuttingDown = false;
function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  app?.kill();
  tunnel?.kill();
  if (existsSync(statusPath)) {
    try {
      if (JSON.parse(readFileSync(statusPath, "utf8")).pid === process.pid) unlinkSync(statusPath);
    } catch (error) { console.error("Could not remove tunnel status:", error.message); }
  }
}
process.once("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop(); process.exit(0); });

try {
  console.log("Creating a temporary Cloudflare link with public email/password signup. All users share the host owner's Copilot quota.");
  tunnel = spawn("cloudflared", [
    "tunnel", "--config", configPath, "--no-autoupdate",
    "--url", `http://127.0.0.1:${port}`, "--loglevel", "info",
  ], { env: runtimeEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error("Cloudflare did not issue a Quick Tunnel URL within 60 seconds.")); }, 60_000);
    const inspect = chunk => {
      const text = chunk.toString();
      process.stdout.write(text);
      output = (output + text).slice(-12_000);
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve(match[0]); }
    };
    tunnel.stdout.on("data", inspect);
    tunnel.stderr.on("data", inspect);
    tunnel.once("error", error => { settled = true; clearTimeout(timer); reject(error); });
    tunnel.once("exit", code => {
      clearTimeout(timer);
      if (!settled) reject(new Error(`Cloudflare exited before creating a link (${code}).`));
      else if (!shuttingDown) { console.error("Cloudflare tunnel stopped."); stop(); process.exitCode = 1; }
    });
  });
  networkPolicy(port, url);
  app = spawn(process.execPath, ["scripts/serve.mjs", "--port", String(port)], {
    env: { ...process.env, MODEL_CHAT_TUNNEL_ORIGIN: url },
    stdio: "inherit",
    windowsHide: true,
  });
  app.once("error", error => { console.error(error.message); stop(); process.exitCode = 1; });
  app.once("exit", code => {
    if (!shuttingDown) { console.error(`App server stopped (${code}).`); stop(); process.exitCode = code || 1; }
  });
  let ready = false;
  let lastError = "";
  for (let attempt = 0; attempt < 90 && !shuttingDown; attempt++) {
    try {
      const response = await fetch(url + "/api/access", { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const access = await response.json();
        if (access.tunnelMode === true && access.registrationAllowed === true) { ready = true; break; }
        throw new Error("The remote server did not confirm the requested public-signup policy.");
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message; }
    await delay(1000);
  }
  if (!ready) throw new Error("The temporary link did not become ready: " + lastError);
  writeFileSync(statusPath, JSON.stringify({ url, pid: process.pid, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`\nYour Model Chat link: ${url}\nSign in or create an email/password account. No OTP. All users share the host owner's Copilot quota.\nKeep this process running; Ctrl+C stops both the link and app. This URL is temporary.\n`);
} catch (error) {
  console.error("Tunnel startup failed:", error.message);
  stop();
  process.exitCode = 1;
}
