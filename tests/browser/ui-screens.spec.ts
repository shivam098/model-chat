import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import { Store } from "../../lib/store";
import { AccessService } from "../../lib/access";
import { UploadStore } from "../../lib/upload-store";
import { detectOutput } from "../../lib/code-tool";
import { runSandbox } from "../../lib/sandbox";

// Captures every screen at desktop and mobile size for visual review, with seeded synthetic data and no model calls.
// Run: $env:UI_SCREENS_DIR = "<folder>"; npx playwright test tests/browser/ui-screens.spec.ts
const shots = process.env.UI_SCREENS_DIR;
test.skip(!shots, "Set UI_SCREENS_DIR to capture screens.");
const origin = "http://127.0.0.1:3211";
const desktop = { width: 1440, height: 900 };
const mobile = { width: 390, height: 844 };
const budgetCsv = "category,planned,actual\nGroceries,320,355\nTransport,120,95\nBooks,80,50\nEntertainment,100,145\n";

async function capture(page: Page, name: string, prepare?: () => Promise<void>) {
  mkdirSync(shots!, { recursive: true });
  for (const [label, size] of [["desktop", desktop], ["mobile", mobile]] as const) {
    await page.setViewportSize(size);
    if (prepare) await prepare();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots!, `${name}-${label}.png`), fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize(desktop);
}
async function signup(request: APIRequestContext, email: string) {
  const data = { email, password: "Synthetic screen pass 7781" };
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
async function openMenuItem(page: Page, item: string) {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: item, exact: true }).click();
}
const closeDialog = (page: Page) => page.getByRole("button", { name: "Close dialog" }).last().click();

