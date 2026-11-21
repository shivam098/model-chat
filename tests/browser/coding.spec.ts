import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";
import { selectModel } from "./helpers";

// One real Copilot turn that runs commands on this computer, so it's opt-in.
test.skip(process.env.MODEL_CHAT_CODING_E2E !== "1", "Set MODEL_CHAT_CODING_E2E=1 and MODEL_CHAT_PROJECTS_DIR to run the real coding-mode flow.");

const password = "Test-only password! 48291";
const shots = process.env.CODING_SCREENS_DIR;
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
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
const freePort = () => new Promise<number>(resolve => { const server = net.createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
const isUp = async (port: number) => { try { return (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch { return false; } };

test("coding mode from this computer's browser: approvals, deny, diffs, live preview, stop and refusals", async ({ page, browser }) => {
  test.setTimeout(15 * 60_000);
  const projects = process.env.MODEL_CHAT_PROJECTS_DIR;
  const data = process.env.MODEL_CHAT_TEST_DATA_DIR;
  if (!projects || !data) throw new Error("MODEL_CHAT_PROJECTS_DIR and an isolated test data directory are required.");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const email = `coder-${randomUUID()}@example.test`;
  await signUp(page, email);
  await expect(page.getByRole("group", { name: "Mode" }), "Ordinary accounts never see coding mode").toHaveCount(0);
  expect((await page.request.get("/api/code/projects")).status()).toBe(403);

  const db = new Database(path.join(data, "model-chat.db"));
  try { new AccessService(new Store(db)).setRoleLocally(email, "superuser"); } finally { db.close(); }
  await page.reload();
  const mode = page.getByRole("group", { name: "Mode" });
  await expect(mode).toBeVisible();
  await shot(page, "01-composer-chat-code-switch");
  await mode.getByRole("button", { name: "Code" }).click();
  const picker = page.getByRole("dialog", { name: "Open a project" });
  await expect(picker).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "02-project-picker");
  await picker.getByLabel("New project").fill("counter-app");
  await picker.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Code in counter-app" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach files" }), "Coding chats work on the folder, not uploads").toHaveCount(0);
  const project = path.join(projects, "counter-app");
  writeFileSync(path.join(project, "keep.txt"), "keep me\n");
  const port = await freePort();
  const models = (await (await page.request.get("/api/models")).json()).models as { id: string }[];
  const model = models.find(item => item.id === process.env.MODEL_CHAT_CODING_MODEL)?.id || models[0].id;
  await selectModel(page, model);
  await shot(page, "03-code-chat-new");

  let serverPid: number | null = null;
  try {
    await page.getByLabel("Message", { exact: true }).fill(`In this project: 1) Create index.html with a heading "Counter" and a button that counts clicks, and server.js, a tiny Node http server with no packages that serves index.html on 127.0.0.1:${port}. 2) Delete keep.txt with a shell command; if that is denied, don't retry it. 3) Start the server in the background so it keeps running, then tell me its URL.`);
    await page.getByRole("button", { name: "Send message" }).click();
    const decisions: string[] = [];
    let approvalShot = false;
    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline) {
      const asking = page.locator(".code-card.asking").first();
      if (await asking.count()) {
        const text = await asking.innerText();
        if (!approvalShot) { await asking.scrollIntoViewIfNeeded(); await shot(page, "04-approval-card"); approvalShot = true; }
        const deny = /keep\.txt/i.test(text);
        await asking.getByRole("button", { name: deny ? "Deny" : "Allow once" }).click();
        decisions.push(deny ? "deny" : "once");
        await page.waitForTimeout(700);
        continue;
      }
      if (await page.getByRole("button", { name: "Send message" }).count()) break;
      await page.waitForTimeout(500);
    }
    expect(decisions, "The flow reached a decision to deny").toContain("deny");
    expect(existsSync(path.join(project, "keep.txt")), "Denied deletion left the file alone").toBe(true);
    expect(readFileSync(path.join(project, "index.html"), "utf8")).toMatch(/Counter/);
    await expect(page.locator(".code-status.denied").first()).toBeVisible();
    await expect(page.locator(".message.assistant .markdown").last()).not.toBeEmpty();
    await expect.poll(() => isUp(port), { timeout: 30_000 }).toBe(true);
    await shot(page, "05-reply-with-command-and-file-cards");

    await page.getByRole("button", { name: "Workspace" }).click();
    const panel = page.getByRole("complementary", { name: "Project workspace" });
    await expect(panel.locator(".code-diff").first()).toBeVisible();
    await expect(panel.locator(".code-diff .add").first()).toBeVisible();
    await shot(page, "06-workspace-changes-diffs");
    await panel.getByRole("tab", { name: /Terminal/ }).click();
    await shot(page, "07-workspace-terminal");
    await panel.getByRole("tab", { name: "Preview" }).click();
    await panel.getByLabel("Dev server port").fill(String(port));
    await panel.getByRole("button", { name: "Open preview" }).click();
    const frame = page.frameLocator(".preview-frame");
    await expect(frame.getByRole("heading", { name: /Counter/ })).toBeVisible({ timeout: 20_000 });
    await frame.getByRole("button").first().click();
    await shot(page, "08-workspace-live-preview");
    const preview = page.frames().find(item => /^http:\/\/p-[0-9a-f]{48}\.localhost:/.test(item.url()));
    expect(preview, "The preview runs on its own private origin").toBeTruthy();
    const fromPreview = await preview!.evaluate(async () => {
      try { return (await fetch("http://127.0.0.1:3211/api/account", { credentials: "include" })).status; } catch { return "blocked"; }
    });
    expect(fromPreview, "Previewed code can't use the app's session").not.toBe(200);

    await panel.getByRole("tab", { name: "Processes" }).click();
    const running = panel.locator(".panel-item").filter({ hasText: "server" }).first();
    await expect(running.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });
    const processes = await (await page.request.get(`/api/code/chats/${new URL(page.url()).searchParams.get("chat")}/processes`)).json();
    serverPid = processes.processes.find((item: { status: string; pid: number | null }) => item.status === "running")?.pid ?? null;
    await shot(page, "09-workspace-processes");
    await running.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => isUp(port), { timeout: 20_000 }).toBe(false);
    serverPid = null;

    await page.reload();
    await expect(page.locator(".code-card").first()).toBeVisible();
    await expect(page.locator(".code-status.denied").first()).toBeVisible();
    await shot(page, "10-reopened-history");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await shot(page, "11-mobile-code-chat");
    await page.getByRole("button", { name: "Workspace" }).click();
    await page.getByRole("tab", { name: /Changes/ }).click();
    await shot(page, "12-mobile-workspace-panel");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Never while acting as another user.
    const other = await browser.newPage();
    const otherEmail = `other-${randomUUID()}@example.test`;
    await signUp(other, otherEmail);
    const otherId = (await (await other.request.get("/api/account")).json()).user.id;
    await other.close();
    await page.goto("/");
    expect((await page.request.post("/api/admin/acting", { headers: { origin: "http://127.0.0.1:3211" }, data: { userId: otherId } })).status()).toBe(200);
    expect((await page.request.get("/api/code/projects")).status()).toBe(403);
    await page.reload();
    await expect(page.getByText(/Acting as/).first()).toBeVisible();
    await expect(page.getByRole("group", { name: "Mode" })).toHaveCount(0);
    expect((await page.request.post("/api/admin/stop", { headers: { origin: "http://127.0.0.1:3211" }, data: {} })).status()).toBe(200);
    expect(errors).toEqual([]);
  } finally {
    if (serverPid) { try { process.kill(serverPid); } catch { /* Already stopped. */ } }
  }
});
