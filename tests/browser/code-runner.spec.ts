import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";
import { UploadStore } from "../../lib/upload-store";
import { detectOutput } from "../../lib/code-tool";
import { runSandbox } from "../../lib/sandbox";

const origin = "http://127.0.0.1:3211";
test.skip(!existsSync(path.resolve(".local", "sandbox-config.json")), "The WSL code runner is not configured on this machine.");

test("generated outputs render safe previews, download safely and stay private on desktop and mobile", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const directory = process.env.MODEL_CHAT_TEST_DATA_DIR!;
  expect(path.basename(directory)).toMatch(/^browser-test-/);
  copyFileSync(path.resolve(".local", "sandbox-config.json"), path.join(directory, "sandbox-config.json"));
  const generated = await runSandbox(`
import numpy as np, matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter, FFMpegWriter
from reportlab.pdfgen import canvas
fig, ax = plt.subplots(figsize=(5, 3)); ax.bar(['A', 'B', 'C'], [3, 7, 5]); fig.savefig('/work/output/chart.png'); plt.close(fig)
fig, ax = plt.subplots(figsize=(4, 3)); x = np.linspace(0, 6.3, 60); line, = ax.plot(x, np.sin(x))
animation = FuncAnimation(fig, lambda frame: line.set_ydata(np.sin(x + frame / 4)), frames=12)
animation.save('/work/output/wave.gif', writer=PillowWriter(fps=8))
animation.save('/work/output/wave.mp4', writer=FFMpegWriter(fps=8, codec='libx264', extra_args=['-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '2']))
pdf = canvas.Canvas('/work/output/report.pdf'); pdf.drawString(72, 760, 'Synthetic report'); pdf.save()
open('/work/output/page.html', 'w').write('<script>document.title="xss"</script>')
open('/work/output/drawing.svg', 'w').write('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
`, [], { signal: new AbortController().signal });
  expect(generated.status, generated.stderr).toBe("ok");
  const email = `runner-${randomUUID()}@example.test`;
  const signupWithWindow = async (request: typeof page.request, data: { email: string; password: string }) => {
    let response = await request.post(origin + "/api/auth/sign-up/email", { headers: { origin }, data });
    if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 61_000)); response = await request.post(origin + "/api/auth/sign-up/email", { headers: { origin }, data }); }
    return response;
  };
  const signup = await signupWithWindow(page.request, { email, password: "Synthetic runner test pass! 4821" });
  expect(signup.status()).toBe(200);
  const owner = (await signup.json()).user;
  const db = new Database(path.join(directory, "model-chat.db"));
  let chatId = "";
  const ids: Record<string, string> = {};
  try {
    const store = new Store(db);
    const access = new AccessService(store);
    const session = db.prepare("SELECT id FROM session WHERE userId=?").get(owner.id) as { id: string };
    const own = access.resolve(owner.id, session.id);
    const chat = store.createChat(owner.id);
    chatId = chat.id;
    const turn = store.beginTurn(owner.id, chat.id, "Make synthetic outputs", "fixture", []);
    const uploads = new UploadStore(store);
    for (const output of generated.files) {
      const detected = detectOutput(output.name, output.bytes);
      if ("blocked" in detected) throw new Error("Unexpected blocked fixture");
      ids[output.name] = uploads.storeGenerated(own, chat.id, turn.assistant.id, { name: output.name, extension: detected.extension, bytes: output.bytes, mimeType: detected.mimeType, text: "[Generated]", notes: "Generated" }).id;
    }
    store.saveReply(owner.id, chat.id, turn.assistant.id, "Here are the synthetic outputs.", "complete");
  } finally { db.close(); }
  await page.goto(`/?chat=${chatId}`);
  await expect(page.locator(".message.assistant")).toContainText("synthetic outputs");
  await expect(page.locator("img.generated-preview")).toHaveCount(2);
  await expect(page.locator("video.generated-preview")).toHaveCount(1);
  await expect.poll(() => page.locator("img.generated-preview").evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await expect.poll(() => page.locator("video.generated-preview").evaluate(video => (video as HTMLVideoElement).readyState >= 1 && (video as HTMLVideoElement).duration > 0)).toBe(true);
  await expect(page.getByRole("link", { name: "Open PDF preview of report.pdf" })).toBeVisible();
  await page.screenshot({ path: "test-results/code-runner-previews-desktop.png", fullPage: true, animations: "disabled" });
  const preview = (name: string, headers = {}) => page.request.get(`/api/chats/${chatId}/files/${ids[name]}/preview`, { headers });
  const pdf = await preview("report.pdf");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toMatch(/^inline;/);
  expect(pdf.headers()["x-content-type-options"]).toBe("nosniff");
  const png = await preview("chart.png");
  expect(png.headers()["content-security-policy"]).toContain("sandbox");
  expect(png.headers()["content-security-policy"]).toContain("default-src 'none'");
  const [pdfTab] = await Promise.all([page.waitForEvent("popup"), page.getByRole("link", { name: "Open PDF preview of report.pdf" }).click()]);
  await pdfTab.waitForLoadState();
  await pdfTab.waitForTimeout(2000);
  await pdfTab.screenshot({ path: "test-results/code-runner-pdf-preview.png" });
  expect(pdfTab.url()).toContain("/preview");
  await pdfTab.close();
  const range = await preview("wave.mp4", { range: "bytes=0-99" });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(100);
  expect(range.headers()["content-range"]).toMatch(/^bytes 0-99\//);
  for (const name of ["page.html", "drawing.svg"]) {
    expect((await preview(name)).status()).toBe(415);
    const download = await page.request.get(`/api/chats/${chatId}/files/${ids[name]}`);
    expect(download.headers()["content-type"]).toBe("application/octet-stream");
    expect(download.headers()["content-disposition"]).toMatch(/^attachment;/);
    expect(download.headers()["x-content-type-options"]).toBe("nosniff");
  }
  await page.getByRole("button", { name: "Files & privacy" }).click();
  await expect(page.getByRole("dialog")).toContainText("no internet or network access");
  await expect(page.getByRole("dialog")).toContainText("python-pptx");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/code-runner-previews-mobile.png", fullPage: true, animations: "disabled" });
  const other = await browser.newContext();
  try {
    const stranger = await signupWithWindow(other.request, { email: `runner-${randomUUID()}@example.test`, password: "Another runner test pass! 9134" });
    expect(stranger.status()).toBe(200);
    for (const name of Object.keys(ids)) {
      expect((await other.request.get(origin + `/api/chats/${chatId}/files/${ids[name]}/preview`)).status()).toBe(404);
      expect((await other.request.get(origin + `/api/chats/${chatId}/files/${ids[name]}`)).status()).toBe(404);
    }
    expect((await other.request.get(origin + `/api/chats/${chatId}`)).status()).toBe(404);
  } finally { await other.close(); }
});
