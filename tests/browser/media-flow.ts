import { expect, type Page } from "@playwright/test";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export async function runMediaFlow(page: Page, other: Page) {
  let modelRequests = 0;
  const testDirectory = process.env.MODEL_CHAT_TEST_DATA_DIR;
  if (!testDirectory || !path.resolve(testDirectory).startsWith(path.resolve(".local") + path.sep) || !path.basename(testDirectory).startsWith("browser-test-")) {
    throw new Error("An isolated test directory is required for media browser testing.");
  }
  const previous = page.url();
  copyFileSync(path.resolve(".local", "media-config.json"), path.join(testDirectory, "media-config.json"));
  const fixtures = path.join(testDirectory, "media-fixtures");
  mkdirSync(fixtures);
  const speech = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.resolve("tests", "generate-speech.ps1")], {
    env: { ...process.env, MODEL_CHAT_MEDIA_FIXTURES: fixtures }, encoding: "utf8", timeout: 30_000,
  });
  expect(speech.status, speech.stderr).toBe(0);
  const encoded = spawnSync("python", [path.resolve("tests", "make-media-fixtures.py"), fixtures], { encoding: "utf8", timeout: 30_000 });
  expect(encoded.status, encoded.stderr).toBe(0);
  await page.getByRole("button", { name: "New conversation +", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(path.join(fixtures, "speech.wav"));
  await expect(page.locator(".file-chip").filter({ hasText: "speech.wav" })).toBeVisible({ timeout: 100_000 });
  await page.getByRole("button", { name: "Preview extracted text for speech.wav", exact: true }).click();
  await expect(page.locator(".extracted-text")).toContainText(/blue notebook/i);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(path.join(fixtures, "speech-video.mp4"));
  await expect(page.locator(".file-chip").filter({ hasText: "speech-video.mp4" })).toBeVisible({ timeout: 100_000 });
  await page.getByRole("button", { name: "Preview extracted text for speech-video.mp4", exact: true }).click();
  await expect(page.locator(".extracted-text")).toContainText(/blue notebook/i);
  await expect(page.locator(".extracted-text")).toContainText("Visual sampling only");
  await page.screenshot({ path: "test-results/local-video-transcript.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const chatId = new URL(page.url()).searchParams.get("chat");
  const detail = await (await page.request.get(`/api/chats/${chatId}`)).json();
  const video = detail.attachments.find((file: { name: string }) => file.name === "speech-video.mp4");
  expect(video.frameCount).toBeGreaterThanOrEqual(2);
  expect((await other.request.get(`/api/chats/${chatId}/files/${video.id}/extracted`)).status()).toBe(404);
  expect(detail.messages).toHaveLength(0);
  if (process.env.MODEL_CHAT_MEDIA_LIVE_TEST === "1") {
    const { models } = await (await page.request.get("/api/models")).json() as { models: { id: string; vision?: boolean }[] };
    const model = models.find(item => item.vision);
    expect(model).toBeTruthy();
    await page.getByRole("combobox", { name: "Select model" }).selectOption(model!.id);
    await page.getByLabel("Message", { exact: true }).fill("Using both attached recordings, state the notebook price and the dominant colors visible in the sampled video frames. Keep the answer to one short sentence.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    modelRequests = 1;
    await expect(page.locator(".message.assistant").last()).toContainText(/20|twenty/i, { timeout: 120_000 });
    await expect(page.locator(".message.assistant").last()).toContainText(/red/i, { timeout: 120_000 });
    await expect(page.locator(".message.assistant").last()).toContainText(/blue/i, { timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: 120_000 });
    await page.screenshot({ path: "test-results/local-video-ai-answer.png", fullPage: true, animations: "disabled" });
  }
  await page.reload();
  await expect(page.locator(".file-chip").filter({ hasText: "speech-video.mp4" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: "cancel.wav", mimeType: "audio/wav", buffer: readFileSync(path.join(fixtures, "speech.wav")) });
  await page.getByRole("button", { name: "Cancel upload", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel upload", exact: true })).toHaveCount(0);
  await expect(page.locator(".file-chip").filter({ hasText: "cancel.wav" })).toHaveCount(0);
  await page.goto(previous);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/Using sample-budget.csv/);
  return modelRequests;
}
