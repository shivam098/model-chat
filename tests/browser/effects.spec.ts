import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../../lib/store";

// Measures what the lamp-light effect and the working message box cost on this computer, and records the hero effect.
// Opt-in, no model calls, Windows only (reads process CPU times):
//   $env:MODEL_CHAT_EFFECTS_PERF = '1'; $env:EFFECTS_OUT_DIR = '<folder>'; npx playwright test tests/browser/effects.spec.ts
test.skip(process.env.MODEL_CHAT_EFFECTS_PERF !== "1" || process.platform !== "win32", "Set MODEL_CHAT_EFFECTS_PERF=1 on Windows to measure the effects.");

const origin = "http://127.0.0.1:3211";
const out = process.env.EFFECTS_OUT_DIR || path.resolve("test-results", "effects");
const seconds = Number(process.env.EFFECTS_SECONDS || 20);
const headed = process.env.EFFECTS_HEADED === "1";

/** CPU seconds (user + kernel) used so far by the Edge instance whose browser process was started with this profile folder, including all its child processes. */
function cpuSeconds(profile: string) {
  const script = `$all = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"; $root = $all | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1; ` +
    `if (-not $root) { 'none'; exit }; $ids = @($root.ProcessId); $all | Where-Object { $_.ParentProcessId -eq $root.ProcessId } | ForEach-Object { $ids += $_.ProcessId }; ` +
    `$t = 0; $all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $t += [double]$_.UserModeTime + [double]$_.KernelModeTime }; "$($ids.Count) $t"`;
  const [count, total] = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim().split(/\s+/);
  if (count === "none") throw new Error("The measured Edge instance wasn't found.");
  return { processes: Number(count), seconds: Number(total) / 1e7 };
}
async function measure(context: BrowserContext, profile: string, page: Page, label: string, { warmup = 2000, duration = seconds * 1000, during }: { warmup?: number; duration?: number; during?: (page: Page) => Promise<void> } = {}) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const task = async () => (await cdp.send("Performance.getMetrics")).metrics.find(metric => metric.name === "TaskDuration")!.value;
  await page.evaluate(() => {
    const state = window as unknown as { __long: number };
    state.__long = 0;
    try { new PerformanceObserver(list => { state.__long += list.getEntries().length; }).observe({ type: "longtask" }); } catch { /* Not supported. */ }
  });
  await page.waitForTimeout(warmup);
  const before = cpuSeconds(profile), mainBefore = await task(), started = Date.now();
  if (during) await during(page); else await page.waitForTimeout(duration);
  const after = cpuSeconds(profile), mainAfter = await task(), wall = (Date.now() - started) / 1000;
  const longTasks = await page.evaluate(() => (window as unknown as { __long: number }).__long);
  const fps = await page.evaluate(() => new Promise<number>(resolve => { let frames = 0; const start = performance.now(); const tick = () => { frames++; if (performance.now() - start < 2000) requestAnimationFrame(tick); else resolve(frames / ((performance.now() - start) / 1000)); }; requestAnimationFrame(tick); }));
  await cdp.detach();
  return { label, wallSeconds: Number(wall.toFixed(1)), browserCpuPercentOfOneCore: Number(((after.seconds - before.seconds) / wall * 100).toFixed(2)), rendererMainThreadBusyPercent: Number(((mainAfter - mainBefore) / wall * 100).toFixed(2)), longTasks, displayFps: Math.round(fps), processes: after.processes };
}
async function launch(reducedMotion: "reduce" | "no-preference") {
  const profile = mkdtempSync(path.join(os.tmpdir(), "model-chat-effects-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "msedge", headless: !headed, baseURL: origin, viewport: { width: 1440, height: 900 }, reducedMotion,
    // A headed window is placed off-screen and kept rendering, so the measurement uses the real GPU path without covering the desktop.
    args: headed ? ["--window-position=-2400,-2400", "--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows"] : [],
  });
  return { context, profile };
}
function seedStreamingChat(email: string) {
  const db = new Database(path.join(process.env.MODEL_CHAT_TEST_DATA_DIR!, "model-chat.db"));
  try {
    const store = new Store(db);
    const user = db.prepare("SELECT id FROM user WHERE email=?").get(email) as { id: string };
    const chat = store.createChat(user.id);
    const turn = store.beginTurn(user.id, chat.id, "Plan a relaxed day in Lisbon.", "claude-sonnet-5.5", []);
    store.saveReply(user.id, chat.id, turn.assistant.id, "## Morning\n\nWalk from Praça do Comércio up to the Sé cathedral.", "streaming");
    return chat.id;
  } finally { db.close(); }
}
const pointerPath = async (page: Page, duration: number) => {
  const start = Date.now();
  while (Date.now() - start < duration) {
    const t = (Date.now() - start) / 1000;
    await page.mouse.move(720 + Math.sin(t * 0.9) * 420, 380 + Math.sin(t * 1.7) * 200, { steps: 4 });
    await page.waitForTimeout(16);
  }
};

