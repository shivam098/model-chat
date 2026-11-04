// Owner commands for the temporary Cloudflare Quick Tunnel.
// cloudflared and the app server run as separate detached processes, so rebuilding and restarting the
// app keeps the same public URL. A new tunnel (and URL) is created only when none is running.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import env from "@next/env";
import Database from "better-sqlite3";
import { runtimeEnvironment } from "../lib/runtime-env.mjs";
import { CLOUDFLARED, NODE, isCloudflared, isNode, processImage, readTunnelState, sameProcess } from "../lib/process-tools.mjs";

env.loadEnvConfig(process.cwd());
const command = process.argv[2] || "start";
const force = process.argv.includes("--force");
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex < 0 ? process.env.PORT || 3210 : process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
mkdirSync(data, { recursive: true, mode: 0o700 });
const files = {
  tunnel: path.join(data, "tunnel.json"), app: path.join(data, "app-state.json"), stop: path.join(data, "app-stop.json"),
  lock: path.join(data, "server.lock"), config: path.join(data, "quick-tunnel.yml"),
  tunnelLog: path.join(data, "cloudflared.log"), appLog: path.join(data, "app.log"),
};
const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const tail = (file, size = 1500) => { try { return readFileSync(file, "utf8").slice(-size); } catch { return ""; } };

function lockOwner() {
  try {
    const pid = Number(readFileSync(files.lock, "utf8"));
    return { pid, live: sameProcess(pid, statSync(files.lock).mtimeMs, NODE, ["serve.mjs"]) };
  } catch { return null; }
}
// Only a tunnel-mode server started by these commands is managed; any other live server on this data directory is foreign.
function appState() {
  const state = readJson(files.app);
  const lock = lockOwner();
  if (state && state.pid === lock?.pid && state.port === port && sameProcess(state.pid, state.startedAt, NODE, ["serve.mjs"])) return state.tunnel ? state : { ...state, foreign: true };
  if (lock?.live) return { pid: lock.pid, port, origin: null, tunnel: false, foreign: true };
  return null;
}
async function waitForIdle() {
  const database = path.join(data, "model-chat.db");
  if (force || !existsSync(database)) return;
  const deadline = Date.now() + 10 * 60_000;
  for (let announced = false; ; announced = true) {
    const db = new Database(database, { readonly: true, fileMustExist: true });
    let streaming = 0;
    try { streaming = db.prepare("SELECT count(*) n FROM app_message WHERE status='streaming'").get().n; } finally { db.close(); }
    if (!streaming) return;
    if (Date.now() > deadline) throw new Error("Replies are still streaming. Try again later, or add --force to interrupt them (partial text is kept).");
    if (!announced) console.log(`Waiting for ${streaming} streaming repl${streaming === 1 ? "y" : "ies"} to finish before restarting the app...`);
    await delay(3000);
  }
}
async function stopApp(state) {
  if (!state) return;
  writeFileSync(files.stop, JSON.stringify({ pid: state.pid, startedAt: state.startedAt, requestedAt: new Date().toISOString() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 45 && isNode(state.pid); attempt++) await delay(1000);
    if (isNode(state.pid) && sameProcess(state.pid, state.startedAt, NODE, ["serve.mjs"])) {
      console.warn("The app did not stop gracefully; ending it. Interrupted work is recovered on the next start.");
      process.kill(state.pid);
      await delay(1000);
    }
  } finally { try { unlinkSync(files.stop); } catch { /* Already removed. */ } }
}
function tunnelUrl(log) {
  // Read the URL from cloudflared's success banner, never from error text such as the api.trycloudflare.com endpoint.
  const banner = log.indexOf("quick Tunnel has been created");
  if (banner < 0) return null;
  return log.slice(banner).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;
}
async function startTunnel() {
  writeFileSync(files.config, "# App-owned Quick Tunnel config; no account credentials or named tunnel.\nno-autoupdate: true\n", { mode: 0o600 });
  const log = openSync(files.tunnelLog, "w", 0o600);
  const child = spawn("cloudflared", ["tunnel", "--config", files.config, "--no-autoupdate", "--url", `http://127.0.0.1:${port}`, "--loglevel", "info"], {
    detached: true, stdio: ["ignore", log, log], windowsHide: true, env: runtimeEnvironment(),
  });
  closeSync(log);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  const ending = () => { if (CLOUDFLARED.includes(processImage(child.pid))) process.kill(child.pid); };
  for (let attempt = 0; attempt < 60; attempt++) {
    const url = tunnelUrl(readFileSync(files.tunnelLog, "utf8"));
    if (url) {
      writeFileSync(files.tunnel, JSON.stringify({ version: 2, url, pid: child.pid, port, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      const tunnel = readTunnelState(files.tunnel, port);
      if (tunnel) return tunnel;
      try { unlinkSync(files.tunnel); } catch { /* Already removed. */ }
      break;
    }
    if (!isCloudflared(child.pid)) break;
    await delay(1000);
  }
  ending();
  throw new Error(`Cloudflare did not issue a working Quick Tunnel. Recent cloudflared output:\n${tail(files.tunnelLog)}`);
}
async function startApp() {
  if (!existsSync(path.resolve(".next", "BUILD_ID"))) throw new Error("Run npm run build before starting the app.");
  try { unlinkSync(files.stop); } catch { /* No leftover stop request. */ }
  const lock = lockOwner();
  if (lock?.live) throw new Error("Another app server still holds this data directory.");
  if (lock) unlinkSync(files.lock); // Left by a server that ended without cleanup (for example a reboot); its PID may now belong to another process.
  try { if (statSync(files.appLog).size > 10 * 1024 * 1024) renameSync(files.appLog, `${files.appLog}.1`); } catch { /* No previous log. */ }
  const log = openSync(files.appLog, "a", 0o600);
  const child = spawn(process.execPath, [path.resolve("scripts", "serve.mjs"), "--port", String(port), "--tunnel"], {
    detached: true, stdio: ["ignore", log, log], windowsHide: true, cwd: process.cwd(), env: process.env,
  });
  closeSync(log);
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    if (readJson(files.app)?.pid === child.pid) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })).ok) return child.pid; } catch { /* Still starting. */ }
    }
    if (!isNode(child.pid)) break;
    await delay(1000);
  }
  throw new Error(`The app server did not start. Recent app output:\n${tail(files.appLog)}`);
}
async function verifyPublic(url) {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(`${url}/api/access`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const access = await response.json();
        if (access.tunnelMode === true && access.registrationAllowed === true) return;
        throw new Error("The public app did not confirm tunnel mode.");
      }
      last = `HTTP ${response.status}`;
    } catch (error) { last = error.message; }
    await delay(1000);
  }
  throw new Error(`The public link did not respond: ${last}`);
}

