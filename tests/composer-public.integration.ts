import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium, expect, type BrowserContext } from "@playwright/test";
import env from "@next/env";
import { setTimeout as delay } from "node:timers/promises";

// Opt-in live check of the running HTTPS link: exactly two real Copilot replies (one stopped mid-stream).
env.loadEnvConfig(process.cwd());
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const { url: origin } = JSON.parse(readFileSync(path.join(data, "tunnel.json"), "utf8")) as { url: string };
assert.match(origin, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
const password = randomBytes(24).toString("base64url");
const accounts: { id: string; email: string }[] = [];
const browser = await chromium.launch({ channel: "msedge" });
const contexts: BrowserContext[] = [];
const codeWord = `PELICAN-${randomBytes(3).toString("hex").toUpperCase()}`;

async function account(label: string) {
  const context = await browser.newContext({ baseURL: origin });
  contexts.push(context);
  const email = `composer-${label}-${randomUUID()}@example.test`;
  let response = await context.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email, password } });
  if (response.status() === 429) {
    await delay(61_000); // Keep the real public signup rate limit; wait for its window instead.
    response = await context.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email, password } });
  }
  assert.equal(response.status(), 200, `signup ${label}`);
  accounts.push((await response.json()).user);
  return { context, page: await context.newPage() };
}
try {
  const alice = await account("owner");
  const bob = await account("other");
  const models = ((await (await alice.context.request.get("/api/models")).json()).models as { id: string; multiplier?: number }[])
    .sort((a, b) => (a.multiplier ?? 99) - (b.multiplier ?? 99));
  assert.ok(models.length >= 2, "Two models are needed to prove model choice mid-reply");
  const [first, second] = models;
  const page = alice.page;
  let posts = 0;
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/messages")) posts++; });
  await page.goto(origin);
  const picker = page.getByRole("combobox", { name: "Select model" });
  await picker.selectOption(first.id);
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Write a very long, detailed essay (at least 2000 words, many sections) on the history of bridge engineering from antiquity to today.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop reply", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("chat"), { timeout: 60_000 }).toBeTruthy();
  const chatId = new URL(page.url()).searchParams.get("chat")!;
  await expect.poll(async () => {
    const detail = await (await alice.context.request.get(`/api/chats/${chatId}`)).json();
    const reply = detail.messages.at(-1);
    return reply.status === "streaming" ? reply.content.length : -1;
  }, { timeout: 120_000, intervals: [500] }).toBeGreaterThan(20);

  // Mid-reply on mobile: type, press Enter, attach, choose a model, try dictation.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer).toBeEnabled();
  const draft = `What is the code word in notes.txt? Reply with only the code word.`;
  await composer.fill(draft);
  await composer.press("Enter");
  await expect(composer).toHaveValue(draft);
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(`Meeting notes.\nThe code word is ${codeWord}.\n`) });
  await expect(page.getByRole("button", { name: "Preview extracted text for notes.txt", exact: true })).toBeEnabled({ timeout: 60_000 });
  await picker.selectOption(second.id);
  const dictate = page.getByRole("button", { name: /Dictate/ });
  if (await dictate.isEnabled()) {
    await dictate.click();
    await expect(page.getByRole("dialog")).toContainText("A quick note about dictation");
    await page.getByRole("button", { name: "Keep typing" }).click();
  }
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
  await expect(page.locator(".composer-caption")).toContainText("Reply in progress");
  assert.equal(posts, 1, "Enter must not send while a reply streams");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "test-results/composer-live-mobile.png", fullPage: true, animations: "disabled" });

  await page.getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop reply", exact: true })).toHaveCount(0, { timeout: 60_000 });
  let detail = await (await alice.context.request.get(`/api/chats/${chatId}`)).json();
  const stopped = detail.messages.at(-1);
  assert.equal(stopped.status, "cancelled");
  assert.ok(stopped.content.length > 20, "Stop keeps the partial reply");
  const pending = detail.attachments.filter((file: { name: string }) => file.name === "notes.txt");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].messageId, null, "A file added mid-reply stays pending for the next message");
  await expect(composer).toHaveValue(draft);
  await expect(picker).toHaveValue(second.id);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop reply", exact: true })).toHaveCount(0, { timeout: 300_000 });
  await expect(composer).toHaveValue("");
  detail = await (await alice.context.request.get(`/api/chats/${chatId}`)).json();
  const [firstUser, firstReply, nextUser, nextReply] = detail.messages;
  assert.equal(detail.messages.length, 4);
  assert.equal(firstReply.id, stopped.id);
  assert.equal(nextUser.content, draft);
  assert.equal(nextReply.status, "complete", nextReply.error || "The queued message must get a reply");
  assert.equal(nextReply.model, second.id);
  assert.match(nextReply.content, new RegExp(codeWord, "i"), "The reply is grounded in the file attached mid-reply");
  const notes = detail.attachments.find((file: { name: string }) => file.name === "notes.txt");
  assert.equal(notes.messageId, nextUser.id, "The mid-reply file belongs to the new turn only");
  assert.equal(detail.attachments.some((file: { messageId: string }) => file.messageId === firstUser.id), false);
  assert.equal(detail.chat.draft, "");
  for (const url of [`/api/chats/${chatId}`, `/api/chats/${chatId}/files/${notes.id}`]) assert.equal((await bob.context.request.get(url)).status(), 404);
  await page.screenshot({ path: "test-results/composer-live-desktop.png", fullPage: true, animations: "disabled" });
  console.log(JSON.stringify({ url: origin, stoppedModel: first.id, nextModel: second.id, realCopilotReplies: 2, stoppedPartialChars: stopped.content.length }));
} finally {
  for (const context of contexts) await context.request.post("/api/auth/sign-out", { headers: { origin }, data: {} }).catch(() => undefined);
  await browser.close();
  const db = new Database(path.join(data, "model-chat.db"));
  try {
    db.pragma("foreign_keys = ON");
    const active = () => accounts.reduce((sum, account) => sum + (db.prepare("SELECT count(*) n FROM app_message m JOIN app_chat c ON c.id=m.chatId WHERE c.userId=? AND m.status='streaming'").get(account.id) as { n: number }).n, 0);
    for (let attempt = 0; attempt < 60 && active(); attempt++) await delay(1000);
    db.transaction(() => { for (const account of accounts) db.prepare("DELETE FROM user WHERE id=? AND email=?").run(account.id, account.email); })();
    console.log(`Removed only ${accounts.length} exact synthetic composer test accounts and their data.`);
  } finally { db.close(); }
}
