import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";

const origin = "http://127.0.0.1:3211";
async function signup(request: APIRequestContext, label: string) {
  const data = { email: `${label}-${randomUUID()}@example.test`, password: "Synthetic composer test pass! 7314" };
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

test("the composer stays usable during a streaming reply while Send waits, on desktop, mobile and when acting as a user", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const owner = await signup(page.request, "composer-owner");
  const chatId = (await (await page.request.post("/api/chats", { headers: { origin } })).json()).chat.id as string;
  const inFlight = withStore(store => {
    const file = store.addFile(owner.id, chatId, "in-flight.txt", Buffer.from("old turn"), "old turn", "");
    const turn = store.beginTurn(owner.id, chatId, "Seeded question", "fixture-model", [file.id]);
    store.saveReply(owner.id, chatId, turn.assistant.id, "Partial streamed answer", "streaming");
    return { file: file.id, assistant: turn.assistant.id };
  });
  const sends: { content: string; fileIds: string[] }[] = [];
  await page.route("**/messages", async route => {
    sends.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Synthetic test stops before billable generation." }) });
  });
  await page.goto(`/?chat=${chatId}`);
  await expect(page.getByRole("button", { name: "Stop reply" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(page.locator(".composer-caption")).toContainText("Reply in progress");
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill("Next question typed while the reply streams");
  await composer.press("Enter");
  await expect(composer).toHaveValue("Next question typed while the reply streams");
  expect(sends).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Attach files" })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({ name: "picked.txt", mimeType: "text/plain", buffer: Buffer.from("picked mid-reply") });
  await expect(page.getByRole("button", { name: "Preview extracted text for picked.txt", exact: true })).toBeEnabled({ timeout: 30_000 });
  const pixels = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  await composer.evaluate((element, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...pixels]);
  await expect(page.getByRole("button", { name: "Preview extracted text for pasted.png", exact: true })).toBeEnabled({ timeout: 30_000 });
  const dropped = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(["dropped then removed"], "dropped.txt", { type: "text/plain" })); return data; });
  await page.locator(".composer").dispatchEvent("drop", { dataTransfer: dropped });
  await dropped.dispose();
  await expect(page.getByRole("button", { name: "Preview extracted text for dropped.txt", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Remove dropped.txt", exact: true }).click();
  await expect(page.locator(".file-job").filter({ hasText: "dropped.txt" })).toHaveCount(0);
  const picker = page.getByRole("combobox", { name: "Select model" });
  await expect(picker).toBeEnabled();
  const options = await picker.locator("option").evaluateAll(items => items.map(item => (item as HTMLOptionElement).value));
  const nextModel = options.at(-1)!;
  await picker.selectOption(nextModel);
  const dictate = page.getByRole("button", { name: /Dictate/ });
  if (await dictate.isEnabled()) {
    await dictate.click();
    await expect(page.getByRole("dialog")).toContainText("A quick note about dictation");
    await page.getByRole("button", { name: "Keep typing" }).click();
  } else await expect(dictate).toHaveAttribute("title", /text chat works/);
  await expect(composer).toHaveValue("Next question typed while the reply streams");
  await expect(page.locator(".composer-caption")).toContainText("Draft saved");
  await page.screenshot({ path: "test-results/composer-streaming-desktop.png", fullPage: true, animations: "disabled" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Stop reply" })).toBeVisible();
  await expect(composer).toHaveValue("Next question typed while the reply streams");
  await expect(page.locator(".file-job")).toHaveCount(2);
  await expect(picker).toHaveValue(nextModel);
  await page.setViewportSize({ width: 390, height: 844 });
  await composer.fill("Next question typed while the reply streams — edited on mobile");
  await expect(page.getByRole("button", { name: "Attach files" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/composer-streaming-mobile.png", fullPage: true, animations: "disabled" });
  await expect(page.locator(".composer-caption")).toContainText("Draft saved");
  const bound = withStore(store => {
    const files = store.attachments(owner.id, chatId);
    store.saveReply(owner.id, chatId, inFlight.assistant, "Partial streamed answer, now complete.", "complete");
    return files;
  });
  expect(bound.find(file => file.id === inFlight.file)?.messageId).toBeTruthy();
  expect(bound.filter(file => !file.messageId).map(file => file.name).sort()).toEqual(["pasted.png", "picked.txt"]);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0].content).toBe("Next question typed while the reply streams — edited on mobile");
  expect(new Set(sends[0].fileIds)).toEqual(new Set(bound.filter(file => !file.messageId).map(file => file.id)));
  expect(sends[0].fileIds).not.toContain(inFlight.file);
  await expect(composer).toHaveValue("Next question typed while the reply streams — edited on mobile");
  await page.setViewportSize({ width: 1280, height: 720 });

  const adminContext = await browser.newContext({ baseURL: origin });
  try {
    const admin = await adminContext.newPage();
    const adminUser = await signup(admin.request, "composer-admin");
    expect((await admin.request.get(`/api/chats/${chatId}`)).status()).toBe(404);
    expect((await admin.request.post("/api/drafts", { headers: { origin }, data: { chatId, draft: "stolen" } })).status()).toBe(404);
    const second = withStore(store => {
      new AccessService(store).setRoleLocally(adminUser.email, "superuser");
      const turn = store.beginTurn(owner.id, chatId, "Second seeded question", "fixture-model", []);
      store.saveReply(owner.id, chatId, turn.assistant.id, "Streaming again", "streaming");
      return turn.assistant.id;
    });
    expect((await admin.request.post("/api/admin/acting", { headers: { origin }, data: { userId: owner.id, chatId } })).status()).toBe(200);
    await admin.goto(`/?chat=${chatId}`);
    await expect(admin.locator(".acting-banner")).toContainText(owner.email);
    await expect(admin.getByRole("button", { name: "Stop reply" })).toBeVisible();
    const adminComposer = admin.getByLabel("Message", { exact: true });
    await expect(adminComposer).toBeEnabled();
    await adminComposer.fill("ADMIN_ACTING_DRAFT");
    await admin.locator('input[type="file"]').setInputFiles({ name: "admin-mid-reply.txt", mimeType: "text/plain", buffer: Buffer.from("admin upload") });
    await expect(admin.getByRole("button", { name: "Preview extracted text for admin-mid-reply.txt", exact: true })).toBeEnabled({ timeout: 30_000 });
    await expect(admin.locator(".composer-caption")).toContainText("Draft saved");
    const check = withStore((store, db) => {
      const result = {
        draft: store.chat(owner.id, chatId).draft,
        file: store.attachments(owner.id, chatId).find(file => file.name === "admin-mid-reply.txt"),
        audit: db.prepare("SELECT actorId,subjectId,action,outcome,delegationId FROM app_audit WHERE actorId=? AND action IN ('draft.save','file.upload.begin')").all(adminUser.id) as { actorId: string; subjectId: string; action: string; outcome: string; delegationId: string | null }[],
        auditText: JSON.stringify(db.prepare("SELECT * FROM app_audit").all()),
      };
      store.saveReply(owner.id, chatId, second, "Streaming again, done.", "complete");
      return result;
    });
    expect(check.draft).toBe("ADMIN_ACTING_DRAFT");
    expect(check.file?.messageId).toBeNull();
    const delegated = check.audit.filter(row => row.outcome === "allowed");
    expect(new Set(delegated.map(row => row.action))).toEqual(new Set(["draft.save", "file.upload.begin"]));
    expect(delegated.every(row => row.subjectId === owner.id && row.delegationId)).toBe(true);
    const deniedBeforeElevation = check.audit.filter(row => row.outcome !== "allowed");
    expect(deniedBeforeElevation.length).toBeGreaterThanOrEqual(1);
    expect(deniedBeforeElevation.every(row => row.subjectId === adminUser.id && !row.delegationId)).toBe(true);
    expect(check.auditText.includes("ADMIN_ACTING_DRAFT")).toBe(false);
  } finally { await adminContext.close(); }
});

test("Send, a pasted file and draft autosave during a new chat's first request all share one chat", async ({ page }) => {
  test.setTimeout(180_000);
  await signup(page.request, "composer-new-chat");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let creates = 0;
  await page.route("**/api/chats", async route => {
    if (route.request().method() === "POST") { creates++; await gate; }
    await route.continue();
  });
  await page.route("**/messages", route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Synthetic test stops before billable generation." }) }));
  await page.goto("/");
  const composer = page.getByLabel("Message", { exact: true });
  const newPicker = page.getByRole("combobox", { name: "Select model" });
  await expect(newPicker).toBeEnabled();
  await expect(newPicker.locator("option").first()).toBeAttached();
  await composer.fill("First message");
  await composer.press("Enter");
  await expect.poll(() => creates).toBe(1);
  const pixels = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).png().toBuffer();
  await composer.evaluate((element, bytes) => {
    const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "early.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...pixels]);
  await composer.pressSequentially("typed during creation");
  await page.waitForTimeout(1500);
  release();
  await expect(page.locator(".notice")).toContainText("Synthetic test stops", { timeout: 30_000 });
  await expect(composer).toHaveValue("First message\n\ntyped during creation");
  await expect(page.getByRole("button", { name: "Preview extracted text for early.png", exact: true })).toBeEnabled({ timeout: 30_000 });
  expect(creates).toBe(1);
  const chats = (await (await page.request.get("/api/chats")).json()).chats as { id: string }[];
  expect(chats).toHaveLength(1);
  expect(new URL(page.url()).searchParams.get("chat")).toBe(chats[0].id);
  await expect.poll(async () => {
    const detail = await (await page.request.get(`/api/chats/${chats[0].id}`)).json();
    return { draft: detail.chat.draft, files: detail.attachments.map((file: { name: string; messageId: string | null }) => [file.name, file.messageId]) };
  }, { timeout: 15_000 }).toEqual({ draft: "First message\n\ntyped during creation", files: [["early.png", null]] });
});