"use strict";
// Reads the published link (fresh on every visit), checks that Model Chat answers, then forwards.
(() => {
  const TUNNEL_LINK = /^https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com$/;
  const RETRY_MS = 15000;
  const MAX_CHECKS = 40;
  const element = id => document.getElementById(id);
  let checks = 0;
  let timer = 0;

  function show(state, message, url, fallbackText) {
    document.body.dataset.state = state;
    element("message").textContent = message;
    element("fallback").hidden = !url;
    if (url) {
      element("link").href = `${url}/`;
      element("fallback-text").textContent = fallbackText;
    }
    element("actions").hidden = state === "loading" || state === "forwarding";
  }
  function later(state, message, url) {
    show(state, message, url, "You can also try the last published link:");
    if (checks < MAX_CHECKS) timer = setTimeout(check, RETRY_MS);
  }
  async function reachable(url) {
    try {
      const response = await fetch(`${url}/api/link-status?t=${Date.now()}`, {
        mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000),
      });
      return response.ok && (await response.json()).ok === true;
    } catch { return false; }
  }
  async function check() {
    clearTimeout(timer);
    checks++;
    let info = null;
    try {
      const response = await fetch(`link.json?t=${Date.now()}`, { cache: "no-store" });
      if (response.ok) info = await response.json();
    } catch { /* Handled below. */ }
    if (!info) return later("unavailable", "Couldn't load the current link. Checking again shortly…");
    const url = info.online === true && typeof info.url === "string" && TUNNEL_LINK.test(info.url) ? info.url : null;
    if (!url) return later("offline", "Model Chat is offline right now. This page checks again automatically.");
    if (!(await reachable(url))) return later("unreachable", "Model Chat isn't reachable right now. It may be restarting; this page checks again automatically.", url);
    show("forwarding", "Opening Model Chat…", url, "If nothing happens,");
    location.replace(`${url}/`);
  }
  element("retry").addEventListener("click", () => {
    checks = 0;
    show("loading", "Checking…");
    check();
  });
  check();
})();
