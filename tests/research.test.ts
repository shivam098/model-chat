import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionEvent, Tool } from "@github/copilot-sdk";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { replyReasoningEffort, safeSessionConfig, modelLevels, type ReplyInput } from "../lib/copilot";
import { nearestLevel } from "../lib/thinking";
import { htmlToText, isPublicAddress, readPage, PageReadError } from "../lib/page-reader";
import { beginResearch, cancelResearch, finalizeReport, parsePlan, researchAllowed, startResearch, RESEARCH_CAPS } from "../lib/research";
import { systemInstruction } from "../lib/context";

const model = (levels?: string[]) => ({ id: "m", name: "M", capabilities: { supports: { vision: false, reasoningEffort: Boolean(levels) }, limits: { max_context_window_tokens: 200_000 } }, supportedReasoningEfforts: levels }) as never;

test("thinking levels: the chosen level if the model has it, otherwise the nearest; medium by default; Off only where supported", () => {
  const full = ["none", "low", "medium", "high", "xhigh", "max"];
  assert.equal(nearestLevel(full, "max"), "max");
  assert.equal(nearestLevel(["low", "medium", "high"], "max"), "high");
  assert.equal(nearestLevel(["low", "medium", "high", "xhigh"], "max"), "xhigh");
  assert.equal(nearestLevel(["low", "medium", "high", "xhigh", "max"], "none"), "low");
  assert.equal(nearestLevel(["low", "high"], "medium"), "low", "A tie takes the lower level");
  assert.equal(nearestLevel(full, null), "medium");
  assert.equal(nearestLevel(undefined, "max"), undefined);
  assert.equal(replyReasoningEffort(model(full)), "medium");
  assert.equal(replyReasoningEffort(model(full), "none"), "none");
  assert.equal(replyReasoningEffort(model(["low", "medium", "high"]), "max"), "high");
  assert.equal(replyReasoningEffort(model(undefined), "max"), undefined);
  assert.deepEqual(modelLevels(model(["max", "low", "bogus", "medium"])), ["low", "medium", "max"]);
  assert.equal(modelLevels(model(undefined)), undefined);
  const off = safeSessionConfig("m", ".local/test", "s", [], undefined, "none");
  assert.equal(off.reasoningEffort, "none");
  assert.equal("reasoningSummary" in off, false, "Off asks for no reasoning summary");
  assert.equal(safeSessionConfig("m", ".local/test", "s", [], undefined, "max").reasoningSummary, "detailed");
});

