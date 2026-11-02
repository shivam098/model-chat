import { expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import sharp from "sharp";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";

export async function runAdminFlow(page: Page, bob: Page, adminEmail: string, bobEmail: string) {
  const origin = "http://127.0.0.1:3211";
  expect(page.url().startsWith(origin)).toBe(true);
  const testDirectory = process.env.MODEL_CHAT_TEST_DATA_DIR;
  if (!testDirectory || !path.resolve(testDirectory).startsWith(path.resolve(".local") + path.sep) || !path.basename(testDirectory).startsWith("browser-test-")) {
    throw new Error("An isolated browser-test data directory is required.");
  }
  const database = new Database(path.join(testDirectory, "model-chat.db"));
  const store = new Store(database);
  const roles = new AccessService(store);
  let requests = 0;
  try {
    const realAdmin = (await (await page.request.get("/api/account")).json()).user;
    const realBob = (await (await bob.request.get("/api/account")).json()).user;
    const available = (await (await page.request.get("/api/models")).json()).models as { id: string; vision?: boolean }[];
    const model = available[0].id;
    const chat = store.createChat(realBob.id);
    store.renameChat(realBob.id, chat.id, "Bob preserved history");
    const original = store.beginTurn(realBob.id, chat.id, "BOB_PRIVATE_OLD_PROMPT", model, []);
    store.saveReply(realBob.id, chat.id, original.assistant.id, "BOB_PRIVATE_OLD_REPLY", "complete");
    store.saveDraft(realBob.id, chat.id, "BOB_SAVED_DRAFT", model);
    const before = store.messages(realBob.id, chat.id);
    roles.setRoleLocally(adminEmail, "superuser");
    await page.reload();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/sample-budget.csv/);
    await page.getByLabel("Message", { exact: true }).fill("ADMIN_OWN_UNSENT_DRAFT");
    await expect(page.locator(".composer-caption")).toContainText("Draft saved");
    const ownId = new URL(page.url()).searchParams.get("chat")!;
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Users & audit", exact: true }).click();
    await page.getByLabel("Search users by name or email").fill(bobEmail);
    const row = page.locator(".admin-user").filter({ hasText: bobEmail });
    await row.getByRole("button", { name: "View sessions", exact: true }).click();
    await page.getByRole("button", { name: "Open as user", exact: true }).click();
    await expect(page.locator(".acting-banner")).toContainText(bobEmail);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("BOB_SAVED_DRAFT");
    await expect(page.locator(".message.user")).toContainText("BOB_PRIVATE_OLD_PROMPT");
    await expect(page.locator(".message.assistant")).toContainText("BOB_PRIVATE_OLD_REPLY");
    const account = await (await page.request.get("/api/account")).json();
    expect(account.actor.id).toBe(realAdmin.id);
    expect(account.user.id).toBe(realBob.id);
    expect((await page.request.post("/api/admin/acting", { headers: { origin }, data: { userId: realAdmin.id } })).status()).toBe(409);
    expect((await page.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email: "should-not-exist@example.test", password: "Not a real password 3435!" } })).status()).toBe(403);
    expect((await bob.request.get("/api/admin/users")).status()).toBe(403);
    expect((await bob.request.get("/api/admin/audit")).status()).toBe(403);
    expect((await bob.request.get("/api/chats", { headers: { "x-model-chat-subject": realAdmin.id } })).status()).toBe(409);
    await page.getByRole("button", { name: "Rename Bob preserved history", exact: true }).click();
    await page.getByLabel("Conversation name").fill("Bob renamed by admin");
    await page.getByRole("button", { name: "Save name", exact: true }).click();
    const image = await sharp({ create: { width: 280, height: 180, channels: 3, background: "white" } })
      .composite([{ input: Buffer.from('<svg width="280" height="180"><text x="40" y="130" font-size="100" fill="black">A7</text></svg>') }]).png().toBuffer();
    await page.locator('input[type="file"]').setInputFiles({ name: "native-image.png", mimeType: "image/png", buffer: image });
    await expect(page.locator(".file-chip").filter({ hasText: "native-image.png" })).toBeVisible();
    if (process.env.MODEL_CHAT_ADMIN_LIVE_TEST === "1") {
      const vision = available.find(item => item.vision);
      expect(vision).toBeTruthy();
      await page.getByRole("combobox", { name: "Select model" }).selectOption(vision!.id);
      await page.getByLabel("Message", { exact: true }).fill("Read the two-character label in the attached image. Reply with just those two characters.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      requests = 1;
      await expect(page.locator(".message.assistant").last()).toContainText("A7", { timeout: 120_000 });
      await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: 120_000 });
      expect(store.messages(realBob.id, chat.id).slice(0, 2)).toEqual(before);
      expect(store.messages(realBob.id, chat.id)).toHaveLength(4);
    }
    await page.getByLabel("Message", { exact: true }).fill("BOB_AFTER_ADMIN_DRAFT");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/admin-acting-mobile.png", fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Return to my workspace", exact: true }).click();
    await expect(page.locator(".acting-banner")).toHaveCount(0);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("ADMIN_OWN_UNSENT_DRAFT");
    expect(new URL(page.url()).searchParams.get("chat")).toBe(ownId);
    expect(store.chat(realBob.id, chat.id).draft).toBe("BOB_AFTER_ADMIN_DRAFT");
    expect(store.messages(realBob.id, chat.id).slice(0, 2)).toEqual(before);
    await page.reload();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("ADMIN_OWN_UNSENT_DRAFT");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page.getByRole("button", { name: "Users & audit", exact: true }).click();
    await page.getByRole("button", { name: "Audit log", exact: true }).click();
    const audit = page.locator(".audit-event").filter({ hasText: "chat.rename" }).first();
    await expect(audit).toContainText(realAdmin.id);
    await expect(audit).toContainText(realBob.id);
    await page.screenshot({ path: "test-results/admin-audit-desktop.png", fullPage: true, animations: "disabled" });
    const serialized = JSON.stringify(database.prepare("SELECT * FROM app_audit").all());
    for (const sensitive of ["BOB_PRIVATE_OLD_PROMPT", "BOB_PRIVATE_OLD_REPLY", "BOB_AFTER_ADMIN_DRAFT", "ADMIN_OWN_UNSENT_DRAFT"]) expect(serialized.includes(sensitive)).toBe(false);
    await page.getByRole("button", { name: "Users & chat sessions", exact: true }).click();
    await page.getByLabel("Search users by name or email").fill(bobEmail);
    await page.locator(".admin-user").filter({ hasText: bobEmail }).getByRole("button", { name: "Act as user", exact: true }).click();
    await expect(page.locator(".acting-banner")).toContainText(bobEmail);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("BOB_AFTER_ADMIN_DRAFT");
    roles.setRoleLocally(adminEmail, "user");
    await expect(page.locator(".acting-banner")).toHaveCount(0, { timeout: 10_000 });
    expect((await page.request.get("/api/admin/users")).status()).toBe(403);
    expect(store.chat(realAdmin.id, ownId).draft).toBe("ADMIN_OWN_UNSENT_DRAFT");
  } finally { database.close(); }
  return requests;
}
