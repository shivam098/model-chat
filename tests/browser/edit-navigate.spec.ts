import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";

// Editing sent messages (versions and branches), finding your way around a long thread, and the "summarised" note, without model calls.
// Set EDIT_SCREENS_DIR to also save desktop and mobile screenshots.
const origin = "http://127.0.0.1:3211";
const shots = process.env.EDIT_SCREENS_DIR;
const models = [
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", vision: true, multiplier: 1, maxImages: 20, levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-astra", name: "GPT-6 Astra", vision: true, multiplier: 1, maxImages: 10, levels: ["low", "medium", "high", "xhigh", "max"] },
];
async function signup(request: APIRequestContext, label: string) {
  const data = { email: `${label}-${randomUUID().slice(0, 6)}@example.test`, password: "Synthetic edit test pass! 5521" };
  let response = await request.post(origin + "/api/auth/sign-up/email", { headers: { origin }, data });
  if (response.status() === 429) { await new Promise(resolve => setTimeout(resolve, 61_000)); response = await request.post(origin + "/api/auth/sign-up/email", { headers: { origin }, data }); }
  expect(response.status()).toBe(200);
  return (await response.json()).user as { id: string; email: string };
}
function withStore<T>(operation: (store: Store, db: Database.Database) => T) {
  const directory = process.env.MODEL_CHAT_TEST_DATA_DIR!;
  expect(path.basename(directory)).toMatch(/^browser-test-/);
  const db = new Database(path.join(directory, "model-chat.db"));
  try { return operation(new Store(db), db); } finally { db.close(); }
}
async function shot(page: Page, name: string, target?: ReturnType<Page["locator"]>) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(300);
  if (target) await target.screenshot({ path: path.join(shots, `${name}.png`), animations: "disabled" });
  else await page.screenshot({ path: path.join(shots, `${name}.png`), animations: "disabled" });
}
const TOPICS = ["the abstract", "the introduction", "the related work", "the method", "the dataset", "the results table", "the discussion", "the limitations", "the conclusion", "the references"];
/** A paper-editing chat: 5 turns, then turn 3 edited (the old branch keeps turns 3–5), then 7 more turns on the new branch. */
function seedPaperChat(store: Store, userId: string, chatId: string) {
  const say = (content: string, reply: string, edit?: { editOf: string; keepFileIds?: string[] }, files: string[] = [], note?: string) => {
    const turn = store.beginTurn(userId, chatId, content, "claude-sonnet-5.5", files, "medium", edit);
    if (note) store.setContextNote(userId, chatId, turn.assistant.id, note);
    store.saveReply(userId, chatId, turn.assistant.id, reply, "complete");
    return turn;
  };
  const paper = store.addFile(userId, chatId, "urban-heat-paper.txt", Buffer.from("Paper"), "Urban heat islands raise night-time temperatures. ".repeat(200), "Synthetic paper text.");
  const first = say("Here is my draft paper on urban heat islands. Please read it and tell me what to improve first.", "Thanks. The paper is clear, but **the abstract** buries the main finding. Start there, then tighten the method section.", undefined, [paper.id]);
  say("What is the main finding, in one sentence?", "Cool roofs lowered night-time surface temperatures by 2.1 °C across the 14 districts studied.");
  const original = say("Rewrite the abstract in a formal tone.", "**Abstract (formal).** This study quantifies the effect of reflective roofing on nocturnal urban surface temperatures…");
  say("Shorter, please.", "**Abstract (shorter, formal).** Reflective roofs reduced night-time surface temperatures by 2.1 °C…");
  say("Good. Now the introduction.", "Here is a formal introduction…");
  const edited = say("Rewrite the abstract in a plain, friendly tone for a general audience.", "**Abstract (plain).** Painting roofs white made city neighbourhoods about 2 °C cooler at night…", { editOf: original.user.id });
  TOPICS.slice(1, 7).forEach((topic, index) => say(index === 3 ? `Here is the full results table and my notes for ${topic}.\n\n${Array.from({ length: 40 }, (_, row) => `District ${row + 1}: day ${(30 + row % 7).toFixed(1)} °C, night ${(22 + row % 5).toFixed(1)} °C, roofs treated ${(row * 3) % 100}%`).join("\n")}` : `Improve ${topic} next.`,
    `Suggestions for ${topic}:\n\n1. Lead with the claim.\n2. Cite the district data.\n3. Keep sentences short.`, undefined, [], index === 5 ? "Earlier messages were summarised to fit (12 of 22 messages)" : undefined));
  return { first, original, edited, paper };
}

