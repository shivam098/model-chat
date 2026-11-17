// Owner commands for the temporary Cloudflare Quick Tunnel.
// cloudflared and the app server run as separate background processes, so rebuilding and restarting the
// app keeps the same public URL. A new tunnel (and URL) is created only when none is running. Both are started
// outside the caller's job object, and the optional auto-restart task (ensure) repairs them if they stop.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import env from "@next/env";
import Database from "better-sqlite3";
import { CLOUDFLARED, NODE, isCloudflared, isNode, launchDetached, processImage, quotePath, readTunnelState, sameProcess } from "../lib/process-tools.mjs";
import { publishStableLink, readStableLink, stableLinkConfig } from "../lib/stable-link.mjs";
import { repairPlan } from "../lib/watchdog.mjs";

env.loadEnvConfig(process.cwd());
const command = process.argv[2] || "start";
const force = process.argv.includes("--force");
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const port = Number(option("--port") ?? (process.env.PORT || 3210));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
mkdirSync(data, { recursive: true, mode: 0o700 });
const files = {
  tunnel: path.join(data, "tunnel.json"), app: path.join(data, "app-state.json"), stop: path.join(data, "app-stop.json"),
  lock: path.join(data, "server.lock"), config: path.join(data, "quick-tunnel.yml"),
  tunnelLog: path.join(data, "cloudflared.log"), appLog: path.join(data, "app.log"),
  manager: path.join(data, "manager.lock"), wanted: path.join(data, "link-wanted.json"),
  watchdog: path.join(data, "watchdog-state.json"), watchdogLog: path.join(data, "watchdog.log"),
};
const TASK = "Model Chat auto-restart";
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const tail = (file, size = 1500) => { try { return readFileSync(file, "utf8").slice(-size); } catch { return ""; } };
const setWanted = wanted => writeFileSync(files.wanted, JSON.stringify({ wanted, changedAt: new Date().toISOString() }), { mode: 0o600 });

