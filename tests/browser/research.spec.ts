import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";
import type { ChatDetail, Message } from "../../lib/contracts";
import { chooseThinking, modelButton, selectModel } from "./helpers";

// Real Copilot calls (about six prompts plus their tool follow-ups): thinking levels on a GPT and a Claude model, one full deep research
// run that keeps going after its tab is closed, and one that is stopped. Opt-in:
//   $env:MODEL_CHAT_RESEARCH_E2E = '1'; $env:RESEARCH_SCREENS_DIR = '<folder>'; npx playwright test tests/browser/research.spec.ts
test.skip(process.env.MODEL_CHAT_RESEARCH_E2E !== "1", "Set MODEL_CHAT_RESEARCH_E2E=1 to run real thinking-level and deep research checks.");

const origin = "http://127.0.0.1:3211";
const password = "Test-only password! 48291";
const shots = process.env.RESEARCH_SCREENS_DIR;
const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };
async function shot(page: Page, name: string, fullPage = false) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage, animations: "disabled" });
}
async function signUp(page: Page, address: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}
const chatIdOf = (page: Page) => new URL(page.url()).searchParams.get("chat")!;
const lastReply = async (page: Page, chatId: string) => ((await (await page.request.get(`/api/chats/${chatId}`)).json()) as ChatDetail).messages.at(-1)!;
async function ask(page: Page, text: string) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop reply" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 240_000 });
  return page.locator(".message.assistant").last();
}
async function planResearch(page: Page, question: string) {
  await page.getByRole("button", { name: "Deep research" }).click();
  await expect(page.getByRole("button", { name: "Deep research" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Message", { exact: true }).fill(question);
  await page.getByRole("button", { name: "Plan research" }).click();
  const plan = page.getByRole("group", { name: "Research plan" });
  await expect(plan).toBeVisible({ timeout: 240_000 });
  return plan;
}

test("thinking levels per model and deep research that survives a closed tab, Stop and acting", async ({ page, browser }) => {
  test.setTimeout(45 * 60_000);
  const data = process.env.MODEL_CHAT_TEST_DATA_DIR!;
  const summary: Record<string, unknown> = {};
  await page.setViewportSize(desktop);
  const ownerEmail = `owner-${randomUUID()}@example.test`;
  await signUp(page, ownerEmail);
  const db = new Database(path.join(data, "model-chat.db"));
  try { new AccessService(new Store(db)).setRoleLocally(ownerEmail, "superuser"); } finally { db.close(); }
  await page.reload();
  const models = (await (await page.request.get("/api/models")).json()).models as { id: string; name: string; levels?: string[] }[];
  const gpt = models.find(item => item.id === (process.env.MODEL_CHAT_GPT_MODEL || "gpt-6-luna")) ?? models.find(item => /^gpt/.test(item.id) && item.levels?.includes("max"))!;
  const claude = models.find(item => item.id === (process.env.MODEL_CHAT_CLAUDE_MODEL || "claude-haiku-5.5")) ?? models.find(item => /^claude/.test(item.id) && item.levels?.includes("max"))!;
  summary.levels = Object.fromEntries(models.map(item => [item.id, item.levels ?? null]));

  // Thinking: the menu lists exactly the model's levels; Off only where the model supports "none".
  await selectModel(page, gpt.id);
  await modelButton(page).click();
  const menu = page.getByRole("dialog", { name: "Model and thinking" });
  expect(await menu.locator('input[name="thinking"]').evaluateAll(items => items.map(item => (item as HTMLInputElement).value))).toEqual(gpt.levels);
  await shot(page, "01-model-picker-thinking-desktop");
  await chooseThinking(page, "max");
  await expect(menu).toHaveCount(0);
  await expect(modelButton(page)).toContainText("Max");
  await shot(page, "02-message-box-with-level-desktop");
  // RESEARCH_REUSE_THINKING=1 skips the two real thinking replies (already validated) and keeps the picker checks and screenshots.
  if (process.env.RESEARCH_REUSE_THINKING !== "1") {
  const gptReply = await ask(page, "What is 17 × 23? Answer in one short sentence.");
  await expect(gptReply.locator(".thinking-tag")).toHaveText("Max");
  await expect(gptReply).toContainText("391");
  const chatId = chatIdOf(page);
  summary.gpt = { model: gpt.id, thinking: (await lastReply(page, chatId)).thinking, reasoningChars: (await lastReply(page, chatId)).reasoning.length };

  await selectModel(page, claude.id);
  await expect(modelButton(page)).toHaveAttribute("data-thinking", "max");
  await modelButton(page).click();
  expect(await menu.locator('input[name="thinking"]').evaluateAll(items => items.map(item => (item as HTMLInputElement).value))).toEqual(claude.levels);
  await expect(menu.locator('input[name="thinking"][value="none"]')).toHaveCount(claude.levels?.includes("none") ? 1 : 0);
  await page.keyboard.press("Escape");
  const claudeReply = await ask(page, "Name the capital of Australia in one short sentence.");
  await expect(claudeReply.locator(".thinking-tag")).toHaveText("Max");
  await expect(claudeReply).toContainText("Canberra");
  summary.claude = { model: claude.id, thinking: (await lastReply(page, chatId)).thinking, reasoningChars: (await lastReply(page, chatId)).reasoning.length };
  await page.reload();
  await expect(modelButton(page)).toHaveAttribute("data-model", claude.id);
  await expect(modelButton(page)).toHaveAttribute("data-thinking", "max");
  } else {
    await selectModel(page, claude.id);
    await expect(modelButton(page)).toHaveAttribute("data-thinking", "max");
  }
  await page.setViewportSize(mobile);
  await modelButton(page).click();
  await shot(page, "01b-model-picker-thinking-mobile");
  await page.keyboard.press("Escape");
  await shot(page, "02b-message-box-with-level-mobile");
  await page.setViewportSize(desktop);
  if (process.env.RESEARCH_PICKER_ONLY === "1") return;

  // Deep research: plan, start, close the tab mid-run, come back to the finished report.
  await page.getByRole("button", { name: "New conversation" }).click();
  await selectModel(page, gpt.id, "medium");
  const question = process.env.MODEL_CHAT_RESEARCH_QUESTION || "What changed in the most recent Node.js release lines (current, LTS and the new release schedule), and what should a team upgrading from Node 22 plan for? Use current official sources.";
  const plan = await planResearch(page, question);
  await shot(page, "03-research-plan-desktop");
  const researchChat = chatIdOf(page);
  await plan.getByRole("button", { name: "Start research" }).click();
  await expect(page.locator(".research-card.running")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".research-card.running .research-entry").first()).toBeVisible({ timeout: 180_000 });
  await expect(page.locator(".research-card.running .research-entry.read")).not.toHaveCount(0, { timeout: 300_000 });
  await shot(page, "04-research-in-progress-desktop");
  await page.setViewportSize(mobile);
  await shot(page, "04b-research-in-progress-mobile");
  const context = page.context();
  const startedRun = (await lastReply(page, researchChat)).research!;
  await page.close();
  let finished: Message | undefined;
  for (let waited = 0; waited < 20 * 60_000; waited += 10_000) {
    const reply = ((await (await context.request.get(`/api/chats/${researchChat}`)).json()) as ChatDetail).messages.at(-1)!;
    if (!["planning", "awaiting_start", "running", "writing"].includes(reply.research!.state)) { finished = reply; break; }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  expect(finished?.research?.state, finished?.research?.error ?? "").toBe("complete");
  expect(finished!.status).toBe("complete");
  expect(finished!.content).toMatch(/\[\[1\]\]\(https?:\/\//);
  expect(finished!.content).toMatch(/\n## Sources\n\n1\. \[/);
  expect(finished!.research!.counts.pages).toBeGreaterThan(0);
  const back = await context.newPage();
  await back.setViewportSize(desktop);
  await back.goto(`/?chat=${researchChat}`);
  await expect(modelButton(back)).toContainText(gpt.name, { timeout: 90_000 });
  const report = back.locator(".message.assistant").last();
  await expect(report.locator(".markdown h2", { hasText: "Sources" })).toBeVisible();
  await back.locator(".conversation").evaluate(node => { node.scrollTop = 0; });
  await shot(back, "05-research-report-desktop");
  await report.locator(".research-card.done summary").click();
  await report.locator(".markdown h2", { hasText: "Sources" }).scrollIntoViewIfNeeded();
  await shot(back, "05b-research-report-sources-desktop");
  await back.setViewportSize(mobile);
  await back.locator(".conversation").evaluate(node => { node.scrollTop = 0; });
  await shot(back, "05c-research-report-mobile");
  await back.setViewportSize(desktop);
  const run = finished!.research!;
  summary.research = { question, plan: run.plan, counts: run.counts, seconds: Math.round(((run.finishedAt ?? 0) - (run.startedAt ?? 0)) / 1000),
    sources: run.sources.map(source => source.url), cited: (finished!.content.match(/\[\[\d+\]\]\(/g) || []).length, reportCharacters: finished!.content.length,
    closedTabAt: startedRun.state, log: run.log.map(item => `${item.kind}: ${item.text}`) };

  // Stop: a second run is stopped once it has searched; it reloads as stopped. RESEARCH_SKIP_STOP=1 skips it (already validated).
  if (process.env.RESEARCH_SKIP_STOP !== "1") {
  await back.getByRole("button", { name: "New conversation" }).click();
  const second = await planResearch(back, "Compare the current battery chemistries used in electric cars in 2026 and their cost trends.");
  const stopChat = chatIdOf(back);
  await second.getByRole("button", { name: "Start research" }).click();
  await expect(back.locator(".research-card.running .research-entry.search").first()).toBeVisible({ timeout: 240_000 });
  await back.getByRole("button", { name: "Stop research" }).click();
  await expect.poll(async () => (await lastReply(back, stopChat)).research?.state, { timeout: 60_000 }).toBe("cancelled");
  await back.reload();
  await expect(back.locator(".research-card.done.cancelled summary")).toContainText("Research stopped");
  await expect(back.getByRole("button", { name: "Send message" })).toBeVisible();
  summary.stopped = (await lastReply(back, stopChat)).research!.counts;
  }

  // Acting as another user: no deep research, refused by the server too.
  const bob = await browser.newContext({ baseURL: origin });
  const bobEmail = `bob-${randomUUID()}@example.test`;
  const bobPage = await bob.newPage();
  await signUp(bobPage, bobEmail);
  const bobId = (await (await bobPage.request.get("/api/account")).json()).user.id as string;
  const bobChat = (await (await bobPage.request.post("/api/chats", { headers: { origin } })).json()).chat.id as string;
  await bob.close();
  expect((await back.request.post("/api/admin/acting", { headers: { origin }, data: { userId: bobId } })).status()).toBe(200);
  await back.goto("/");
  await expect(back.locator(".acting-banner")).toBeVisible();
  await expect(back.getByRole("button", { name: "Deep research" })).toHaveCount(0);
  const refused = await back.request.post(`/api/chats/${bobChat}/research`, { headers: { origin, "x-model-chat-subject": bobId }, data: { content: "Research anything", model: gpt.id } });
  expect(refused.status()).toBe(403);
  await back.getByRole("button", { name: "Return to my workspace" }).click();
  await expect(back.locator(".acting-banner")).toHaveCount(0);

  const audit = new Database(path.join(data, "model-chat.db"), { readonly: true });
  try {
    summary.audit = (audit.prepare("SELECT action,outcome,reason FROM app_audit WHERE action LIKE 'research.%' ORDER BY id").all() as { action: string; outcome: string; reason: string }[])
      .map(row => `${row.action} ${row.outcome} ${row.reason}`);
  } finally { audit.close(); }
  console.log(JSON.stringify(summary, null, 2));
});