test("page reader: only public addresses, checked after DNS and on every redirect; nothing is requested from refused hosts", async () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "172.20.1.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "168.63.129.16",
    "::1", "::", "fe80::1", "fc00::5", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "64:ff9b:1::1", "2001:db8::1", "2002:c0a8:101::1", "not-an-ip"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) assert.equal(isPublicAddress(address), true, address);

  let hits = 0;
  const server = http.createServer((request, response) => {
    hits++;
    if (request.url === "/to-app") { response.writeHead(302, { Location: "http://127.0.0.1:3210/" }).end(); return; }
    if (request.url === "/to-internal") { response.writeHead(301, { Location: "http://intranet.example/admin" }).end(); return; }
    if (request.url === "/to-ipv6") { response.writeHead(307, { Location: "http://[::1]:3210/" }).end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<html><head><title>Lamp &amp; desk</title><script>alert('x')</script></head><body><nav>Menu</nav><main><h1>Green lamps</h1><p>Banker&#39;s lamps date from 1901.</p><p>" + "Detail. ".repeat(100) + "</p></main><footer>Footer</footer></body></html>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const local = `http://127.0.0.1:${port}`;
  const refused = async (url: string, options = {}) => {
    await assert.rejects(readPage(url, options), (error: unknown) => error instanceof PageReadError && /local, private or reserved|never opens|Only http|sign-in details|valid web address/.test((error as Error).message), url);
  };
  // Test-only allow rule: this one local test server stands in for a public site; every other address uses the real rule.
  const allow = (address: string, target: number) => (address === "127.0.0.1" && target === port) || isPublicAddress(address);
  const resolve = async (host: string) => host === "intranet.example" ? [{ address: "10.0.0.5", family: 4 }] : host === "mixed.example" ? [{ address: "93.184.216.34", family: 4 }, { address: "192.168.0.2", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
  try {
    await refused(local + "/");
    await refused("http://localhost:3210/");
    await refused("http://127.0.0.1:3210/api/health");
    await refused("http://[::1]:3210/");
    await refused("http://[::ffff:127.0.0.1]:3210/");
    await refused("http://10.1.2.3/");
    await refused("http://169.254.169.254/latest/meta-data/");
    await refused("http://p-abc123.localhost:3210/");
    await refused("http://intranet.example/", { resolve });
    await refused("http://mixed.example/", { resolve });
    await refused("file:///C:/Windows/win.ini");
    await refused("ftp://example.com/");
    await refused("https://user:secret@example.com/");
    assert.equal(hits, 0, "No refused address received a request");
    await refused(`${local}/to-app`, { allow, resolve });
    await refused(`${local}/to-internal`, { allow, resolve });
    await refused(`${local}/to-ipv6`, { allow, resolve });
    assert.equal(hits, 3, "Only the allowed hop was requested; redirect targets were refused before connecting");
    const page = await readPage(`${local}/article`, { allow, resolve });
    assert.equal(page.title, "Lamp & desk");
    assert.match(page.text, /Banker's lamps date from 1901/);
    assert.doesNotMatch(page.text, /alert|Menu|Footer/);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});

test("research plans parse safely, reports cite only pages that were read, and the web-reading instruction replaces 'cannot browse'", () => {
  assert.deepEqual(parsePlan('Here: {"title":"EV batteries","steps":["Market size 2026","Chemistry trends",""]}', "q"), { title: "EV batteries", steps: ["Market size 2026", "Chemistry trends"] });
  assert.deepEqual(parsePlan("not json", "What changed?").steps, ["What changed?"]);
  const sources = [{ n: 1, url: "https://example.org/a(1)", title: "Alpha [draft]", text: "" }, { n: 2, url: "https://example.com/b", title: "Beta", text: "" }, { n: 3, url: "https://example.net/c", title: "Gamma", text: "" }];
  const { content, cited } = finalizeReport("# Report\n\nClaim one [1]. Claims [1, 2] and [2–3]. Made up [9].\n\n## Sources\n1. junk", sources);
  assert.match(content, /Claim one \[\[1\]\]\(https:\/\/example\.org\/a%281%29\)/);
  assert.match(content, /\[\[1\]\]\(.+\)\[\[2\]\]\(https:\/\/example\.com\/b\)/);
  assert.doesNotMatch(content, /\[9\]|junk/);
  assert.match(content, /## Sources\n\n1\. \[Alpha draft\]\(https:\/\/example\.org\/a%281%29\) · example\.org\n2\. \[Beta\]/);
  assert.deepEqual(cited.map(item => item.n), [1, 2, 3]);
  // Numbers follow first citation, so the list numbering always matches the text.
  const renumbered = finalizeReport("First [3]. Then [1].", sources);
  assert.match(renumbered.content, /^First \[\[1\]\]\(https:\/\/example\.net\/c\)\. Then \[\[2\]\]\(https:\/\/example\.org\/a%281%29\)\./);
  assert.match(renumbered.content, /## Sources\n\n1\. \[Gamma\][^\n]+\n2\. \[Alpha draft\]/);
  assert.match(renumbered.content, /\*Also read:\* \[Beta\]/);
  const researchSystem = systemInstruction("research tools", true, true);
  assert.match(researchSystem, /read_page/);
  assert.doesNotMatch(researchSystem, /cannot open or read a page/);
  assert.match(systemInstruction(undefined, true), /cannot open or read a page/);
  assert.match(systemInstruction(), /no tools, file access, shell, browsing/);
});

function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT DEFAULT 'user');
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT REFERENCES user(id) ON DELETE CASCADE,expiresAt TEXT);
    INSERT INTO user VALUES ('admin','Admin','admin@example.test','superuser'),('alice','Alice','alice@example.test','user');`);
  for (const [id, user] of [["admin-session", "admin"], ["alice-session", "alice"]]) db.prepare("INSERT INTO session VALUES (?,?,?)").run(id, user, new Date(Date.now() + 3600_000).toISOString());
  const store = new Store(db);
  return { db, store, guard: new AccessService(store) };
}
const until = async (check: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 20)); } };
const usage = (initiator: string) => ({ type: "assistant.usage", data: { initiator } }) as unknown as SessionEvent;

test("deep research runs as a background job: plan, start, capped searches, full pages, cited report, audit without query text", async () => {
  const { db, store, guard } = setup();
  try {
    const ctx = guard.resolve("admin", "admin-session");
    const chat = store.createChat("admin");
    let searchesAllowed = 0, roundRefused = false;
    const runner = async (input: ReplyInput) => {
      input.onSessionEvent?.(usage("user"));
      if (!input.tools?.length) { input.onDelta('{"title":"Lamps","steps":["History","Today"]}'); return; }
      // Five rounds of five searches: the fifth search of a round and everything past the run's total are refused before they run.
      for (let round = 0; round < 5; round++) {
        if (round) input.onSessionEvent?.(usage("agent"));
        for (let index = 0; index < RESEARCH_CAPS.perRound + 1; index++) {
          const refusal = input.preToolUse?.("web_search", { query: `secret query ${round}-${index}` });
          if (refusal === null) searchesAllowed++;
          else if (/per round/.test(refusal ?? "")) roundRefused = true;
        }
      }
      const tool = input.tools[0] as Tool & { handler: (args: unknown) => Promise<unknown> };
      assert.equal(tool.name, "read_page");
      assert.match(String(await tool.handler({ url: "https://example.org/lamps" })), /^Source \[1\]: Lamp history/);
      assert.match(String((await tool.handler({ url: "http://10.0.0.1/" }) as { textResultForLlm: string }).textResultForLlm), /Couldn't read/);
      input.onSessionEvent?.(usage("agent"));
      input.onSessionEvent?.({ type: "assistant.message", data: { messageId: "x", content: "# Lamps\n\n" + "Green lamps date from 1901 [1]. ".repeat(20) } } as unknown as SessionEvent);
    };
    const read = async (url: string) => {
      if (!url.startsWith("https://")) throw new PageReadError("refused");
      return { url, title: "Lamp history", text: "Since 1901.", contentType: "text/html", truncated: false };
    };
    const deps = { store, guard, runner, read: read as never, scope: () => "owner" as const };
    const turn = beginResearch(deps, { ctx, chatId: chat.id, content: "History of green lamps", model: model(["low", "medium", "high", "max"]), thinking: "max", fileIds: [], prompt: JSON.stringify({ conversation: [{ role: "user", content: "History of green lamps" }] }), runner });
    await until(() => store.messages("admin", chat.id).at(-1)?.research?.state === "awaiting_start");
    const planned = store.messages("admin", chat.id).at(-1)!;
    assert.equal(planned.status, "streaming");
    assert.equal(planned.thinking, "max");
    assert.deepEqual(planned.research!.plan, ["History", "Today"]);
    assert.throws(() => store.deleteChat("admin", chat.id), /in progress/, "A chat with a research run can't be deleted mid-run");
    startResearch(deps, ctx, chat.id, planned.research!.id, ["History", "Today", "Why green"]);
    await until(() => store.messages("admin", chat.id).at(-1)?.research?.state === "complete");
    const done = store.messages("admin", chat.id).at(-1)!;
    assert.equal(done.id, turn.assistant.id);
    assert.equal(done.status, "complete");
    assert.equal(searchesAllowed, RESEARCH_CAPS.searches, "Searches past the cap are refused before they run");
    assert.equal(roundRefused, true, "Each round is limited, so research iterates");
    assert.match(done.content, /\[\[1\]\]\(https:\/\/example\.org\/lamps\)/);
    assert.match(done.content, /## Sources\n\n1\. \[Lamp history\]/);
    assert.deepEqual(done.research!.plan, ["History", "Today", "Why green"]);
    assert.deepEqual({ ...done.research!.counts }, { searches: RESEARCH_CAPS.searches, pages: 1, failedPages: 1, requests: 7, userRequests: 2 });
    assert.ok(done.research!.log.some(item => item.kind === "skip"));
    const audit = db.prepare("SELECT action,outcome,reason FROM app_audit WHERE action LIKE 'research.%' ORDER BY id").all() as { action: string; reason: string }[];
    assert.deepEqual(audit.map(row => row.action), ["research.plan", "research.start", "research.finish"]);
    assert.match(audit[2].reason, /^complete · 12 searches · 1 pages · 7 model requests \(2 user-initiated\)/);
    assert.equal(audit.some(row => /secret query|Since 1901/.test(row.reason)), false, "No query text or page contents in the audit");
  } finally { db.close(); }
});

test("deep research: Stop cancels it, it keeps no access while acting or without web search, and runs in different chats work in parallel", async () => {
  const { db, store, guard } = setup();
  try {
    const ctx = guard.resolve("admin", "admin-session");
    const chat = store.createChat("admin");
    const waiting = async (input: ReplyInput) => {
      if (!input.tools?.length) { input.onDelta('{"title":"T","steps":["One"]}'); return; }
      await new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    };
    const deps = { store, guard, runner: waiting, scope: () => "owner" as const };
    const input = { ctx, chatId: chat.id, content: "Q", model: model(["low", "medium"]), fileIds: [], prompt: JSON.stringify({ conversation: [{ role: "user", content: "Q" }] }), runner: waiting };
    beginResearch(deps, input);
    await until(() => store.messages("admin", chat.id).at(-1)?.research?.state === "awaiting_start");
    const other = store.createChat("admin");
    startResearch(deps, ctx, chat.id, store.messages("admin", chat.id).at(-1)!.research!.id);
    await until(() => store.messages("admin", chat.id).at(-1)?.research?.state === "running");
    assert.throws(() => beginResearch(deps, input), /already running in this chat/, "One run per chat");
    // Another chat of the same account runs at the same time.
    const parallel = store.createChat("admin");
    beginResearch(deps, { ...input, chatId: parallel.id });
    await until(() => store.messages("admin", parallel.id).at(-1)?.research?.state === "awaiting_start");
    startResearch(deps, ctx, parallel.id, store.messages("admin", parallel.id).at(-1)!.research!.id);
    await until(() => store.messages("admin", parallel.id).at(-1)?.research?.state === "running");
    assert.equal(store.messages("admin", chat.id).at(-1)?.research?.state, "running", "Both runs work at once");
    cancelResearch(deps, "admin", parallel.id);
    await until(() => store.messages("admin", parallel.id).at(-1)?.research?.state === "cancelled");
    cancelResearch(deps, "admin", chat.id);
    await until(() => store.messages("admin", chat.id).at(-1)?.research?.state === "cancelled");
    assert.equal(store.messages("admin", chat.id).at(-1)!.status, "cancelled");
    // A plan that was never started can be cancelled too.
    beginResearch(deps, { ...input, chatId: other.id });
    await until(() => store.messages("admin", other.id).at(-1)?.research?.state === "awaiting_start");
    cancelResearch(deps, "admin", other.id);
    assert.equal(store.messages("admin", other.id).at(-1)!.research!.state, "cancelled");

    const acting = guard.start(ctx, "alice");
    assert.match(researchAllowed(guard, "alice", acting.delegationId, "everyone")!, /acting/);
    assert.throws(() => beginResearch(deps, { ...input, ctx: acting, chatId: store.createChat("alice").id }), /acting/);
    guard.stop(acting);
    assert.match(researchAllowed(guard, "alice", null, "owner")!, /only to the app owner/);
    assert.equal(researchAllowed(guard, "alice", null, "everyone"), null);
    assert.match(researchAllowed(guard, "admin", null, "off")!, /turned off/);
  } finally { db.close(); }
});

test("deep research: model requests have no fixed deadline; a silent plan or report request is ended, and Stop reaches the report writer", async () => {
  const { db, store, guard } = setup();
  try {
    const ctx = guard.resolve("admin", "admin-session");
    const base = { ctx, content: "Q", model: model(["low", "medium"]), fileIds: [], prompt: JSON.stringify({ conversation: [{ role: "user", content: "Q" }] }) };
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const untilAborted = (input: ReplyInput) => new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException("aborted", "AbortError"));
      if (input.signal.aborted) fail(); else input.signal.addEventListener("abort", fail, { once: true });
    });
    // A slow plan that keeps producing events outlasts several silence windows.
    const slow = store.createChat("admin");
    const slowPlan = async (input: ReplyInput) => { for (let i = 0; i < 8; i++) { await sleep(40); input.onActivity?.(); } input.onDelta('{"title":"T","steps":["One"]}'); };
    beginResearch({ store, guard, runner: slowPlan, scope: () => "owner" as const, silenceMs: 100 }, { ...base, chatId: slow.id, runner: slowPlan });
    await until(() => store.messages("admin", slow.id).at(-1)?.research?.state === "awaiting_start");
    cancelResearch({ store, guard }, "admin", slow.id);
    // A plan request that goes completely silent is ended with a plain message.
    const silent = store.createChat("admin");
    const silentPlan = async (input: ReplyInput) => { await untilAborted(input); };
    beginResearch({ store, guard, runner: silentPlan, scope: () => "owner" as const, silenceMs: 100 }, { ...base, chatId: silent.id, runner: silentPlan });
    await until(() => store.messages("admin", silent.id).at(-1)?.research?.state === "error");
    assert.match(store.messages("admin", silent.id).at(-1)!.error!, /stopped responding while drafting the plan/);
    // The run hits its request cap after reading a page; the report writer then runs with no fixed deadline, and Stop cancels it.
    const capped = store.createChat("admin");
    let writing = false;
    const runner = async (input: ReplyInput) => {
      if (!input.tools?.length) {
        if (input.prompt.includes("Write the final deep research report")) { writing = true; await untilAborted(input); }
        input.onDelta('{"title":"T","steps":["One"]}'); return;
      }
      const tool = input.tools[0] as Tool & { handler: (args: unknown) => Promise<unknown> };
      await tool.handler({ url: "https://example.org/a" });
      for (let i = 0; i <= RESEARCH_CAPS.modelRequests; i++) input.onSessionEvent?.(usage("agent"));
      await untilAborted(input);
    };
    const read = async (url: string) => ({ url, title: "A", text: "Page text.", contentType: "text/html", truncated: false });
    const deps = { store, guard, runner, read: read as never, scope: () => "owner" as const };
    beginResearch(deps, { ...base, chatId: capped.id, runner });
    await until(() => store.messages("admin", capped.id).at(-1)?.research?.state === "awaiting_start");
    startResearch(deps, ctx, capped.id, store.messages("admin", capped.id).at(-1)!.research!.id);
    await until(() => writing);
    await sleep(150);
    assert.equal(store.messages("admin", capped.id).at(-1)!.research!.state, "writing", "Still writing: no fixed per-request deadline");
    cancelResearch(deps, "admin", capped.id);
    await until(() => store.messages("admin", capped.id).at(-1)?.research?.state === "cancelled");
    assert.equal(store.messages("admin", capped.id).at(-1)!.status, "cancelled");
  } finally { db.close(); }
});