if (command === "status") {
  const tunnel = readTunnelState(files.tunnel, port);
  const app = appState();
  let publicStatus = "unavailable";
  if (tunnel) {
    try { publicStatus = (await fetch(`${tunnel.url}/api/health`, { signal: AbortSignal.timeout(8000) })).status === 200 ? "ok" : "error"; }
    catch (error) { publicStatus = `error: ${error.message}`; }
  }
  console.log(JSON.stringify({
    url: tunnel?.url ?? null, tunnel: tunnel ? { pid: tunnel.pid, since: tunnel.createdAt } : null,
    app: app ? { pid: app.pid, origin: app.origin, behindTunnel: Boolean(tunnel && app.origin === tunnel.url) } : null, public: publicStatus,
  }, null, 2));
} else if (command === "start") {
  let tunnel = readTunnelState(files.tunnel, port);
  if (tunnel) console.log(`Reusing the running tunnel: ${tunnel.url}`);
  else {
    const existing = appState();
    if (existing?.foreign) throw new Error("A local-only app server is running on this data directory. Stop it (Ctrl+C) first.");
    console.log("No tunnel is running. Creating a temporary Cloudflare link with public email/password signup. All users share the host owner's Copilot quota.");
    tunnel = await startTunnel();
  }
  const app = appState();
  if (app?.origin === tunnel.url) console.log(`The app is already running behind it (pid ${app.pid}).`);
  else {
    if (app?.foreign) throw new Error("A local-only app server is running on this data directory. Stop it (Ctrl+C) first.");
    if (app) { await waitForIdle(); await stopApp(app); }
    console.log(`App started (pid ${await startApp()}).`);
  }
  await verifyPublic(tunnel.url);
  console.log(`\nYour Model Chat link: ${tunnel.url}\nThe link stays the same when you update the app with npm run app:update (or npm run app:restart). It changes only if the tunnel process stops, for example after a PC restart.\n`);
} else if (command === "restart-app") {
  const tunnel = readTunnelState(files.tunnel, port);
  if (!tunnel) throw new Error("No tunnel is running. Run npm run tunnel to start one.");
  const app = appState();
  if (app?.foreign) throw new Error("A local-only app server is running on this data directory. Stop it (Ctrl+C) first.");
  if (app) { await waitForIdle(); await stopApp(app); }
  if (process.argv.includes("--build")) {
    // Build only while the app is stopped: next build replaces .next, which a running server reads from.
    console.log("Building the app; the link stays the same but the site is unavailable until the build finishes...");
    const buildEnv = { ...process.env };
    delete buildEnv.MODEL_CHAT_CANDIDATE_BUILD;
    const build = spawnSync("npm run build", { shell: true, stdio: "inherit", env: buildEnv });
    if (build.status !== 0) throw new Error(`The build failed, so the app is stopped. The tunnel and link (${tunnel.url}) are unchanged; fix the error and run npm run app:update again.`);
  }
  console.log(`App restarted (pid ${await startApp()}).`);
  await verifyPublic(tunnel.url);
  if (readTunnelState(files.tunnel, port)?.url !== tunnel.url) throw new Error("The tunnel changed unexpectedly during the restart.");
  console.log(`Link unchanged: ${tunnel.url}`);
} else if (command === "stop") {
  const app = appState();
  if (app?.foreign) throw new Error("A local-only app server is running on this data directory; stop it with Ctrl+C. The tunnel was left unchanged.");
  if (app) { await waitForIdle(); await stopApp(app); }
  const tunnel = readTunnelState(files.tunnel, port);
  if (tunnel) process.kill(tunnel.pid);
  try { unlinkSync(files.tunnel); } catch { /* Already removed. */ }
  console.log(tunnel ? `Stopped the app and the tunnel (${tunnel.url} is no longer valid).` : "Stopped the app; no tunnel was running.");
} else {
  throw new Error("Usage: node scripts/tunnel.mjs [start|restart-app [--build]|status|stop] [--force] [--port N]");
}