// Owner commands and the auto-restart task never run at the same time.
async function acquireManagerLock(wait) {
  const deadline = Date.now() + (wait ? 10 * 60_000 : 0);
  for (let announced = false; ;) {
    try {
      writeFileSync(files.manager, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      process.once("exit", () => { try { if (readJson(files.manager)?.pid === process.pid) unlinkSync(files.manager); } catch { /* Already removed. */ } });
      return true;
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    const holder = readJson(files.manager);
    let age;
    try { age = Date.now() - statSync(files.manager).mtimeMs; } catch { continue; }
    const held = holder ? sameProcess(holder.pid, holder.startedAt, NODE, ["tunnel.mjs"]) : age < 10_000;
    if (!held) { try { unlinkSync(files.manager); } catch { /* Removed by another command. */ } continue; }
    if (Date.now() >= deadline) return false;
    if (!announced) { console.log(`Waiting for another Model Chat command (${holder?.command ?? "starting"}) to finish...`); announced = true; }
    await delay(3000);
  }
}

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
function cloudflaredPath() {
  if (process.platform !== "win32") return "cloudflared";
  const found = (spawnSync("where.exe", ["cloudflared"], { encoding: "utf8", windowsHide: true }).stdout || "").split(/\r?\n/).map(line => line.trim()).find(line => /\.exe$/i.test(line));
  if (!found) throw new Error("cloudflared is not installed or not on PATH. Install the official Cloudflare cloudflared CLI.");
  return found;
}
async function startTunnel() {
  writeFileSync(files.config, "# App-owned Quick Tunnel config; no account credentials or named tunnel.\nno-autoupdate: true\n", { mode: 0o600 });
  try { if (statSync(files.tunnelLog).size > 5 * 1024 * 1024) renameSync(files.tunnelLog, `${files.tunnelLog}.1`); } catch { /* No previous log. */ }
  let offset = 0;
  try { offset = statSync(files.tunnelLog).size; } catch { /* New log. */ }
  const pid = launchDetached([quotePath(cloudflaredPath()), "tunnel", "--config", quotePath(files.config), "--no-autoupdate",
    "--url", `http://127.0.0.1:${port}`, "--loglevel", "info", "--logfile", quotePath(files.tunnelLog)].join(" "), process.cwd());
  const recent = () => { try { return readFileSync(files.tunnelLog, "utf8").slice(offset); } catch { return ""; } };
  for (let attempt = 0; attempt < 60; attempt++) {
    const url = tunnelUrl(recent());
    if (url) {
      writeFileSync(files.tunnel, JSON.stringify({ version: 2, url, pid, port, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      const tunnel = readTunnelState(files.tunnel, port);
      if (tunnel) return tunnel;
      try { unlinkSync(files.tunnel); } catch { /* Already removed. */ }
      break;
    }
    if (!isCloudflared(pid)) break;
    await delay(1000);
  }
  if (CLOUDFLARED.includes(processImage(pid))) process.kill(pid);
  throw new Error(`Cloudflare did not issue a working Quick Tunnel. Recent cloudflared output:\n${recent().slice(-1500)}`);
}
function stopTunnel(tunnel) {
  if (tunnel) process.kill(tunnel.pid); // readTunnelState verified it is this app's cloudflared process.
  try { unlinkSync(files.tunnel); } catch { /* Already removed. */ }
}
async function startApp() {
  if (!existsSync(path.resolve(".next", "BUILD_ID"))) throw new Error("Run npm run build before starting the app.");
  try { unlinkSync(files.stop); } catch { /* No leftover stop request. */ }
  const lock = lockOwner();
  if (lock?.live) throw new Error("Another app server still holds this data directory.");
  if (lock) unlinkSync(files.lock); // Left by a server that ended without cleanup (for example a reboot); its PID may now belong to another process.
  try { if (statSync(files.appLog).size > 10 * 1024 * 1024) renameSync(files.appLog, `${files.appLog}.1`); } catch { /* No previous log. */ }
  quotePath(data);
  const serve = [quotePath(process.execPath), quotePath(path.resolve("scripts", "serve.mjs")), "--port", String(port), "--tunnel"].join(" ");
  // The shell wrapper only appends the server's output to the log; the server itself records its PID in app-state.json.
  const launcher = process.platform === "win32"
    ? `cmd.exe /d /s /c "set "MODEL_CHAT_DATA_DIR=${data}"&& ${serve} >> ${quotePath(files.appLog)} 2>&1"`
    : `MODEL_CHAT_DATA_DIR=${quotePath(data)} ${serve} >> ${quotePath(files.appLog)} 2>&1`;
  const requested = Date.now();
  const launcherPid = launchDetached(launcher, process.cwd());
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = readJson(files.app);
    if (state?.port === port && Date.parse(state.startedAt) >= requested - 2000) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })).ok) return state.pid; } catch { /* Still starting. */ }
    } else if (attempt % 5 === 4 && !processImage(launcherPid)) break;
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
// Keeps the shareable GitHub Pages link pointing at the current tunnel (or "offline"). A failure here never
// stops the app or tunnel; the owner can retry with npm run link:publish.
async function syncStableLink(url, { required = false } = {}) {
  let config;
  try { config = stableLinkConfig(); } catch (error) { if (required) throw error; console.warn(`Warning: ${error.message}`); return; }
  if (!config) {
    if (required) throw new Error("No shareable link is configured. Set MODEL_CHAT_PAGES_REPO in .env.local (see README).");
    return;
  }
  try {
    const result = await publishStableLink(url);
    const target = url ?? "an offline notice";
    console.log(result.changed ? `Shareable link updated: ${config.address} now opens ${target}. GitHub Pages applies it in about 30 seconds.` : `Shareable link already up to date: ${config.address} opens ${target}.`);
  } catch (error) {
    if (required) throw error;
    console.warn(`Warning: could not update the shareable link ${config.address}: ${error.message}\nThis does not affect the app or tunnel. Retry with: npm run link:publish`);
  }
}
async function stableLinkStatus(tunnel) {
  let config;
  try { config = stableLinkConfig(); } catch (error) { return { error: error.message }; }
  if (!config) return null;
  try {
    const published = await readStableLink(config);
    return { address: config.address, opens: published.online ? published.url : "offline notice", pointsToCurrent: published.online ? published.url === tunnel?.url : !tunnel };
  } catch (error) { return { address: config.address, opens: `unavailable (${error.message})`, pointsToCurrent: false }; }
}
async function answers(url, attempts, gap) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" })).ok) return true; } catch { /* Not answering. */ }
    if (attempt < attempts - 1) await delay(gap);
  }
  return false;
}
const internetReachable = async () => (await answers("https://www.cloudflare.com/cdn-cgi/trace", 2, 5000)) || answers("https://api.github.com/", 1, 0);
function scheduledTask(script, extra = {}) {
  if (process.platform !== "win32") throw new Error("Auto-restart uses Windows Task Scheduler and is available on Windows only.");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, MC_TASK: TASK, ...extra },
  });
  if (result.status !== 0) throw new Error(`Task Scheduler: ${(result.stderr || result.stdout || "failed").trim().split(/\r?\n/)[0]}`);
  return result.stdout.trim();
}
function autoRestartStatus() {
  const wanted = readJson(files.wanted)?.wanted === true;
  let task = null;
  try {
    const found = scheduledTask("$t = Get-ScheduledTask -TaskName $env:MC_TASK -ErrorAction SilentlyContinue; if ($t) { $i = $t | Get-ScheduledTaskInfo; "
      + "[pscustomobject]@{ state = \"$($t.State)\"; lastRun = $(if ($i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') }); lastResult = $i.LastTaskResult; nextRun = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') }) } | ConvertTo-Json -Compress }; exit 0");
    task = found ? JSON.parse(found) : null;
  } catch (error) { task = { error: error.message }; }
  const lastEvent = tail(files.watchdogLog, 4000).trim().split(/\r?\n/).at(-1) || null;
  return { installed: Boolean(task && !task.error), on: wanted, task, lastEvent };
}

