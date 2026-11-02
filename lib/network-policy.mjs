export function networkPolicy(port, tunnelOrigin) {
  const localOrigin = `http://127.0.0.1:${port}`;
  if (!tunnelOrigin) return { origin: localOrigin, localOrigin, tunnelMode: false };
  const url = new URL(tunnelOrigin);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) ||
      url.port || url.username || url.password || url.origin !== tunnelOrigin) {
    throw new Error("Tunnel origin must be the exact HTTPS trycloudflare.com origin printed by cloudflared.");
  }
  return { origin: url.origin, localOrigin, tunnelMode: true };
}
