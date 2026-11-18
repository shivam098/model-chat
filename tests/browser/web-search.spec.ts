import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";

// Real Copilot replies with live web search, so it's opt-in (about four Copilot turns).
test.skip(process.env.MODEL_CHAT_WEB_E2E !== "1", "Set MODEL_CHAT_WEB_E2E=1 to run the real web search flow.");

const origin = "http://127.0.0.1:3211";
const password = "Test-only password! 48291";
const shots = process.env.WEB_SCREENS_DIR;
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}
async function signUp(page: Page, address: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start with a question or a file" })).toBeVisible();
}
async function ask(page: Page, text: string, onStage?: () => Promise<void>) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  if (onStage) await onStage();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 240_000 });
  return page.locator(".message.assistant").last();
}

test("web search: the owner's chats search and cite sources; ordinary users and acting get no web access", async ({ page, browser }) => {
  test.setTimeout(12 * 60_000);
  const data = process.env.MODEL_CHAT_TEST_DATA_DIR!;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const ownerEmail = `owner-${randomUUID()}@example.test`;
  await signUp(page, ownerEmail);
  const db = new Database(path.join(data, "model-chat.db"));
  try { new AccessService(new Store(db)).setRoleLocally(ownerEmail, "superuser"); } finally { db.close(); }
  await page.reload();
  expect((await (await page.request.get("/api/web-status")).json()).enabled).toBe(true);
  await expect(page.locator(".web-chip")).toBeVisible();
  const models = (await (await page.request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find(item => item.id === (process.env.MODEL_CHAT_WEB_MODEL || "gpt-6-luna"))?.id || models[0].id;
  await page.getByLabel("Select model").selectOption(model);

  let sawSearching = false;
  const first = await ask(page, "What is the latest stable release of Node.js, and when was it released? Please check the web and cite your sources.", async () => {
    const stage = page.getByText(/Searching the web/).first();
    try { await stage.waitFor({ timeout: 60_000 }); sawSearching = true; await shot(page, "01-searching-the-web"); } catch { /* The search can finish between polls. */ }
  });
  await expect(first.locator(".web-sources .source-chip").first()).toBeVisible();
  const links = await first.locator(".web-sources a").evaluateAll(anchors => anchors.map(anchor => ({ href: (anchor as HTMLAnchorElement).href, rel: anchor.getAttribute("rel"), target: anchor.getAttribute("target") })));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) { expect(link.href).toMatch(/^https?:\/\//); expect(link.rel).toContain("noopener"); expect(link.target).toBe("_blank"); }
  await first.scrollIntoViewIfNeeded();
  await shot(page, "02-reply-with-sources");

  const second = await ask(page, "And what is the current stable version of Python? Check the web and cite the source.");
  await expect(second.locator(".web-sources .source-chip").first()).toBeVisible();
  const third = await ask(page, "Summarize this page for me: https://nodejs.org/en/about/previous-releases");
  await expect(third.locator(".markdown")).not.toBeEmpty();
  await shot(page, "03-pasted-link");
  const thirdText = await third.locator(".markdown").innerText();

  const chatId = new URL(page.url()).searchParams.get("chat")!;
  await page.reload();
  await expect(page.locator(".message.assistant").first().locator(".web-sources .source-chip").first()).toBeVisible();
  const saved = (await (await page.request.get(`/api/chats/${chatId}`)).json()).messages.filter((message: { role: string }) => message.role === "assistant");
  expect(saved[0].sources.length).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".message.assistant").first().scrollIntoViewIfNeeded();
  await shot(page, "04-mobile-sources-after-reload");
  await page.setViewportSize({ width: 1440, height: 900 });

  // An ordinary account: no web tool, and the reply says it can't browse.
  const other = await browser.newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await signUp(other, `user-${randomUUID()}@example.test`);
  const status = await (await other.request.get("/api/web-status")).json();
  expect(status.enabled).toBe(false);
  await expect(other.locator(".web-chip")).toHaveCount(0);
  await other.getByLabel("Select model").selectOption(model);
  const plain = await ask(other, "What is the latest stable release of Node.js? Please search the web for it.");
  await expect(plain.locator(".web-sources")).toHaveCount(0);
  const plainText = await plain.locator(".markdown").innerText();
  await shot(other, "05-ordinary-user-no-web");
  const otherId = (await (await other.request.get("/api/account")).json()).user.id;
  await other.close();

  // Acting as that user: no web search either.
  expect((await page.request.post("/api/admin/acting", { headers: { origin }, data: { userId: otherId } })).status()).toBe(200);
  expect((await (await page.request.get("/api/web-status")).json()).enabled).toBe(false);
  await page.goto("/");
  await expect(page.getByText(/Acting as/).first()).toBeVisible();
  await expect(page.locator(".web-chip")).toHaveCount(0);
  expect((await page.request.post("/api/admin/stop", { headers: { origin }, data: {} })).status()).toBe(200);

  const audit = new Database(path.join(data, "model-chat.db"), { readonly: true });
  let rows: { actorId: string; subjectId: string; objectId: string; reason: string }[];
  try { rows = audit.prepare("SELECT actorId,subjectId,objectId,reason FROM app_audit WHERE action='web.search' ORDER BY id").all() as typeof rows; } finally { audit.close(); }
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) { expect(row.objectId).toBe(chatId); expect(row.reason).toMatch(/^\d+ search(es)?$/); }
  console.log(JSON.stringify({ model, sawSearching, sources: saved.map((message: { sources?: { url: string; cited?: boolean }[] }) => (message.sources ?? []).map(source => `${source.cited ? "*" : ""}${source.url}`)), audit: rows.map(row => row.reason), pastedLinkReply: thirdText.slice(0, 400), ordinaryReply: plainText.slice(0, 300) }, null, 2));
  expect(errors).toEqual([]);
});
