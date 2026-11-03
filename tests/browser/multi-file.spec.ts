import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import path from "node:path";
import Database from "better-sqlite3";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";
import { setTimeout as delay } from "node:timers/promises";

test("multiple mixed attachments transfer concurrently, survive reload, remove cleanly and submit together", async ({ page, browser }) => {
  test.setTimeout(240000);
  const origin = "http://127.0.0.1:3211";
  const email = `multi-${randomUUID()}@example.test`;
  let response = await page.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email, password: "Synthetic test-only pass! 5678" } });
  if (response.status() === 429) {
    await delay(61000); // The shared test server keeps the real five-signups-per-minute guard.
    response = await page.request.post("/api/auth/sign-up/email", { headers: { origin }, data: { email, password: "Synthetic test-only pass! 5678" } });
  }
  expect(response.status()).toBe(200);
  const owner = (await response.json()).user;
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Attach files", exact: true })).toBeEnabled();
  const red = await sharp({ create: { width: 80, height: 80, channels: 3, background: "red" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 80, height: 80, channels: 3, background: "blue" } }).png().toBuffer();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let holding = true;
  await page.route("**/parts/*", async route => { if (holding) await held; await route.continue(); });
  try {
    await page.getByLabel("Message", { exact: true }).fill("Use every attached file.");
    await page.locator('input[type="file"]').setInputFiles([
      { name: "red.png", mimeType: "image/png", buffer: red },
      { name: "blue.png", mimeType: "image/png", buffer: blue },
      ...["txt", "md", "csv", "json"].map(extension => ({ name: `mixed.${extension}`, mimeType: "text/plain", buffer: Buffer.from('{"value":42}') })),
      { name: "remove-before-upload.txt", mimeType: "text/plain", buffer: Buffer.from("Do not retain me.") },
    ]);
    await expect(page.locator('.transfer[data-active="true"]')).toHaveCount(3);
    await expect(page.getByRole("progressbar")).toHaveCount(7);
    await page.getByRole("button", { name: "Remove transfer remove-before-upload.txt", exact: true }).click();
    holding = false; release();
    await expect(page.locator(".transfer")).toHaveCount(0);
    await expect(page.locator(".file-job")).toHaveCount(6);
    for (const name of ["red.png", "blue.png", "mixed.txt", "mixed.md", "mixed.csv", "mixed.json"]) {
      await expect(page.getByRole("button", { name: `Preview extracted text for ${name}`, exact: true })).toBeEnabled();
    }
    const chatId = new URL(page.url()).searchParams.get("chat")!;
    const files = (await (await page.request.get(`/api/chats/${chatId}`)).json()).attachments;
    expect(files).toHaveLength(6);
    expect(files.some((file: { name: string }) => file.name === "remove-before-upload.txt")).toBe(false);
    await page.reload();
    await expect(page.locator(".file-job")).toHaveCount(6);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Use every attached file.");
    await page.locator('input[type="file"]').setInputFiles({ name: "extra.log", mimeType: "text/plain", buffer: Buffer.from("Extra.") });
    await expect(page.getByRole("button", { name: "Preview extracted text for extra.log", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Remove extra.log", exact: true }).click();
    await expect(page.locator(".file-job")).toHaveCount(6);
    const dropped = await page.evaluateHandle(() => {
      const data = new DataTransfer(); data.items.add(new File(["Dropped text"], "drop.txt", { type: "text/plain" })); return data;
    });
    await page.locator(".composer").dispatchEvent("drop", { dataTransfer: dropped });
    await dropped.dispose();
    await expect(page.getByRole("button", { name: "Preview extracted text for drop.txt", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Remove drop.txt", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).evaluate((element, bytes) => {
      const data = new DataTransfer(); data.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, [...red]);
    await expect(page.getByRole("button", { name: "Preview extracted text for paste.png", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Remove paste.png", exact: true }).click();
    await expect(page.locator(".file-job")).toHaveCount(6);
    const models = (await (await page.request.get("/api/models")).json()).models as { id: string; maxImages?: number; vision?: boolean }[];
    const oneImage = models.find(model => model.vision && model.maxImages === 1);
    expect(oneImage).toBeTruthy();
    await page.getByRole("combobox", { name: "Select model" }).selectOption(oneImage!.id);
    await expect(page.locator(".file-guidance")).toContainText("1 additional Copilot request");
    await page.screenshot({ path: "test-results/multi-file-desktop.png", fullPage: true, animations: "disabled" });
    const submissions: { fileIds: string[] }[] = [];
    await page.route("**/messages", async route => {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Synthetic test stops before billable generation." }) });
    });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator(".notice")).toContainText("Synthetic test stops");
    expect(submissions).toHaveLength(1);
    expect(new Set(submissions[0].fileIds)).toEqual(new Set(files.map((file: { id: string }) => file.id)));
    await page.locator('input[type="file"]').setInputFiles({ name: "failed.txt", mimeType: "text/plain", buffer: Buffer.from([0, 1, 2]) });
    await expect(page.locator(".file-job").filter({ hasText: "failed.txt" })).toContainText("binary");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.locator(".notice")).toContainText("Nothing was sent");
    expect(submissions).toHaveLength(1);
    await page.getByRole("button", { name: "Send text only", exact: true }).click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1].fileIds).toEqual([]);
    await page.getByRole("button", { name: "Remove failed.txt", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/multi-file-mobile.png", fullPage: true, animations: "disabled" });
    const other = await browser.newContext();
    try {
      const credentials = { email: `multi-${randomUUID()}@example.test`, password: "Another synthetic password! 6748" };
      let signup = await other.request.post(origin + "/api/auth/sign-up/email", { headers: { origin }, data: credentials });
      if (signup.status() === 429) {
        await delay(61000); // Keep the real five-signups-per-minute guard enabled across the shared test server.
        signup = await other.request.post(origin + "/api/auth/sign-up/email", { headers: { origin }, data: credentials });
      }
      expect(signup.status()).toBe(200);
      const admin = (await signup.json()).user;
      expect((await other.request.get(origin + `/api/chats/${chatId}`)).status()).toBe(404);
      for (const file of files) expect((await other.request.get(origin + `/api/chats/${chatId}/files/${file.id}/extracted`)).status()).toBe(404);
      const directory = process.env.MODEL_CHAT_TEST_DATA_DIR!;
      expect(path.basename(directory)).toMatch(/^browser-test-/);
      const db = new Database(path.join(directory, "model-chat.db"));
      try { new AccessService(new Store(db)).setRoleLocally(admin.email, "superuser"); } finally { db.close(); }
      expect((await other.request.post(origin + "/api/admin/acting", { headers: { origin }, data: { userId: owner.id, chatId } })).status()).toBe(200);
      expect((await (await other.request.get(origin + `/api/chats/${chatId}`)).json()).attachments).toHaveLength(6);
      expect((await other.request.post(origin + "/api/admin/stop", { headers: { origin }, data: {} })).status()).toBe(200);
      expect((await other.request.get(origin + `/api/chats/${chatId}`)).status()).toBe(404);
    } finally { await other.close(); }
  } finally { holding = false; release(); }
});
