import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { chromium, expect } from "@playwright/test";
import env from "@next/env";
import { setTimeout as delay } from "node:timers/promises";

env.loadEnvConfig(process.cwd());
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const { url: origin } = JSON.parse(readFileSync(path.join(data, "tunnel.json"), "utf8"));
assert.match(origin, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
const browser = await chromium.launch({ channel: "msedge" });
const accounts: { id: string; email: string }[] = [];
const context = await browser.newContext({ baseURL: origin });
const other = await browser.newContext({ baseURL: origin });
const password = randomBytes(24).toString("base64url");
const email = `multi-public-${randomUUID()}@example.test`;
let chatId: string | undefined;
try {
  for (const [client, address] of [[context, email], [other, `multi-public-${randomUUID()}@example.test`]] as const) {
    const signup = await client.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email: address, password } });
    assert.equal(signup.status(), 200); accounts.push((await signup.json()).user);
  }
  const page = await context.newPage();
  await page.goto(origin);
  const models = (await (await context.request.get("/api/models")).json()).models as { id: string; maxImages?: number; vision?: boolean; multiplier?: number }[];
  const selected = models.filter(model => model.vision && model.maxImages === 1).sort((a, b) => (a.multiplier ?? 1) - (b.multiplier ?? 1))[0];
  assert.ok(selected, "A real vision model advertising one image per request is needed for this check.");
  await page.getByRole("combobox", { name: "Select model" }).selectOption(selected.id);
  const picture = async (color: string, label: string) => sharp({ create: { width: 400, height: 220, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="400" height="220"><text x="60" y="145" font-size="90" fill="white">${label}</text></svg>`) }]).png().toBuffer();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "first.png", mimeType: "image/png", buffer: await picture("red", "A7") },
    { name: "second.png", mimeType: "image/png", buffer: await picture("blue", "B9") },
    ...[["notes.txt", "Cedar"], ["notes.md", "Maple"], ["values.csv", "name,value\nfixture,42"], ["values.json", '{"checkpoint":"ORCHID"}']].map(([name, text]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) })),
  ]);
  await expect(page.locator(".transfer")).toHaveCount(0, { timeout: 60000 });
  await expect(page.locator(".file-job")).toHaveCount(6);
  for (const name of ["first.png", "second.png", "notes.txt", "notes.md", "values.csv", "values.json"]) {
    await expect(page.getByRole("button", { name: `Preview extracted text for ${name}`, exact: true })).toBeEnabled({ timeout: 45000 });
  }
  chatId = new URL(page.url()).searchParams.get("chat")!;
  const before = await (await context.request.get(`/api/chats/${chatId}`)).json();
  assert.equal(before.attachments.length, 6);
  assert.equal((await other.request.get(`/api/chats/${chatId}`)).status(), 404);
  await expect(page.locator(".file-guidance")).toContainText("1 additional Copilot request");
  await page.getByLabel("Message", { exact: true }).fill("Use all six attachments. List each image filename with its two-character label and background color. Then give the tree names from both text files, the CSV value, and the JSON checkpoint. Be concise.");
  const sent = page.waitForResponse(response => response.url().endsWith("/messages") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const response = await sent;
  assert.equal(response.status(), 200, response.status() === 200 ? undefined : await response.text());
  await expect(page.getByRole("button", { name: "Stop reply", exact: true })).toHaveCount(0, { timeout: 480000 });
  const after = await (await context.request.get(`/api/chats/${chatId}`)).json();
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[1].status, "complete", after.messages[1].error || "The real combined answer must complete.");
  for (const evidence of [/A7/, /B9/, /red/i, /blue/i, /Cedar/i, /Maple/i, /42/, /ORCHID/]) assert.match(after.messages[1].content, evidence);
  assert.ok(after.attachments.every((file: { messageId: string }) => file.messageId === after.messages[0].id));
  const db = new Database(path.join(data, "model-chat.db"), { readonly: true });
  try {
    const analyses = db.prepare("SELECT imageId,model,content FROM app_image_analysis WHERE fileId IN (SELECT id FROM app_file WHERE chatId=?)").all(chatId) as { imageId: string; model: string; content: string }[];
    assert.equal(analyses.length, 1);
    assert.equal(analyses[0].model, selected.id);
    const started = db.prepare("SELECT count(*) n FROM app_audit WHERE action='image.analysis' AND reason='request_started' AND subjectId=?").get(accounts[0].id) as { n: number };
    assert.equal(started.n, 1, "Only the overflow image should need an additional analysis request");
    const audit = JSON.stringify(db.prepare("SELECT * FROM app_audit WHERE subjectId=?").all(accounts[0].id));
    assert.equal(audit.includes("ORCHID"), false); assert.equal(audit.includes(analyses[0].content), false);
  } finally { db.close(); }
  await page.reload();
  await expect(page.locator(".message.assistant")).toContainText("B9");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "test-results/multi-file-public-answer.png", fullPage: true, animations: "disabled" });
  console.log(JSON.stringify({ publicUrl: origin, filesInOneTurn: 6, model: selected.id, additionalImageRequests: 1, finalReplyRequests: 1, persistedAnalyses: 1, mixedFileEvidenceVerified: true }));
} finally {
  for (const client of [context, other]) {
    if (chatId) await client.request.post(`/api/chats/${chatId}/stop`, { headers: { origin } }).catch(error => console.error("Test stop cleanup:", error.name));
    await client.request.post("/api/auth/sign-out", { headers: { origin }, data: {} }).catch(error => console.error("Test sign-out cleanup:", error.name));
  }
  await browser.close();
  const db = new Database(path.join(data, "model-chat.db"));
  try {
    db.pragma("foreign_keys=ON");
    const active = () => accounts.reduce((sum, account) => sum + (db.prepare("SELECT count(*) n FROM app_message m JOIN app_chat c ON c.id=m.chatId WHERE c.userId=? AND m.status='streaming'").get(account.id) as { n: number }).n, 0);
    for (let attempt = 0; attempt < 30 && active(); attempt++) await delay(500);
    assert.equal(active(), 0);
    db.transaction(() => { for (const account of accounts) db.prepare("DELETE FROM user WHERE id=? AND email=?").run(account.id, account.email); })();
    console.log(`Removed only ${accounts.length} exact synthetic public-test accounts and their data.`);
  } finally { db.close(); }
}