test("edit a sent message, switch versions, navigate a long thread and see the summary note, on desktop, mobile and while acting", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await page.route("**/api/models", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models, authenticated: true }) }));
  await page.setViewportSize({ width: 1440, height: 900 });
  const owner = await signup(page.request, "edit-owner");
  const chatId = (await (await page.request.post("/api/chats", { headers: { origin } })).json()).chat.id as string;
  const seeded = withStore(store => seedPaperChat(store, owner.id, chatId));
  await page.goto(`/?chat=${chatId}`);
  const userMessages = page.locator("article.message.user");
  await expect(userMessages).toHaveCount(9);

  // Navigator: a marker per message you sent, a preview on hover, a jump with a highlight, Alt+arrows and "Latest".
  const marks = page.locator(".thread-mark");
  await expect(marks).toHaveCount(9);
  await marks.nth(1).hover();
  await expect(marks.nth(1).locator(".thread-tip")).toContainText("What is the main finding");
  await shot(page, "01-navigator-hover-desktop");
  await marks.nth(1).click();
  const second = page.locator(`[data-message-id="${seeded.first.user.id}"] ~ article.message.user`).first();
  await expect(second).toHaveClass(/flash/);
  await expect(second).toBeInViewport();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(marks.nth(2)).toHaveAttribute("aria-current", "location");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(marks.nth(1)).toHaveAttribute("aria-current", "location");
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await expect(marks.nth(8)).toHaveAttribute("aria-current", "location");

  // The summary note on a reply, and a long pasted message that folds.
  const note = page.locator(".context-note");
  await expect(note).toHaveText("Earlier messages summarised");
  await expect(note).toHaveAttribute("title", /12 of 22 messages.*full history stays saved/);
  await shot(page, "02-summary-note-desktop", page.locator("article.message.assistant").last());
  const long = userMessages.filter({ hasText: "full results table" });
  await expect(long.locator(".bubble")).toHaveClass(/clamped/);
  await long.getByRole("button", { name: "Show all" }).click();
  await expect(long.locator(".bubble")).not.toHaveClass(/clamped/);

  // Versions: the edited message shows 2 / 2; the earlier version brings back its own later turns, and the choice survives a reload.
  const edited = page.locator(`[data-message-id="${seeded.edited.user.id}"]`);
  await edited.scrollIntoViewIfNeeded();
  await expect(edited.locator(".version-count")).toHaveText("2 / 2");
  await edited.hover();
  await shot(page, "03-version-switcher-desktop", edited);
  await edited.getByRole("button", { name: "Previous version" }).click();
  const old = page.locator(`[data-message-id="${seeded.original.user.id}"]`);
  await expect(old.locator(".version-count")).toHaveText("1 / 2");
  await expect(userMessages).toHaveCount(5);
  await expect(page.locator(".bubble").filter({ hasText: "Good. Now the introduction." })).toBeVisible();
  await expect(page.locator(".bubble").filter({ hasText: "Improve the dataset next." })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`[data-message-id="${seeded.original.user.id}"] .version-count`)).toHaveText("1 / 2");
  await page.locator(`[data-message-id="${seeded.original.user.id}"]`).getByRole("button", { name: "Next version" }).click();
  await expect(page.locator(`[data-message-id="${seeded.edited.user.id}"] .version-count`)).toHaveText("2 / 2");
  await expect(userMessages).toHaveCount(9);

  // Editing: in place, with the message's attachments (removable), current model and thinking level; Esc cancels; a failed send keeps the edit.
  const sends: Record<string, unknown>[] = [];
  await page.route("**/messages", async route => {
    sends.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Synthetic test stops before billable generation." }) });
  });
  const first = page.locator(`[data-message-id="${seeded.first.user.id}"]`);
  await first.scrollIntoViewIfNeeded();
  await first.hover();
  await first.getByRole("button", { name: "Edit message" }).click();
  const box = page.getByLabel("Edit your message");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(/Here is my draft paper/);
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await first.getByRole("button", { name: "Edit message" }).click();
  await expect(page.locator(".edit-note")).toContainText("Sends a new version from here with Claude Sonnet 5.5 · Medium");
  await page.getByRole("button", { name: "Remove urban-heat-paper.txt from the new version" }).click();
  await expect(page.getByRole("button", { name: "Restore 1 removed" })).toBeVisible();
  await page.getByRole("button", { name: "Restore 1 removed" }).click();
  await box.fill("Here is my draft paper on urban heat islands. Focus on the method first.");
  await shot(page, "04-edit-box-desktop", page.locator("article.message.user.editing"));
  await page.getByRole("button", { name: "Remove urban-heat-paper.txt from the new version" }).click();
  await page.locator(".edit-box").getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".notice")).toContainText("Synthetic test stops before billable generation.");
  expect(sends.at(-1)).toMatchObject({ content: "Here is my draft paper on urban heat islands. Focus on the method first.", editOf: seeded.first.user.id, keepFileIds: [], fileIds: [] });
  await expect(page.getByLabel("Edit your message")).toHaveValue("Here is my draft paper on urban heat islands. Focus on the method first.");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("", { timeout: 1000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.unroute("**/messages");

  // Phones: the rail becomes a list of your messages; actions are always visible; the editor fits the screen.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mobile = await phone.newPage();
  await mobile.route("**/api/models", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models, authenticated: true }) }));
  await mobile.goto(`/?chat=${chatId}`);
  await expect(mobile.locator("article.message.user")).toHaveCount(9);
  await expect(mobile.locator(".thread-nav")).toBeHidden();
  await mobile.getByRole("button", { name: "Your messages" }).tap();
  const sheet = mobile.getByRole("dialog", { name: "Your messages" });
  await expect(sheet.locator("li")).toHaveCount(9);
  await shot(mobile, "05-navigator-sheet-mobile");
  await sheet.locator("li").nth(2).getByRole("button").tap();
  await expect(sheet).toHaveCount(0);
  const mobileEdited = mobile.locator(`[data-message-id="${seeded.edited.user.id}"]`);
  await expect(mobileEdited).toBeInViewport();
  await expect(mobileEdited.getByRole("button", { name: "Edit message" })).toBeVisible();
  await shot(mobile, "06-version-switcher-mobile");
  await mobileEdited.getByRole("button", { name: "Edit message" }).tap();
  await expect(mobile.getByLabel("Edit your message")).toBeVisible();
  await shot(mobile, "07-edit-box-mobile");
  await mobile.getByRole("button", { name: "Cancel" }).tap();
  await phone.close();

  // Coding chats: the edit box says plainly that file changes aren't rolled back.
  const project = mkdtempSync(path.join(os.tmpdir(), "model-chat-edit-code-"));
  const codeChat = withStore(store => {
    new AccessService(store).setRoleLocally(owner.email, "superuser");
    const chat = store.createChat(owner.id, { projectPath: project });
    const turn = store.beginTurn(owner.id, chat.id, "Add a dark mode toggle.", "claude-sonnet-5.5", []);
    store.saveReply(owner.id, chat.id, turn.assistant.id, "Added the toggle in app.css and app.js.", "complete");
    return { chat: chat.id, user: turn.user.id };
  });
  await page.goto(`/?chat=${codeChat.chat}`);
  const codeMessage = page.locator(`[data-message-id="${codeChat.user}"]`);
  await codeMessage.hover();
  await codeMessage.getByRole("button", { name: "Edit message" }).click();
  await expect(page.locator(".edit-note")).toContainText("File changes made by later turns stay on disk; nothing is rolled back");
  await shot(page, "08-edit-code-mode-desktop", page.locator("article.message.user.editing"));
  await page.getByRole("button", { name: "Cancel" }).click();

  // Acting as a user: the superuser can switch versions in that user's chat like they can send, and it's audited with both people.
  const other = await browser.newContext();
  const bob = await signup(other.request, "edit-bob");
  await other.close();
  const bobChat = withStore(store => {
    const chat = store.createChat(bob.id);
    const one = store.beginTurn(bob.id, chat.id, "Plan a trip to Lisbon.", "claude-sonnet-5.5", []);
    store.saveReply(bob.id, chat.id, one.assistant.id, "Three days: Alfama, Belém, Sintra.", "complete");
    const two = store.beginTurn(bob.id, chat.id, "Plan a trip to Porto.", "claude-sonnet-5.5", [], null, { editOf: one.user.id });
    store.saveReply(bob.id, chat.id, two.assistant.id, "Two days: Ribeira, Livraria Lello.", "complete");
    return { chat: chat.id, one: one.user.id, two: two.user.id };
  });
  const acting = await page.request.post("/api/admin/acting", { headers: { origin, "x-model-chat-subject": owner.id }, data: { userId: bob.id, chatId: bobChat.chat } });
  expect(acting.status()).toBe(200);
  await page.goto(`/?chat=${bobChat.chat}`);
  await expect(page.getByText(/Acting as/)).toBeVisible();
  const porto = page.locator(`[data-message-id="${bobChat.two}"]`);
  await porto.hover();
  await porto.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByText("Three days: Alfama, Belém, Sintra.")).toBeVisible();
  const audit = withStore((_, db) => db.prepare("SELECT actorId,subjectId,outcome FROM app_audit WHERE action='message.branch' AND objectId=?").get(bobChat.one)) as { actorId: string; subjectId: string; outcome: string };
  expect(audit).toEqual({ actorId: owner.id, subjectId: bob.id, outcome: "allowed" });
  expect((await page.request.post("/api/admin/stop", { headers: { origin, "x-model-chat-subject": bob.id }, data: {} })).status()).toBe(200);
  // Another account can't read or switch these branches.
  expect((await page.request.post(`/api/chats/${bobChat.chat}/branch`, { headers: { origin, "x-model-chat-subject": owner.id }, data: { messageId: bobChat.two } })).status()).toBe(404);
});
