import http from "node:http";
import net from "node:net";

// Live previews of apps built in coding mode. Each preview has its own origin, http://p-<token>.localhost:<app port>,
// so a generated app never shares Model Chat's origin or cookies. Only this computer's loopback connections are served.
const PREVIEW_HOST = /^p-([a-f0-9]{48})\.localhost:(\d+)$/;
const DROP = ["cookie", "authorization", "proxy-authorization", "x-model-chat-via", "x-model-chat-ip", "x-model-chat-subject",
  "cf-connecting-ip", "cf-ray", "cf-visitor", "cdn-loop", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"];

export function previewFor(hostHeader, appPort) {
  const match = PREVIEW_HOST.exec(String(hostHeader || "").toLowerCase());
  if (!match || Number(match[2]) !== appPort) return null;
  const entry = globalThis.modelChatPreviews?.get(match[1]);
  if (!entry || entry.expires < Date.now()) return null;
  return entry;
}
function upstreamHeaders(headers, entry) {
  const next = { ...headers };
  for (const name of DROP) delete next[name];
  next.host = `localhost:${entry.port}`;
  if (next.origin) next.origin = `http://localhost:${entry.port}`;
  if (next.referer) next.referer = `http://localhost:${entry.port}/`;
  return next;
}
export function proxyPreview(req, res, entry) {
  const upstream = http.request({ host: entry.host, port: entry.port, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, entry) }, response => {
    const headers = { ...response.headers };
    delete headers["strict-transport-security"];
    if (typeof headers.location === "string") headers.location = headers.location.replace(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/i, "");
    res.writeHead(response.statusCode || 502, headers);
    response.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`Nothing is answering on port ${entry.port}. Start the app's dev server again, then reload the preview.`);
  });
  req.pipe(upstream);
}
export function proxyPreviewUpgrade(req, socket, head, entry) {
  const target = net.connect(entry.port, entry.host, () => {
    const headers = upstreamHeaders(req.headers, entry);
    const lines = Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`));
    target.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on("error", () => socket.destroy());
  socket.on("error", () => target.destroy());
}
