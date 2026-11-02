import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import env from "@next/env";
import { setTimeout as delay } from "node:timers/promises";

env.loadEnvConfig(process.cwd());
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const { url: origin } = JSON.parse(readFileSync(path.join(data, "tunnel.json"), "utf8")) as { url: string };
assert.match(origin, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
const password = randomBytes(24).toString("base64url");
const accounts: { id: string; email: string }[] = [];
const contexts: BrowserContext[] = [];
const browser = await chromium.launch({ channel: "msedge" });
const pageErrors: string[] = [];

async function register(email: string) {
  const context = await browser.newContext({ baseURL: origin });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(origin);
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(page.locator(".auth-card input")).toHaveCount(2);
  await expect(page.getByText(/No OTP or verification email/)).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/auth/sign-up/email") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, "Public signup must succeed, without OTP.");
  const body = await response.json() as { user: { id: string; email: string } };
  assert.equal(body.user.email, email);
  accounts.push(body.user);
  await expect(page.getByRole("heading", { name: "What's on your mind?" })).toBeVisible();
  const cookie = (await context.cookies()).find(item => item.name.includes("session_token"));
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Strict");
  return page;
}
async function demoMenu(page: Page) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "How Model Chat works & Demos", exact: true }).click();
}

try {
  const access = await (await fetch(origin + "/api/access")).json();
  assert.equal(access.registrationAllowed, true);
  assert.equal(access.tunnelMode, true);
  assert.equal((await fetch(origin + "/api/chats")).status, 401);
  assert.equal((await fetch(origin + "/api/demos", { method: "POST", headers: { origin, "content-type": "application/json" }, body: '{"demoId":"budget"}' })).status, 401);

  const first = await register(`modelchat-public-${randomUUID()}@gmail.com`);
  let modelRequests = 0;
  first.on("request", request => { if (request.method() === "POST" && /\/messages$/.test(new URL(request.url()).pathname)) modelRequests++; });
  const oldResponse = await first.request.post("/api/chats", { headers: { origin } });
  const old = (await oldResponse.json()).chat as { id: string };
  await first.goto(`${origin}/?chat=${old.id}`);
  await expect(first.locator(".chat-item.selected .chat-select")).toContainText("New chat");
  await expect(first.getByLabel("Message", { exact: true })).toBeEnabled();
  await first.getByLabel("Message", { exact: true }).fill("Keep my original public-test draft.");
  await demoMenu(first);
  await first.screenshot({ path: "test-results/public-demos-desktop.png", fullPage: true, animations: "disabled" });
  await first.getByRole("button", { name: "Load Explore a sample budget", exact: true }).click();
  await expect(first.getByLabel("Message", { exact: true })).toHaveValue(/Using sample-budget.csv/);
  const sampleId = new URL(first.url()).searchParams.get("chat")!;
  assert.notEqual(sampleId, old.id);
  const original = await (await first.request.get(`/api/chats/${old.id}`)).json();
  assert.equal(original.chat.draft, "Keep my original public-test draft.");
  const sample = await (await first.request.get(`/api/chats/${sampleId}`)).json();
  assert.equal(sample.messages.length, 0);
  assert.equal(sample.attachments[0].name, "sample-budget.csv");
  assert.equal(modelRequests, 0, "Loading a demo must not generate an answer.");
  await first.reload();
  await expect(first.getByLabel("Message", { exact: true })).toHaveValue(/Using sample-budget.csv/);
  await expect(first.getByRole("button", { name: "Send message", exact: true })).toBeEnabled({ timeout: 45_000 });
  await first.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(first.locator(".message.assistant").last()).toContainText("620", { timeout: 120_000 });
  await expect(first.locator(".message.assistant").last()).toContainText("645", { timeout: 120_000 });
  await expect(first.getByRole("button", { name: "Stop reply", exact: true })).toHaveCount(0, { timeout: 120_000 });
  assert.equal(modelRequests, 1, "Exactly one explicit Send should make one model request.");
  await first.screenshot({ path: "test-results/public-budget-answer.png", fullPage: true, animations: "disabled" });

  const second = await register(`modelchat-public-${randomUUID()}@example.test`);
  assert.equal((await second.request.get(`/api/chats/${sampleId}`)).status(), 404);
  assert.equal((await second.request.get(`/api/chats/${sampleId}/files/${sample.attachments[0].id}`)).status(), 404);
  assert.equal((await second.request.post("/api/demos", { headers: { origin }, data: { demoId: "writing", previous: { chatId: old.id, draft: "overwrite" } } })).status(), 404);
  await second.setViewportSize({ width: 390, height: 844 });
  await demoMenu(second);
  await second.screenshot({ path: "test-results/public-demos-mobile.png", fullPage: true, animations: "disabled" });
  await second.getByRole("button", { name: "Load Draft a friendly update", exact: true }).click();
  await expect(second.getByLabel("Message", { exact: true })).toHaveValue(/Write a friendly project-update email/);
  const secondChat = new URL(second.url()).searchParams.get("chat")!;
  assert.notEqual(secondChat, sampleId);
  assert.equal((await first.request.get(`/api/chats/${secondChat}`)).status(), 404);
  assert.equal(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  for (const body of [{ email: "invalid", password }, { email: "test@example.test", password: "short" }]) {
    assert.equal((await second.request.post("/api/auth/sign-up/email", { headers: { origin }, data: body })).status(), 400);
  }
  await second.request.post("/api/auth/sign-out", { headers: { origin }, data: {} });
  assert.equal((await second.request.get(`/api/chats/${secondChat}`)).status(), 401);
  await second.goto(origin);
  await second.getByLabel("Email", { exact: true }).fill(accounts[1].email);
  await second.getByLabel("Password", { exact: true }).fill("wrong-password");
  await second.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(second.locator(".auth-error")).toBeVisible();
  await second.getByLabel("Password", { exact: true }).fill(password);
  await second.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(second.getByRole("heading", { name: "What's on your mind?" })).toBeVisible();
  assert.equal((await second.request.get(`/api/chats/${secondChat}`)).status(), 200);
  assert.deepEqual(pageErrors, []);
  console.log("Public HTTPS signup (including Gmail), no-OTP session, login/logout, validation errors, two-account isolation, desktop/mobile demos and one real file-grounded reply passed.");
} finally {
  for (const context of contexts) {
    try { await context.request.post("/api/auth/sign-out", { headers: { origin }, data: {} }); }
    catch (error) { console.error("Test sign-out failed:", error instanceof Error ? error.name : "Unknown"); }
  }
  await browser.close();
  const db = new Database(path.join(data, "model-chat.db"));
  try {
    db.pragma("foreign_keys = ON");
    const pending = db.prepare("SELECT count(*) AS count FROM app_message m JOIN app_chat c ON c.id=m.chatId WHERE c.userId=? AND m.status='streaming'");
    const remaining = () => accounts.reduce((sum, account) => sum + (pending.get(account.id) as { count: number }).count, 0);
    for (let attempt = 0; attempt < 30 && remaining(); attempt++) await delay(500);
    assert.equal(remaining(), 0, "Wait for test replies to stop before deleting their accounts.");
    const remove = db.prepare("DELETE FROM user WHERE id=? AND email=?");
    db.transaction(() => { for (const account of accounts) remove.run(account.id, account.email); })();
    console.log(`Removed ${accounts.length} synthetic public-test accounts and their data.`);
  } finally { db.close(); }
}