test("lamp light and working message box: CPU, smoothness and a short recording", async () => {
  test.setTimeout(15 * 60_000);
  mkdirSync(out, { recursive: true });
  const results: Record<string, unknown>[] = [];
  const email = `effects-${randomUUID().slice(0, 8)}@example.test`;
  let chatId = "";
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const { context, profile } = await launch(reducedMotion);
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator(".auth-page .lamp")).toHaveAttribute("data-mode", reducedMotion === "reduce" ? "static" : "live");
      if (reducedMotion === "no-preference") {
        const renderer = await page.evaluate(() => {
          const gl = document.createElement("canvas").getContext("webgl");
          const info = gl?.getExtension("WEBGL_debug_renderer_info");
          return { renderer: info ? String(gl!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown", tier: document.documentElement.dataset.render };
        });
        results.push({ label: "graphics", headed, ...renderer, cores: os.cpus().length, cpu: os.cpus()[0]?.model });
      }
      const effect = reducedMotion === "reduce" ? "still (reduced motion)" : "animated";
      const animated = reducedMotion === "no-preference";
      // Without a GPU the scene settles 8 s after load or the last pointer movement, so the first seconds and the settled state are reported apart.
      if (animated) results.push(await measure(context, profile, page, "sign-in, first 7 s after loading, animated", { warmup: 500, duration: 7000 }));
      results.push(await measure(context, profile, page, `sign-in, idle${animated ? " after the first 8 s" : ""}, ${effect}`, { warmup: 3000 }));
      if (animated) results.push(await measure(context, profile, page, "sign-in, pointer moving, animated", { during: p => pointerPath(p, seconds * 1000) }));
      if (!chatId) {
        expect((await context.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email, password: "Synthetic effects pass 3317" } })).status()).toBe(200);
      } else {
        expect((await context.request.post("/api/auth/sign-in/email", { headers: { origin }, data: { email, password: "Synthetic effects pass 3317" } })).status()).toBe(200);
      }
      await page.goto("/");
      await expect(page.locator(".main-panel.empty .lamp")).toBeVisible();
      if (animated) results.push(await measure(context, profile, page, "new chat, first 7 s after loading, animated", { warmup: 500, duration: 7000 }));
      results.push(await measure(context, profile, page, `new chat, idle${animated ? " after the first 8 s" : ""}, ${effect}`, { warmup: 3000 }));
      chatId ||= seedStreamingChat(email);
      await page.goto(`/?chat=${chatId}`);
      await expect(page.locator(".composer-frame.working")).toBeVisible();
      results.push(await measure(context, profile, page, `reply in progress (message box glow), ${effect}`));
      // A hidden tab stops the lamp. Headless tabs always report "visible", so the page is told it's hidden the way a browser does.
      if (reducedMotion === "no-preference") {
        await page.goto("/");
        await expect(page.locator(".main-panel.empty .lamp")).toBeVisible();
        await page.evaluate(() => {
          Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        results.push(await measure(context, profile, page, "new chat, tab hidden (visibilitychange)"));
      }
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(path.join(out, "measurements.json"), JSON.stringify(results, null, 2));

  // Frames of the hero effect (DevTools screencast, no extra downloads), with a drawn pointer so the light can be seen following it.
  // Turn them into a GIF or video with any ffmpeg, using frames/frames.txt (ffmpeg concat list with each frame's duration).
  const frames = path.join(out, "frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const { context, profile: recordingProfile } = await launch("no-preference");
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    // Record the pacing that computers with a GPU get (this PC renders in software, where the light moves less often).
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: { failIfMajorPerformanceCaveat?: boolean }) {
        if (type === "webgl" && options?.failIfMajorPerformanceCaveat) return { getExtension: () => null } as unknown as WebGLRenderingContext;
        return (original as (this: HTMLCanvasElement, type: string, options?: unknown) => RenderingContext | null).call(this, type, options);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    await page.addInitScript(() => {
      addEventListener("DOMContentLoaded", () => {
        const cursor = document.createElement("div");
        cursor.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>';
        Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", zIndex: "9999", pointerEvents: "none", transform: "translate(-100px,-100px)" });
        document.body.appendChild(cursor);
        addEventListener("pointermove", event => { cursor.style.transform = `translate(${event.clientX - 3}px,${event.clientY - 2}px)`; }, { passive: true });
      });
    });
    await page.goto("/");
    await expect(page.locator(".auth-page .lamp")).toHaveAttribute("data-mode", "live");
    await page.waitForTimeout(1200);
    const cdp = await context.newCDPSession(page);
    const shots: { file: string; time: number }[] = [];
    cdp.on("Page.screencastFrame", frame => {
      const file = `frame-${String(shots.length).padStart(4, "0")}.jpg`;
      writeFileSync(path.join(frames, file), Buffer.from(frame.data, "base64"));
      shots.push({ file, time: frame.metadata.timestamp ?? Date.now() / 1000 });
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    await page.mouse.move(360, 260, { steps: 20 });
    const start = Date.now();
    while (Date.now() - start < 6500) {
      const t = (Date.now() - start) / 1000;
      await page.mouse.move(640 + Math.cos(t * 1.1) * 430, 360 + Math.sin(t * 1.6) * 210, { steps: 3 });
      await page.waitForTimeout(16);
    }
    await page.mouse.move(1279, 799, { steps: 20 });
    await page.waitForTimeout(3000);
    await cdp.send("Page.stopScreencast");
    const list = shots.map((shot, index) => `file '${shot.file}'\nduration ${Math.max(0.01, ((shots[index + 1]?.time ?? shot.time + 0.04) - shot.time)).toFixed(3)}`);
    writeFileSync(path.join(frames, "frames.txt"), list.join("\n") + `\nfile '${shots.at(-1)?.file}'\n`);
    console.log(JSON.stringify({ frames: shots.length, seconds: shots.length ? Number((shots.at(-1)!.time - shots[0].time).toFixed(1)) : 0 }));
  } finally { await context.close(); rmSync(recordingProfile, { recursive: true, force: true }); }
});
