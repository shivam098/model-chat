import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";
import { totp } from "../totp";

const password = "Test-only password! 48291";
const shots = process.env.CODING_SCREENS_DIR;
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}
async function signIn(page: Page, email: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function signOut(page: Page) {
  await page.getByRole("button", { name: /Account & connection/ }).first().click();
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

test("two-step verification: superuser turns it on, signs in with a code or a backup code, and turns it off", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const email = `owner-${randomUUID()}@example.test`;
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start with a question or a file" })).toBeVisible();
  expect((await page.request.post("/api/auth/two-factor/enable", { headers: { origin: "http://127.0.0.1:3211" }, data: { password } })).status(), "Ordinary accounts can't turn it on").toBe(403);
  const db = new Database(path.join(process.env.MODEL_CHAT_TEST_DATA_DIR!, "model-chat.db"));
  try { new AccessService(new Store(db)).setRoleLocally(email, "superuser"); } finally { db.close(); }
  await page.reload();

  await page.getByRole("button", { name: /Account & connection/ }).first().click();
  const settings = page.getByRole("dialog", { name: "Account & connection" });
  await settings.getByRole("button", { name: "Turn on two-step verification" }).click();
  await settings.getByLabel("Your Model Chat password").fill(password);
  await settings.getByRole("button", { name: "Continue" }).click();
  const key = settings.getByLabel("Setup key");
  await expect(key).toBeVisible();
  await key.scrollIntoViewIfNeeded();
  await shot(page, "21-two-factor-setup-key");
  const secret = (await key.innerText()).replace(/\s/g, "");
  await settings.getByLabel("Then enter the 6-digit code it shows").fill(totp(secret));
  await settings.getByRole("button", { name: "Turn on", exact: true }).click();
  const codes = settings.locator(".backup-codes code");
  await expect(codes).toHaveCount(10);
  const backup = await codes.first().innerText();
  await shot(page, "22-two-factor-backup-codes");
  await settings.getByRole("button", { name: "Done" }).click();
  await expect(settings.getByText(/Two-step verification is on/)).toBeVisible();
  await settings.getByRole("button", { name: "Close dialog" }).click();

  await signOut(page);
  await signIn(page, email);
  await expect(page.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  await shot(page, "23-sign-in-code-step");
  const wrong = String((Number(totp(secret)) + 500_000) % 1_000_000).padStart(6, "0");
  await page.getByLabel("Authentication code").fill(wrong);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.locator(".auth-error")).toBeVisible();
  await page.getByLabel("Authentication code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Start with a question or a file" })).toBeVisible();
  const status = await (await page.request.get("/api/code/status")).json();
  expect(status.secondFactorVerified).toBe(true);

  await signOut(page);
  await signIn(page, email);
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(backup);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Start with a question or a file" })).toBeVisible();

  await page.getByRole("button", { name: /Account & connection/ }).first().click();
  await settings.getByRole("button", { name: "Turn off two-step verification" }).click();
  await settings.getByLabel("Your Model Chat password").fill(password);
  await settings.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(settings.getByText(/Two-step verification is off/)).toBeVisible();
  await settings.getByRole("button", { name: "Close dialog" }).click();
  await signOut(page);
  await signIn(page, email);
  await expect(page.getByRole("heading", { name: "Start with a question or a file" }), "A password alone works again once it's off").toBeVisible();
  expect(errors).toEqual([]);
});
