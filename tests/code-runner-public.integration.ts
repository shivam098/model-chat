import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import env from "@next/env";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";

env.loadEnvConfig(process.cwd());
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const { url: origin } = JSON.parse(readFileSync(path.join(data, "tunnel.json"), "utf8")) as { url: string };
assert.match(origin, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
const password = randomBytes(24).toString("base64url");
const accounts: { id: string; email: string }[] = [];
const browser = await chromium.launch({ channel: "msedge" });
const contexts: BrowserContext[] = [];
const csv = "month,sales\nJan,120\nFeb,135\nMar,160\nApr,150\nMay,190\n";

async function account(label: string) {
  const context = await browser.newContext({ baseURL: origin });
  contexts.push(context);
  const email = `runner-${label}-${randomUUID()}@example.test`;
  let response = await context.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email, password } });
  if (response.status() === 429) {
    await delay(61_000); // Keep the real public signup rate limit; wait for its window instead.
    response = await context.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email, password } });
  }
  assert.equal(response.status(), 200, `signup ${label}`);
  accounts.push((await response.json()).user);
  return { context, user: accounts.at(-1)!, page: await context.newPage() };
}
async function sendAndWait(page: Page, prompt: string) {
  await page.getByLabel("Message", { exact: true }).fill(prompt);
  const sent = page.waitForResponse(response => response.url().endsWith("/messages") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const response = await sent;
  assert.equal(response.status(), 200, response.status() === 200 ? undefined : await response.text());
  await expect(page.getByRole("button", { name: "Stop reply", exact: true })).toHaveCount(0, { timeout: 900_000 });
}
const magic: Record<string, (bytes: Buffer) => boolean> = {
  pdf: bytes => bytes.subarray(0, 5).toString() === "%PDF-",
  png: bytes => bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
  gif: bytes => bytes.subarray(0, 3).toString() === "GIF",
  mp4: bytes => bytes.subarray(4, 8).toString() === "ftyp",
};
try {
  const alice = await account("owner");
  const bob = await account("other");
  const admin = await account("admin");
  const db = new Database(path.join(data, "model-chat.db"));
  try { new AccessService(new Store(db)).setRoleLocally(admin.user.email, "superuser"); } finally { db.close(); }
  const status = await (await alice.context.request.get("/api/sandbox-status")).json();
  assert.equal(status.ready, true, "The live app must offer the code runner");
  const models = (await (await alice.context.request.get("/api/models")).json()).models as { id: string; multiplier?: number }[];
  const model = models.find(item => /^claude-sonnet/.test(item.id)) || models[0];
  const page = alice.page;
  await page.goto(origin);
  await page.getByRole("combobox", { name: "Select model" }).selectOption(model.id);
  await page.locator('input[type="file"]').setInputFiles({ name: "sales.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByRole("button", { name: "Preview extracted text for sales.csv", exact: true })).toBeEnabled({ timeout: 60_000 });
  const chatId = new URL(page.url()).searchParams.get("chat")!;
  const actingOnly = process.env.MODEL_CHAT_RUNNER_PART === "acting";
  let detail = await (await alice.context.request.get(`/api/chats/${chatId}`)).json();
  let generated: { id: string; name: string; preview: string | null; messageRole: string }[] = [];
  if (!actingOnly) {
  await sendAndWait(page, "Using sales.csv, use run_python to create exactly these files: report.pdf (one-page report with a title, the total sales and the chart), chart.png (bar chart of sales by month), growth.gif (short animated line chart), growth.mp4 (the same animation as MP4), summary.docx (short summary), data.xlsx (the data plus a total row), deck.pptx (one slide with the chart). Then reply with one short sentence.");
  detail = await (await alice.context.request.get(`/api/chats/${chatId}`)).json();
  const reply = detail.messages.at(-1);
  assert.equal(reply.status, "complete", reply.error || "The real tool-using reply must complete.");
  generated = detail.attachments.filter((file: { messageId: string }) => file.messageId === reply.id);
  const wanted = ["report.pdf", "chart.png", "growth.gif", "growth.mp4", "summary.docx", "data.xlsx", "deck.pptx"];
  for (const name of wanted) assert.ok(generated.some(file => file.name === name), `Missing generated ${name}; got ${generated.map(file => file.name).join(", ")}`);
  for (const file of generated.filter(item => wanted.includes(item.name))) {
    const download = await alice.context.request.get(`/api/chats/${chatId}/files/${file.id}`);
    assert.equal(download.status(), 200);
    assert.match(download.headers()["content-disposition"], /^attachment;/);
    assert.equal(download.headers()["x-content-type-options"], "nosniff");
    const bytes = await download.body();
    const extension = file.name.split(".").pop()!;
    if (magic[extension]) assert.ok(magic[extension](bytes), `${file.name} has the expected signature`);
    else {
      const zip = await JSZip.loadAsync(bytes);
      assert.ok(zip.file({ docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" }[extension]!), `${file.name} is a real Office file`);
    }
    for (const stranger of [bob.context, admin.context]) assert.equal((await stranger.request.get(`/api/chats/${chatId}/files/${file.id}/preview`)).status(), 404);
  }
  await page.reload();
  await expect.poll(() => page.locator("img.generated-preview").evaluateAll(images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator("video.generated-preview").first().evaluate(video => (video as HTMLVideoElement).readyState >= 1), { timeout: 30_000 }).toBe(true);
  await expect(page.getByRole("link", { name: "Open PDF preview of report.pdf" })).toBeVisible();
  await page.screenshot({ path: "test-results/code-runner-live-desktop.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "test-results/code-runner-live-mobile.png", fullPage: true, animations: "disabled" });
  }
  assert.equal((await bob.context.request.get(`/api/chats/${chatId}`)).status(), 404);

  const acting = await admin.context.request.post("/api/admin/acting", { headers: { origin }, data: { userId: alice.user.id, chatId } });
  assert.equal(acting.status(), 200);
  await admin.page.goto(`${origin}/?chat=${chatId}`);
  await expect(admin.page.locator(".acting-banner")).toContainText(alice.user.email);
  await expect(admin.page.locator(".file-chip").filter({ hasText: "sales.csv" }).first()).toBeVisible({ timeout: 30_000 });
  assert.equal(new URL(admin.page.url()).searchParams.get("chat"), chatId, "The acting browser must have the owner's chat open before sending");
  await admin.page.getByRole("combobox", { name: "Select model" }).selectOption(model.id);
  await sendAndWait(admin.page, "Use run_python with sales.csv to make a pie chart named pie.png, then reply in one short sentence.");
  const after = await (await alice.context.request.get(`/api/chats/${chatId}`)).json();
  const adminReply = after.messages.at(-1);
  assert.equal(adminReply.status, "complete", adminReply.error || "The superuser-acting tool turn must complete.");
  const pie = after.attachments.find((file: { name: string; messageId: string }) => file.name === "pie.png" && file.messageId === adminReply.id);
  if (!pie) console.error("Diagnostics (synthetic data only):", JSON.stringify({ reply: adminReply.content, files: after.attachments.map((file: { name: string; messageId: string }) => [file.name, file.messageId === adminReply.id]) }));
  assert.ok(pie, "The acting superuser's generated file belongs to the owner's chat");
  if (!actingOnly) assert.equal(after.messages.slice(0, 2).map((item: { id: string }) => item.id).join(), detail.messages.slice(0, 2).map((item: { id: string }) => item.id).join());
  assert.equal((await bob.context.request.get(`/api/chats/${chatId}/files/${pie.id}/preview`)).status(), 404);
  const audit = new Database(path.join(data, "model-chat.db"), { readonly: true });
  try {
    const runs = audit.prepare("SELECT actorId,subjectId,outcome,reason FROM app_audit WHERE action='code.run' AND subjectId=?").all(alice.user.id) as { actorId: string; subjectId: string; outcome: string; reason: string }[];
    if (!actingOnly) assert.ok(runs.some(row => row.actorId === alice.user.id && row.reason === "started"));
    assert.ok(runs.some(row => row.actorId === admin.user.id && row.reason === "started"));
    const outputs = audit.prepare("SELECT actorId,objectId FROM app_audit WHERE action='code.output' AND subjectId=?").all(alice.user.id) as { actorId: string; objectId: string }[];
    assert.ok(outputs.some(row => row.actorId === admin.user.id && row.objectId === pie.id));
    assert.ok(generated.every(file => outputs.some(row => row.objectId === file.id)));
    const serialized = JSON.stringify(audit.prepare("SELECT * FROM app_audit WHERE subjectId=?").all(alice.user.id));
    assert.equal(/Jan,120|run_python with|import /.test(serialized), false, "No code, prompt or file content is audited");
  } finally { audit.close(); }
  console.log(JSON.stringify({ url: origin, model: model.id, realCopilotTurns: 2, generated: generated.map(file => file.name), superuserOutput: pie.name }));
} finally {
  for (const context of contexts) await context.request.post("/api/auth/sign-out", { headers: { origin }, data: {} }).catch(() => undefined);
  await browser.close();
  const db = new Database(path.join(data, "model-chat.db"));
  try {
    db.pragma("foreign_keys = ON");
    const active = () => accounts.reduce((sum, account) => sum + (db.prepare("SELECT count(*) n FROM app_message m JOIN app_chat c ON c.id=m.chatId WHERE c.userId=? AND m.status='streaming'").get(account.id) as { n: number }).n, 0);
    for (let attempt = 0; attempt < 60 && active(); attempt++) await delay(1000);
    db.transaction(() => { for (const account of accounts) db.prepare("DELETE FROM user WHERE id=? AND email=?").run(account.id, account.email); })();
    console.log(`Removed only ${accounts.length} exact synthetic code-runner test accounts and their data.`);
  } finally { db.close(); }
}
