import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { runAdminFlow } from "./admin-flow";
import type { DictationEvent } from "../../lib/voice";

const origin = "http://127.0.0.1:3211";
const password = "Test-only password! 48291";
const email = `modelchat-${randomUUID()}@example.test`;
async function signUp(page: Page, address: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an account", exact: true }).click();
  await expect(page.locator(".auth-card input")).toHaveCount(2);
  await expect(page.getByText(/No OTP or verification email/)).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What's on your mind?" })).toBeVisible();
}
test("accounts, ownership, files, histories, password validation and responsive UI", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await signUp(page, email);
  await expect(page.getByRole("button", { name: "Attach files", exact: true })).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles({ name: "project-notes.txt", mimeType: "application/x-untrusted", buffer: Buffer.from("Project Birch. Revenue is 42.") });
  await expect(page.locator(".file-chip").filter({ hasText: "project-notes.txt" })).toBeVisible();
  const chatId = new URL(page.url()).searchParams.get("chat")!;
  const detailResponse = await page.request.get(`/api/chats/${chatId}`);
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json();
  const fileId = detail.attachments[0].id;
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find(cookie => cookie.name.includes("session_token"))!;
  expect(sessionCookie.httpOnly).toBe(true);
  expect(sessionCookie.sameSite).toBe("Strict");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  const download = await page.request.get(`/api/chats/${chatId}/files/${fileId}`);
  expect(await download.text()).toBe("Project Birch. Revenue is 42.");
  expect(download.headers()["content-disposition"]).toContain("attachment;");

  await page.getByRole("button", { name: "Rename New chat", exact: true }).click();
  await page.getByLabel("Conversation name").fill("My private workspace");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("button", { name: "My private workspace", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator(".file-chip").filter({ hasText: "project-notes.txt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "My private workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Select model" })).toBeEnabled();
  await page.screenshot({ path: "test-results/chat-desktop.png", fullPage: true, animations: "disabled" });

  const other = await browser.newContext();
  const bob = await other.newPage();
  const bobEmail = `modelchat-${randomUUID()}@example.test`;
  await signUp(bob, bobEmail);
  await expect(bob.getByRole("button", { name: "My private workspace", exact: true })).toHaveCount(0);
  for (const [method, resource, data] of [
    ["GET", `/api/chats/${chatId}`, undefined],
    ["PATCH", `/api/chats/${chatId}`, { title: "stolen" }],
    ["DELETE", `/api/chats/${chatId}`, undefined],
    ["POST", `/api/chats/${chatId}/messages`, { content: "steal", model: "any" }],
    ["POST", `/api/chats/${chatId}/stop`, undefined],
    ["GET", `/api/chats/${chatId}/files/${fileId}`, undefined],
    ["DELETE", `/api/chats/${chatId}/files/${fileId}`, undefined],
    ["POST", `/api/chats/${chatId}/files`, undefined],
  ] as const) {
    const response = await bob.request.fetch(resource, { method, data, headers: { origin } });
    expect(response.status(), resource).toBe(404);
  }
  const rejected = await page.request.post("/api/chats", { headers: { origin: "http://evil.example" } });
  expect(rejected.status()).toBe(403);
  const noOrigin = await page.request.post("/api/chats");
  expect(noOrigin.status()).toBe(403);
  expect((await page.request.get("/api/chats", { headers: { "sec-fetch-site": "cross-site" } })).status()).toBe(403);
  expect((await page.request.get("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).status()).toBe(200);
  const binary = await page.request.post(`/api/chats/${chatId}/files`, { headers: { origin, "x-file-name": "bad.txt" }, data: Buffer.from([0, 1, 2]) });
  expect(binary.status()).toBe(422);
  const executable = await page.request.post(`/api/chats/${chatId}/files`, { headers: { origin, "x-file-name": "run.exe" }, data: "exe" });
  expect(executable.status()).toBe(415);
  const tooLarge = await page.request.post(`/api/chats/${chatId}/files`, { headers: { origin, "x-file-name": "large.txt" }, data: Buffer.alloc(5 * 1024 * 1024 + 1) });
  expect(tooLarge.status()).toBe(413);
  let modelRequests = 0;
  page.on("request", request => { if (/\/messages$/.test(new URL(request.url()).pathname)) modelRequests++; });
  await page.getByLabel("Message", { exact: true }).fill("Keep this draft and the attached file.");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "How Model Chat works & Demos", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Nothing is sent to a model until you press Send");
  await page.screenshot({ path: "test-results/demos-desktop.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Load Explore a sample budget", exact: true }).click();
  await expect(page.locator(".file-chip").filter({ hasText: "sample-budget.csv" })).toBeVisible();
  const demoId = new URL(page.url()).searchParams.get("chat");
  expect(demoId).not.toBe(chatId);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/Using sample-budget.csv/);
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  const original = await (await page.request.get(`/api/chats/${chatId}`)).json();
  expect(original.chat.draft).toBe("Keep this draft and the attached file.");
  expect(original.attachments[0].id).toBe(fileId);
  expect((await bob.request.get(`/api/chats/${demoId}`)).status()).toBe(404);
  expect((await bob.request.post("/api/demos", { headers: { origin }, data: { demoId: "writing", previous: { chatId, draft: "stolen" } } })).status()).toBe(404);
  await page.reload();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/Using sample-budget.csv/);
  expect(modelRequests).toBe(0);
  const explicitRequests = await runAdminFlow(page, bob, email, bobEmail);
  await other.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "How Model Chat works & Demos", exact: true }).click();
  await page.screenshot({ path: "test-results/demos-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Load Draft a friendly update", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/Write a friendly project-update email/);
  const writingId = new URL(page.url()).searchParams.get("chat");
  expect(writingId).not.toBe(demoId);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "How Model Chat works & Demos", exact: true }).click();
  await page.getByRole("button", { name: "Load Make a concept click", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(/Explain why a password/);
  expect(new URL(page.url()).searchParams.get("chat")).not.toBe(writingId);
  expect(modelRequests).toBe(explicitRequests);
  await page.screenshot({ path: "test-results/chat-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: /Account & connection/ }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect((await page.request.get(`/api/chats/${chatId}`)).status()).toBe(401);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".auth-error")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What's on your mind?" })).toBeVisible();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "My private workspace", exact: true }).click();
  await expect(page.locator(".file-chip").filter({ hasText: "project-notes.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Remove project-notes.txt" }).click();
  await expect(page.locator(".file-chip").filter({ hasText: "project-notes.txt" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "Delete My private workspace", exact: true }).click();
  await page.getByRole("button", { name: "Delete conversation", exact: true }).click();
  expect((await page.request.get(`/api/chats/${chatId}`)).status()).toBe(404);
  expect(errors).toEqual([]);
});
test("browser unsupported voice and denied microphone retain fully working text input", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
  });
  const page = await context.newPage();
  await signUp(page, `voice-${randomUUID()}@example.test`);
  await expect(page.getByRole("button", { name: "Dictate", exact: true })).toBeDisabled();
  await page.getByLabel("Message", { exact: true }).fill("Typing still works.");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Typing still works.");
  await page.addInitScript(() => {
    class Recognition {
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() { setTimeout(() => this.onerror?.({ error: "not-allowed" }), 10); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: Recognition, configurable: true });
  });
  await page.reload();
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("browser may send audio");
  await page.getByRole("button", { name: "I understand" }).click();
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.locator(".notice")).toContainText("Microphone access was denied");
  await page.getByLabel("Message", { exact: true }).fill("Still able to type.");
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Still able to type.");
  await page.evaluate(() => {
    class Recognition {
      onresult: ((event: DictationEvent) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        Object.defineProperty(window, "injectLateTranscript", {
          configurable: true,
          value: () => this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: "LATE_PRIVATE_TRANSCRIPT" } } } }),
        });
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.defineProperty(window, "SpeechRecognition", { value: Recognition, configurable: true });
  });
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await page.getByRole("button", { name: "New conversation +", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await page.evaluate(() => {
    const inject = (window as Window & { injectLateTranscript?: () => void }).injectLateTranscript;
    if (!inject) throw new Error("The synthetic dictation callback was not registered.");
    inject();
  });
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
  await context.close();
});
test("live Copilot streaming and switched-model file context", async ({ page }) => {
  test.skip(process.env.MODEL_CHAT_LIVE_TEST !== "1", "Opt in to two small real Copilot requests.");
  test.setTimeout(240_000);
  await signUp(page, `live-${randomUUID()}@example.test`);
  const response = await page.request.get("/api/models");
  expect(response.status(), await response.text()).toBe(200);
  const { models } = await response.json() as { models: { id: string; multiplier?: number }[] };
  const choices = models.filter(m => m.id !== "auto").sort((a, b) => (a.multiplier ?? 1) - (b.multiplier ?? 1));
  expect(choices.length).toBeGreaterThan(1);
  await expect(page.getByRole("combobox", { name: "Select model" })).toBeEnabled();
  await page.getByRole("combobox", { name: "Select model" }).selectOption(choices[0].id);
  await page.locator('input[type="file"]').setInputFiles({ name: "sample.txt", mimeType: "text/plain", buffer: Buffer.from("The project's code word is BIRCH42.") });
  await expect(page.locator(".file-chip").filter({ hasText: "sample.txt" })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("What is the code word in the file? Answer in one short sentence.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop reply" })).toBeVisible();
  await expect(page.locator(".message.assistant").last()).toContainText("BIRCH42", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: 120_000 });
  await page.reload();
  await expect(page.locator(".message.assistant")).toContainText("BIRCH42");
  await expect(page.getByRole("combobox", { name: "Select model" })).toBeEnabled();
  await page.getByRole("combobox", { name: "Select model" }).selectOption(choices[1].id);
  await page.getByLabel("Message", { exact: true }).fill("Using the same file and earlier conversation, repeat that code word only.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator(".message.assistant").last()).toContainText("BIRCH42", { timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Stop reply" })).toHaveCount(0, { timeout: 120_000 });
  const id = new URL(page.url()).searchParams.get("chat");
  const detail = await (await page.request.get(`/api/chats/${id}`)).json();
  expect(detail.messages).toHaveLength(4);
  expect(detail.messages[1].model).not.toBe(detail.messages[3].model);
  expect(detail.messages[3].status).toBe("complete");
  await page.screenshot({ path: "test-results/live-conversation.png", fullPage: true });
});
test("missing Copilot access is explicit and never yields a fake answer", async ({ page }) => {
  await page.route("**/api/models*", route => route.fulfill({
    status: 503, contentType: "application/json",
    body: JSON.stringify({ error: "No usable Copilot sign-in was found. Run npm run copilot:login." }),
  }));
  await signUp(page, `offline-${randomUUID()}@example.test`);
  await expect(page.locator(".connection-banner")).toContainText("No usable Copilot sign-in");
  await page.getByLabel("Message", { exact: true }).fill("Are you connected?");
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  await page.getByRole("button", { name: "Files & privacy" }).click();
  await expect(page.getByRole("dialog")).toContainText("npm run copilot:login");
});