test("capture every screen for design review", async ({ page, browser }) => {
  test.setTimeout(900_000);
  const directory = process.env.MODEL_CHAT_TEST_DATA_DIR!;
  const sandbox = existsSync(path.resolve(".local", "sandbox-config.json"));
  if (sandbox) copyFileSync(path.resolve(".local", "sandbox-config.json"), path.join(directory, "sandbox-config.json"));

  await page.setViewportSize(desktop);
  // The isolated test runtime has no Copilot sign-in; show a realistic model list so screens look as users see them.
  const models = [
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", vision: true, multiplier: 1, maxImages: 20, levels: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-6-sol", name: "GPT-6 Sol", vision: true, multiplier: 1, maxImages: 10, levels: ["none", "low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", vision: true, multiplier: 0.33, maxImages: 20, levels: ["low", "medium", "high", "xhigh", "max"] },
  ];
  await page.route("**/api/models", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models, authenticated: true }) }));
  const [modelA, modelB] = [models[0].id, models[1].id];
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await capture(page, "01-sign-in");
  await page.getByRole("button", { name: "Create an account" }).click();
  await capture(page, "02-sign-up");

  const owner = await signup(page.request, `ana.ruiz-${randomUUID().slice(0, 4)}@example.test`);
  await page.goto("/");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await capture(page, "03-empty-chat");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.screenshot({ path: path.join(shots!, "03b-collapsed-sidebar-desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Expand sidebar" }).click();

  const outputs = sandbox ? await runSandbox(`
import numpy as np, matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter, FFMpegWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
cats = ['Groceries', 'Transport', 'Books', 'Entertainment']; planned = [320, 120, 80, 100]; actual = [355, 95, 50, 145]
x = np.arange(len(cats)); fig, ax = plt.subplots(figsize=(6.4, 3.6))
ax.bar(x - 0.2, planned, 0.4, label='Planned'); ax.bar(x + 0.2, actual, 0.4, label='Actual')
ax.set_xticks(x, cats); ax.set_ylabel('USD'); ax.set_title('March budget: planned vs actual'); ax.legend(); fig.tight_layout()
fig.savefig('/work/output/budget-chart.png', dpi=150); plt.close(fig)
weeks = np.arange(1, 5); spend = np.array([140, 310, 470, 645])
fig, ax = plt.subplots(figsize=(4.8, 3)); line, = ax.plot([], [], marker='o'); ax.set_xlim(1, 4); ax.set_ylim(0, 700)
ax.set_xlabel('Week'); ax.set_ylabel('Cumulative spend (USD)'); ax.set_title('Spending through March'); fig.tight_layout()
def frame(i): line.set_data(weeks[:i + 1], spend[:i + 1])
animation = FuncAnimation(fig, frame, frames=4)
animation.save('/work/output/spending.gif', writer=PillowWriter(fps=2))
animation.save('/work/output/spending.mp4', writer=FFMpegWriter(fps=2, codec='libx264', extra_args=['-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '2']))
pdf = canvas.Canvas('/work/output/budget-summary.pdf', pagesize=A4); pdf.setFont('Helvetica-Bold', 16); pdf.drawString(72, 770, 'March budget summary')
pdf.setFont('Helvetica', 11); pdf.drawString(72, 744, 'Planned 620 USD, actual 645 USD, 25 USD over plan.'); pdf.drawString(72, 726, 'Biggest overrun: Entertainment, 45 USD over.'); pdf.save()
`, [], { signal: new AbortController().signal }) : null;
  if (outputs) expect(outputs.status, outputs.stderr).toBe("ok");

  const seeded = withStore((store, db) => {
    const access = new AccessService(store);
    const session = db.prepare("SELECT id FROM session WHERE userId=?").get(owner.id) as { id: string };
    const own = access.resolve(owner.id, session.id);
    const chat = store.createChat(owner.id);
    store.renameChat(owner.id, chat.id, "March budget review");
    const csv = store.addFile(owner.id, chat.id, "sample-budget.csv", Buffer.from(budgetCsv), budgetCsv, "CSV, 4 rows", "text/csv");
    const first = store.beginTurn(owner.id, chat.id, "Using sample-budget.csv, compare planned and actual spending. Which category went furthest over?", modelA, [csv.id]);
    store.saveReply(owner.id, chat.id, first.assistant.id, [
      "You planned **620 USD** and spent **645 USD**, so March came in 25 USD over plan.",
      "",
      "| Category | Planned | Actual | Difference |",
      "| --- | ---: | ---: | ---: |",
      "| Groceries | 320 | 355 | +35 |",
      "| Transport | 120 | 95 | −25 |",
      "| Books | 80 | 50 | −30 |",
      "| Entertainment | 100 | 145 | +45 |",
      "",
      "**Entertainment** went furthest over, by 45 USD. Groceries was also 35 USD over, while transport and books came in under plan.",
      "",
      "One practical adjustment: move 30 USD of the unused books budget to groceries next month, and set a 110 USD cap on entertainment.",
    ].join("\n"), "complete", null, "**Comparing each row**\n\nPlanned totals 620 and actual totals 645, so the month is 25 over. Entertainment is +45 and groceries +35, so entertainment is the largest overrun.",
    [{ url: "https://www.consumerfinance.gov/consumer-tools/budgeting/", title: "Budgeting: How to create a budget and stick with it", cited: true }, { url: "https://www.investopedia.com/terms/b/budget.asp", title: "Budget: What It Is and How to Create One" }]);
    const second = store.beginTurn(owner.id, chat.id, "Make a bar chart of planned vs actual, a one-page PDF summary, and an animation of spending through the month.", modelB, []);
    const uploads = new UploadStore(store);
    for (const output of outputs?.files ?? []) {
      const detected = detectOutput(output.name, output.bytes);
      if ("blocked" in detected) continue;
      uploads.storeGenerated(own, chat.id, second.assistant.id, { name: output.name, extension: detected.extension, bytes: output.bytes, mimeType: detected.mimeType, text: "[Generated]", notes: "Generated by the code runner" });
    }
    store.saveReply(owner.id, chat.id, second.assistant.id, "Here are the files. The chart compares planned and actual spending for each category, the PDF summarises the totals and the biggest overrun, and the animation shows cumulative spending week by week.\n\n```python\nplanned = [320, 120, 80, 100]\nactual = [355, 95, 50, 145]\nprint(sum(actual) - sum(planned))  # 25\n```", "complete");

    const streaming = store.createChat(owner.id);
    store.renameChat(owner.id, streaming.id, "Weekend trip plan");
    const live = store.beginTurn(owner.id, streaming.id, "Plan a relaxed two-day trip to Lisbon for two people, with one museum and one viewpoint each day.", modelA, []);
    store.saveReply(owner.id, streaming.id, live.assistant.id, "## Day 1: Baixa and Alfama\n\n- **Morning:** walk from Praça do Comércio up to the Sé cathedral.\n- **Museum:** the National Tile Museum, about two hours.\n- **Viewpoint:** Miradouro de Santa Luzia before sunset.\n\n## Day 2: Belém\n\n- **Morning:** Jerónimos Monastery", "streaming", null,
      "**Pacing two relaxed days**\n\nThe user wants one museum and one viewpoint per day, so I should group sights by area to avoid long transfers. Alfama and Baixa are walkable together, and Belém is a short tram ride west, which makes a natural second day.\n\n**Choosing the stops**\n\nThe Tile Museum fits day one; Jerónimos and the Belém Tower fit day two. Santa Luzia works for sunset on day one.");
    return { chat: chat.id, streaming: streaming.id };
  });

  await page.goto(`/?chat=${seeded.chat}`);
  await expect(page.locator(".message.assistant").first()).toContainText("Entertainment");
  await page.locator(".message.assistant").first().getByRole("button", { name: "Show thinking" }).click();
  await capture(page, "04-conversation", async () => { await page.locator(".conversation").evaluate(node => { node.scrollTop = 0; }); });
  await capture(page, "04b-conversation-sources", async () => { await page.locator(".web-sources").first().evaluate(node => node.scrollIntoView({ block: "center" })); });
  if (outputs) {
    await expect.poll(() => page.locator("img.generated-preview").evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await capture(page, "05-generated-files", async () => { await page.locator("img.generated-preview").first().scrollIntoViewIfNeeded(); await page.locator(".conversation").evaluate(node => { node.scrollTop -= 160; }); });
    await capture(page, "05b-generated-files-pdf-and-video", async () => {
      for (let pass = 0; pass < 2; pass++) { await page.locator(".exhibit-pdf").evaluate(node => node.scrollIntoView({ block: "center" })); await page.waitForTimeout(600); }
    });
  }

  await page.goto("/");
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Draft a short note to the family about next month's budget.");
  const receipt = await sharp({ create: { width: 480, height: 320, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg width="480" height="320"><text x="32" y="70" font-size="30" font-family="Arial">Grocery receipt</text><text x="32" y="130" font-size="22" font-family="Arial">Total 42.80 USD</text></svg>') }]).png().toBuffer();
  await page.locator('input[type="file"]').setInputFiles([
    { name: "sample-budget.csv", mimeType: "text/csv", buffer: Buffer.from(budgetCsv) },
    { name: "grocery-receipt.png", mimeType: "image/png", buffer: receipt },
  ]);
  await expect(page.getByRole("button", { name: "Preview extracted text for sample-budget.csv", exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Preview extracted text for grocery-receipt.png", exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator(".composer-caption")).toContainText("Draft saved");
  await capture(page, "06-attachments");
  await page.getByRole("button", { name: "Preview extracted text for sample-budget.csv", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Groceries");
  await capture(page, "07-file-text-preview");
  await closeDialog(page);

  await page.goto(`/?chat=${seeded.streaming}`);
  await expect(page.getByRole("button", { name: "Stop reply" })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Also suggest one place for dinner each night.");
  await page.locator(".message.assistant").last().getByRole("button", { name: "Show thinking" }).click();
  await expect(page.locator(".reasoning")).toContainText("Pacing two relaxed days");
  await capture(page, "08-streaming-reply");
  withStore(store => {
    const reply = store.messages(owner.id, seeded.streaming).at(-1)!;
    store.saveReply(owner.id, seeded.streaming, reply.id, reply.content + " and the riverside walk to the Belém Tower.", "complete");
  });

  const sam = await browser.newContext({ baseURL: origin });
  try {
    const samUser = await signup(sam.request, `sam.okafor-${randomUUID().slice(0, 4)}@example.test`);
    withStore(store => {
      const chat = store.createChat(samUser.id);
      store.renameChat(samUser.id, chat.id, "Packing list for the coast");
      const turn = store.beginTurn(samUser.id, chat.id, "What should I pack for three days on the coast in October?", modelA, []);
      store.saveReply(samUser.id, chat.id, turn.assistant.id, "Pack layers: a light rain jacket, one warm sweater, two pairs of trousers, walking shoes and sandals. Evenings can drop to around 14 °C.", "complete");
      new AccessService(store).setRoleLocally(owner.email, "superuser");
    });
    await page.goto(`/?chat=${seeded.chat}`);
    await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await expect(page.getByRole("button", { name: "Users & audit", exact: true })).toBeVisible();
    await capture(page, "09-menu");
    await closeDialog(page);
    await openMenuItem(page, "How Model Chat works & Demos");
    await capture(page, "10-how-it-works-and-demos");
    await closeDialog(page);
    await openMenuItem(page, "Account & connection");
    await expect(page.getByRole("dialog")).toContainText("Copilot connection");
    await capture(page, "11-account-and-connection");
    const themes = page.getByRole("group", { name: "Theme" });
    if (await themes.count()) {
      await themes.getByRole("button", { name: "Light" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await capture(page, "11b-appearance-light");
      await themes.getByRole("button", { name: "Dark" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    }
    await closeDialog(page);
    await openMenuItem(page, "Users & audit");
    await expect(page.locator(".admin-user").filter({ hasText: samUser.email })).toBeVisible();
    await capture(page, "12-users-and-audit");
    await page.locator(".admin-user").filter({ hasText: samUser.email }).getByRole("button", { name: "View sessions", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open as user", exact: true })).toBeVisible();
    await capture(page, "13-user-chat-sessions", async () => { await page.getByRole("button", { name: "Open as user", exact: true }).scrollIntoViewIfNeeded(); });
    await page.getByRole("button", { name: "Audit log", exact: true }).click();
    await expect(page.locator(".audit-event").first()).toBeVisible();
    await capture(page, "14-audit-log");
    await page.getByRole("button", { name: "Users & chat sessions", exact: true }).click();
    await page.getByRole("button", { name: "Open as user", exact: true }).click();
    await expect(page.locator(".acting-banner")).toContainText(samUser.email);
    await capture(page, "15-acting-as-user");
    await page.getByRole("button", { name: "Return to my workspace", exact: true }).click();
    await expect(page.locator(".acting-banner")).toHaveCount(0);
  } finally { await sam.close(); }

  // Coding mode: a seeded project chat with a command, a diff and a pending approval (shown as live so the approval card renders).
  const projects = process.env.MODEL_CHAT_PROJECTS_DIR;
  if (projects) {
    const project = path.join(projects, "budget-app");
    mkdirSync(project, { recursive: true });
    const codeChat = withStore(store => {
      const chat = store.createChat(owner.id, { projectPath: project });
      const turn = store.beginTurn(owner.id, chat.id, "Add a total row to the budget table and run the tests.", modelA, []);
      store.addCodeEvent(owner.id, chat.id, turn.assistant.id, "file", { path: "src/table.js", action: "Edited", status: "done", diff: [
        "--- a/src/table.js", "+++ b/src/table.js", "@@ -12,6 +12,10 @@ export function renderTable(rows) {", "   for (const row of rows) body.append(renderRow(row));",
        "-  return table;", "+  const planned = rows.reduce((sum, row) => sum + row.planned, 0);", "+  const actual = rows.reduce((sum, row) => sum + row.actual, 0);",
        "+  body.append(renderRow({ category: \"Total\", planned, actual }));", "+  return table;", " }"].join("\n") });
      store.addCodeEvent(owner.id, chat.id, turn.assistant.id, "command", { command: "npm test", status: "done", output: "> budget-app@1.0.0 test\n> node --test\n\n✔ renders one row per category (1.2ms)\n✔ adds a total row (0.8ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n" });
      store.addCodeEvent(owner.id, chat.id, turn.assistant.id, "command", { command: "npm run dev -- --port 5173", status: "awaiting approval",
        approval: { id: "screen-approval", kind: "command", subject: "npm run dev -- --port 5173", intention: "Start the dev server so you can preview the table.", sessionScope: "npm run commands", state: "pending" } });
      store.saveReply(owner.id, chat.id, turn.assistant.id, "I added a **Total** row that sums planned and actual spending, and both tests pass. Shall I start the dev server so you can preview it?", "complete");
      return chat.id;
    });
    await page.route(`**/api/chats/${codeChat}`, async route => {
      const response = await route.fetch();
      route.fulfill({ response, json: { ...(await response.json()), codeLive: true } });
    });
    await page.goto(`/?chat=${codeChat}`);
    await expect(page.getByRole("group", { name: "Run this command?" })).toBeVisible();
    await page.locator(".code-card details").first().evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await capture(page, "18-coding-chat-approval");
    await page.getByRole("button", { name: "Workspace" }).click();
    const panel = page.getByRole("complementary", { name: "Project workspace" });
    await expect(panel.locator(".code-diff")).toBeVisible();
    await capture(page, "19-workspace-changes-diff");
    await panel.getByRole("tab", { name: /Terminal/ }).click();
    await expect(panel.locator(".terminal-output")).toContainText("pass 2");
    await capture(page, "20-workspace-terminal");
    await page.unroute(`**/api/chats/${codeChat}`);
  }
  await page.goto(`/?chat=${seeded.chat}`);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();

  await page.setViewportSize(mobile);
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots!, "16-sidebar-mobile.png"), animations: "disabled" });
  await page.setViewportSize(desktop);

  const server = createServer((request, response) => {
    const name = new URL(request.url!, "http://127.0.0.1").pathname.replace(/^\/model-chat\//, "") || "index.html";
    if (!["index.html", "forward.js"].includes(name)) return void response.writeHead(404).end();
    response.writeHead(200, { "Content-Type": name.endsWith(".js") ? "text/javascript" : "text/html" }).end(readFileSync(path.resolve("link-page", name)));
  });
  await new Promise<void>(resolve => server.listen(3217, "127.0.0.1", resolve));
  try {
    await page.route("**/model-chat/link.json*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ online: true, url: "https://example-link.trycloudflare.com" }) }));
    await page.route("https://*.trycloudflare.com/**", route => route.fulfill({ status: 530, body: "" }));
    await page.goto("http://127.0.0.1:3217/model-chat/");
    await expect(page.locator("body")).toHaveAttribute("data-state", "unreachable");
    await capture(page, "17-shareable-link-page");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