// The auto-restart check (run by the scheduled task): repair whatever stopped, quietly when nothing did.
async function ensure() {
  for (const level of ["log", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...parts) => {
      original(...parts);
      try {
        if (statSync(files.watchdogLog).size > 1024 * 1024) renameSync(files.watchdogLog, `${files.watchdogLog}.1`);
      } catch { /* No log yet. */ }
      appendFileSync(files.watchdogLog, `${new Date().toISOString()} ${parts.join(" ")}\n`, { mode: 0o600 });
    };
  }
  const memory = readJson(files.watchdog) ?? {};
  const save = () => writeFileSync(files.watchdog, JSON.stringify(memory, null, 2), { mode: 0o600 });
  // Repeated states are logged once, so the log only shows changes.
  const note = (key, message) => { if (memory.last !== key) console.log(message); memory.last = key; };
  try {
    const wanted = readJson(files.wanted)?.wanted === true;
    if (!wanted) return note("stopped", "Auto-restart is idle: the link was turned off with npm run tunnel:stop. npm run tunnel turns it back on.");
    if (!(await acquireManagerLock(false))) return; // An owner command (for example app:update) is working; check next time.
    let tunnel = readTunnelState(files.tunnel, port);
    const app = appState();
    const appAlive = Boolean(app && !app.foreign);
    const localOk = appAlive && await answers(`http://127.0.0.1:${port}/api/health`, 3, 5000);
    const appMatchesTunnel = Boolean(appAlive && tunnel && app.origin === tunnel.url);
    const measurePublic = Boolean(tunnel && appMatchesTunnel && localOk);
    const publicOk = measurePublic && await answers(`${tunnel.url}/api/health`, 4, 15_000);
    const internetOk = measurePublic && !publicOk ? await internetReachable() : true;
    const plan = repairPlan({ wanted, foreign: Boolean(app?.foreign), tunnelAlive: Boolean(tunnel), appAlive, appMatchesTunnel, localOk, publicOk, internetOk, previousPublicFailures: memory.publicFailures ?? 0 });
    memory.publicFailures = plan.publicFailures ?? 0;
    if (plan.skip === "foreign") return note("foreign", "A local-only app server (npm start) is using this data directory; auto-restart leaves it alone.");
    if (plan.skip === "waiting") return note(`waiting-${plan.publicFailures}`, `The link ${tunnel.url} isn't answering from the internet; checking again before replacing it.`);
    if (measurePublic && !publicOk && !internetOk) return note("offline-pc", "This PC can't reach the internet; leaving the tunnel to reconnect by itself.");
    if (plan.replaceTunnel) { console.log(`The link ${tunnel.url} stopped answering; replacing the tunnel.`); stopTunnel(tunnel); tunnel = null; }
    if (plan.startTunnel) {
      if (!plan.replaceTunnel) console.log("The Cloudflare tunnel had stopped; starting a new one.");
      tunnel = await startTunnel();
      console.log(`New link: ${tunnel.url}`);
    }
    if (plan.restartApp) {
      if (appAlive) {
        console.log(localOk ? "Moving the app to the new link." : "The app isn't answering; restarting it.");
        await stopApp(app);
      } else console.log("The app had stopped; starting it.");
      console.log(`App started (pid ${await startApp()}).`);
    }
    if (plan.startTunnel || plan.restartApp) await verifyPublic(tunnel.url);
    // Keep the shareable link in step, which also retries a publish that failed earlier.
    let config = null;
    try { config = stableLinkConfig(); } catch { /* Reported by syncStableLink. */ }
    let current = !config;
    if (config) { try { const published = await readStableLink(config); current = published.online === true && published.url === tunnel.url; } catch { /* Republish. */ } }
    if (!current) await syncStableLink(tunnel.url);
    if (plan.startTunnel || plan.restartApp) { console.log(`Recovered: ${tunnel.url}`); memory.last = "repaired"; }
    else note("ok", `Everything is running: ${tunnel.url}`);
  } catch (error) {
    note(`error:${error.message}`, `Auto-restart could not repair the link: ${error.message}`);
    process.exitCode = 1;
  } finally { save(); }
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
    stableLink: await stableLinkStatus(tunnel),
    autoRestart: autoRestartStatus(),
  }, null, 2));
} else if (command === "ensure") {
  await ensure();
} else if (command === "autorestart-on") {
  const minutes = Number(option("--minutes") ?? 5);
  if (!Number.isInteger(minutes) || minutes < 2 || minutes > 60) throw new Error("--minutes must be a whole number from 2 to 60.");
  scheduledTask(`$ErrorActionPreference = 'Stop'
$argument = '//B //Nologo "{0}" "{1}" "{2}" {3}' -f $env:MC_VBS, $env:MC_NODE, $env:MC_ROOT, $env:MC_PORT
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\\System32\\wscript.exe" -Argument $argument -WorkingDirectory $env:MC_ROOT
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ([int]$env:MC_MINUTES))
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $env:MC_TASK -Action $action -Trigger @($repeat, $logon) -Settings $settings -Principal $principal -Description 'Restarts the Model Chat app and its Cloudflare link if they stop, and keeps the shareable link current. Turn off with: npm run autorestart:off' -Force | Out-Null`,
  { MC_VBS: quotePath(path.resolve("scripts", "run-hidden.vbs")).slice(1, -1), MC_NODE: quotePath(process.execPath).slice(1, -1), MC_ROOT: quotePath(process.cwd()).slice(1, -1), MC_PORT: String(port), MC_MINUTES: String(minutes) });
  console.log(`Auto-restart is on: "${TASK}" checks at sign-in and every ${minutes} minutes while you're signed in, without opening a window.`);
  console.log(readJson(files.wanted)?.wanted ? "It will restart the app and tunnel whenever they stop." : "It starts working after the next npm run tunnel (the link is currently turned off).");
} else if (command === "autorestart-off") {
  scheduledTask("Unregister-ScheduledTask -TaskName $env:MC_TASK -Confirm:$false -ErrorAction SilentlyContinue; exit 0");
  console.log("Auto-restart is off. The app and tunnel keep running; they are no longer restarted if they stop.");
} else if (!(await acquireManagerLock(true))) {
  throw new Error("Another Model Chat command is still running. Try again shortly.");
} else if (command === "start") {
  let tunnel = readTunnelState(files.tunnel, port);
  if (tunnel) console.log(`Reusing the running tunnel: ${tunnel.url}`);
  else {
    const existing = appState();
    if (existing?.foreign) throw new Error("A local-only app server is running on this data directory. Stop it (Ctrl+C) first.");
    setWanted(true);
    console.log("No tunnel is running. Creating a temporary Cloudflare link with public email/password signup. All users share the host owner's Copilot quota.");
    tunnel = await startTunnel();
  }
  setWanted(true);
  const app = appState();
  if (app?.origin === tunnel.url) console.log(`The app is already running behind it (pid ${app.pid}).`);
  else {
    if (app?.foreign) throw new Error("A local-only app server is running on this data directory. Stop it (Ctrl+C) first.");
    if (app) { await waitForIdle(); await stopApp(app); }
    console.log(`App started (pid ${await startApp()}).`);
  }
  await verifyPublic(tunnel.url);
  await syncStableLink(tunnel.url);
  const stable = (() => { try { return stableLinkConfig()?.address; } catch { return null; } })();
  const autoRestart = process.platform === "win32" && autoRestartStatus().installed;
  console.log(`\nYour Model Chat link: ${tunnel.url}${stable ? `\nShareable link (always opens the current one): ${stable}` : ""}\nThe link stays the same when you update the app with npm run app:update (or npm run app:restart). It changes only if the tunnel process stops, for example after a PC restart.`);
  console.log(autoRestart ? "Auto-restart is on: if the app or tunnel stops, they are restarted within a few minutes.\n" : "Tip: npm run autorestart:on restarts them automatically if they stop.\n");
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
  setWanted(false); // Turn auto-restart off first, so it doesn't bring the link back.
  const app = appState();
  if (app?.foreign) throw new Error("A local-only app server is running on this data directory; stop it with Ctrl+C. The tunnel was left unchanged.");
  if (app) { await waitForIdle(); await stopApp(app); }
  const tunnel = readTunnelState(files.tunnel, port);
  stopTunnel(tunnel);
  console.log(tunnel ? `Stopped the app and the tunnel (${tunnel.url} is no longer valid).` : "Stopped the app; no tunnel was running.");
  await syncStableLink(null);
} else if (command === "publish-link") {
  // Publishes the live tunnel, or "offline" when none is running.
  const tunnel = readTunnelState(files.tunnel, port);
  await syncStableLink(tunnel?.url ?? null, { required: true });
} else {
  throw new Error("Usage: node scripts/tunnel.mjs [start|restart-app [--build]|status|stop|publish-link|ensure|autorestart-on [--minutes N]|autorestart-off] [--force] [--port N]");
}
