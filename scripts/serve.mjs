import { createServer } from "node:http";
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import next from "next";
import env from "@next/env";
import { networkPolicy } from "../lib/network-policy.mjs";

env.loadEnvConfig(process.cwd());
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex < 0 ? process.env.PORT || 3210 : process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
process.env.PORT = String(port);
process.env.MODEL_CHAT_SERVER_INSTANCE = String(process.pid);
const policy = networkPolicy(port, process.env.MODEL_CHAT_TUNNEL_ORIGIN);
process.env.MODEL_CHAT_ORIGIN = policy.origin;
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
for (const name of ["public", ".next"]) {
  const webDirectory = path.resolve(name);
  if (data === webDirectory || data.startsWith(webDirectory + path.sep)) throw new Error("MODEL_CHAT_DATA_DIR must be outside public/ and .next/.");
}
mkdirSync(data, { recursive: true, mode: 0o700 });
const lock = path.join(data, "server.lock");
try {
  closeSync(openSync(lock, "wx", 0o600));
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const previous = Number(readFileSync(lock, "utf8"));
  if (!Number.isInteger(previous) || previous <= 0) throw new Error("Invalid .local/server.lock; verify no app is running before removing this file.");
  let running = true;
  try { process.kill(previous, 0); } catch (failure) { if (failure.code === "ESRCH") running = false; else throw failure; }
  if (running) throw new Error("Model Chat is already running with this data directory. Stop it before restarting.");
  unlinkSync(lock);
  closeSync(openSync(lock, "wx", 0o600));
}
writeFileSync(lock, String(process.pid));
process.once("exit", () => {
  try { if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock); }
  catch (error) { if (error.code !== "ENOENT") console.error("Could not release app lock:", error.message); }
});
const app = next({ dev: process.argv.includes("--dev"), hostname: "127.0.0.1", port });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer((req, res) => {
  const local = ["127.0.0.1", "::ffff:127.0.0.1", "::1"].includes(req.socket.remoteAddress);
  if (local && policy.tunnelMode && req.headers.host === new URL(policy.localOrigin).host) {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end('{"ok":true}');
    } else if (["GET", "HEAD"].includes(req.method) && req.url.startsWith("/")) {
      res.writeHead(307, { Location: policy.origin + req.url, "Cache-Control": "no-store" }).end();
    } else {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("Use the temporary HTTPS link while tunnel mode is enabled.");
    }
    return;
  }
  if (local && policy.tunnelMode && req.headers.host === new URL(policy.origin).host && req.headers["x-forwarded-proto"] !== "https") {
    if (["GET", "HEAD"].includes(req.method) && req.url.startsWith("/")) {
      res.writeHead(308, { Location: policy.origin + req.url, "Cache-Control": "no-store" }).end();
    } else {
      res.writeHead(403, { "Content-Type": "text/plain" }).end("HTTPS is required for remote access.");
    }
    return;
  }
  const pageNavigation = req.method === "GET" && req.url.split("?")[0] === "/" && req.headers["sec-fetch-mode"] === "navigate";
  if (!local || req.headers.host !== new URL(policy.origin).host ||
      (req.headers.origin && req.headers.origin !== process.env.MODEL_CHAT_ORIGIN) ||
      (req.headers["sec-fetch-site"] === "cross-site" && !pageNavigation)) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("Open Model Chat at " + process.env.MODEL_CHAT_ORIGIN);
    return;
  }
  req.headers["x-model-chat-ip"] = "127.0.0.1";
  if (policy.tunnelMode) res.setHeader("Strict-Transport-Security", "max-age=86400");
  handler(req, res);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.on("error", error => { console.error(error.message); process.exit(1); });
server.listen(port, "127.0.0.1", () => console.log(`Model Chat ready: ${process.env.MODEL_CHAT_ORIGIN}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close();
  app.close().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
  setTimeout(() => process.exit(0), 3000).unref();
});
