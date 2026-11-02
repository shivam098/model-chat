import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../lib/store";
import { buildPrompt } from "../lib/context";
import { createChatStream, stopReply } from "../lib/stream";
import { safeSessionConfig } from "../lib/copilot";
import { assertLocalRequest, readBytes } from "../lib/http";
import { runtimeEnvironment } from "../lib/runtime-env.mjs";
import { dictationConstructor, voiceError } from "../lib/voice";
import { LIMITS } from "../lib/contracts";

function fixture(file = ":memory:") {
  const db = new Database(file);
  db.exec("CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO user VALUES ('alice'), ('bob')");
  const store = new Store(db);
  const chat = store.createChat("alice");
  return { db, store, chat };
}
test("ownership is checked across chats, messages, mutations, downloads and context", () => {
  const { db, store, chat } = fixture();
  try {
    const file = store.addFile("alice", chat.id, "note.txt", Buffer.from("secret"), "secret", "text");
    assert.equal(store.listChats("bob").length, 0);
    for (const read of [
      () => store.chat("bob", chat.id), () => store.messages("bob", chat.id),
      () => store.renameChat("bob", chat.id, "stolen"), () => store.deleteChat("bob", chat.id),
      () => store.file("bob", chat.id, file.id), () => store.deleteFile("bob", chat.id, file.id),
      () => store.contextFiles("bob", chat.id, [file.id]),
      () => store.addFile("bob", chat.id, "bad.txt", Buffer.from("x"), "x", ""),
      () => store.beginTurn("bob", chat.id, "steal", "model", []),
    ]) assert.throws(read, /not found/);
    const bobChat = store.createChat("bob");
    assert.throws(() => store.contextFiles("bob", bobChat.id, [file.id]), /not found/);
  } finally { db.close(); }
});
test("reopen and model switch retain exact owned context and sent files", () => {
  const directory = mkdtempSync(path.resolve(".local", "persistence-test-"));
  const filePath = path.join(directory, "test.db");
  const { db, store, chat } = fixture(filePath);
  const file = store.addFile("alice", chat.id, "numbers.txt", Buffer.from("Revenue=42"), "Revenue=42", "");
  const turn = store.beginTurn("alice", chat.id, "Remember my project: Birch.", "first-model", [file.id]);
  store.saveReply("alice", chat.id, turn.assistant.id, "I will remember Birch.", "complete");
  assert.throws(() => store.deleteFile("alice", chat.id, file.id), /already sent/);
  db.close();
  const reopened = new Database(filePath);
  try {
    const restored = new Store(reopened);
    const prompt = buildPrompt(restored.messages("alice", chat.id), restored.contextFiles("alice", chat.id, []), "What project?");
    assert.match(prompt, /Birch/); assert.match(prompt, /Revenue=42/);
    const second = restored.beginTurn("alice", chat.id, "What project?", "second-model", []);
    restored.saveReply("alice", chat.id, second.assistant.id, "Bir", "streaming");
    restored.recoverInterrupted();
    assert.equal(restored.messages("alice", chat.id).at(-1)?.status, "error");
    assert.equal(restored.messages("alice", chat.id).at(-1)?.content, "Bir");
    assert.equal(restored.chat("alice", chat.id).model, "second-model");
    restored.deleteChat("alice", chat.id);
    assert.equal((reopened.prepare("SELECT count(*) n FROM app_file").get() as { n: number }).n, 0);
  } finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});
test("context and per-chat file budgets reject overflow rather than dropping data", () => {
  assert.throws(() => buildPrompt([], [{ id: "x", name: "huge", text: "x".repeat(LIMITS.promptBytes) }], "question"), /budget/);
  assert.throws(() => buildPrompt([], [], "hi", 100), /budget/);
  const { db, store, chat } = fixture();
  try {
    store.addFile("alice", chat.id, "one.txt", Buffer.from("1"), "x".repeat(30_000), "");
    store.addFile("alice", chat.id, "two.txt", Buffer.from("2"), "x".repeat(30_000), "");
    assert.throws(() => store.addFile("alice", chat.id, "three.txt", Buffer.from("3"), "x", ""), /60,000/);
    const turn = store.beginTurn("alice", chat.id, "hello", "m", []);
    assert.throws(() => store.beginTurn("alice", chat.id, "race", "m", []), /in progress/);
    assert.throws(() => store.deleteChat("alice", chat.id), /in progress/);
    store.saveReply("alice", chat.id, turn.assistant.id, "", "cancelled");
  } finally { db.close(); }
});
test("stream saves ordered turns, handles full-message replacement and error", async () => {
  const { db, store, chat } = fixture();
  try {
    const response = createChatStream(store, "alice", chat.id, "Hello", "m", [], "prompt", async input => {
      input.onDelta("Hel"); input.onDelta("lo"); input.onReplace("Hello.");
    }, new AbortController().signal);
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events[0].type, "start"); assert.equal(events.at(-1).type, "done");
    assert.equal(events.at(-1).message.content, "Hello.");
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "complete");
    await createChatStream(store, "alice", chat.id, "Again", "m", [], "", async input => {
      input.onDelta("partial"); throw new Error("quota reached");
    }, new AbortController().signal).text();
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "error");
    assert.equal(store.messages("alice", chat.id).at(-1)?.content, "partial");
  } finally { db.close(); }
});
test("cancellation is owned, persists partial output, and releases generation lock", async () => {
  const { db, store, chat } = fixture();
  try {
    const response = createChatStream(store, "alice", chat.id, "Hello", "m", [], "", async input => {
      input.onDelta("partial");
      await new Promise<void>((_, reject) => {
        input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }, new AbortController().signal);
    assert.throws(() => stopReply(store, "bob", chat.id), /not found/);
    assert.throws(() => createChatStream(store, "alice", chat.id, "duplicate", "m", [], "", async () => {}, new AbortController().signal), /already running/);
    stopReply(store, "alice", chat.id);
    await response.text();
    const last = store.messages("alice", chat.id).at(-1)!;
    assert.equal(last.status, "cancelled"); assert.equal(last.content, "partial");
    const next = createChatStream(store, "alice", chat.id, "Next", "m", [], "", async input => input.onDelta("ok"), new AbortController().signal);
    await next.text();
    assert.equal(store.messages("alice", chat.id).at(-1)?.content, "ok");
  } finally { db.close(); }
});
test("output limit and empty replies are explicit saved states", async () => {
  const { db, store, chat } = fixture();
  try {
    await createChatStream(store, "alice", chat.id, "Big", "m", [], "", async input => input.onDelta("a".repeat(32_001)), new AbortController().signal).text();
    const last = store.messages("alice", chat.id).at(-1)!;
    assert.equal(last.content.length, 32_000); assert.equal(last.status, "cancelled"); assert.match(last.error!, /limit/);
    await createChatStream(store, "alice", chat.id, "Empty", "m", [], "", async () => {}, new AbortController().signal).text();
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "error");
  } finally { db.close(); }
});
test("runtime config explicitly disables tools, discovery, skills and cross-session state", async () => {
  const config = safeSessionConfig("live-model-id", path.resolve(".local", "test"), "test");
  assert.deepEqual(config.availableTools, []);
  assert.deepEqual(config.excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
  for (const value of [config.enableConfigDiscovery, config.enableSessionStore, config.enableSkills, config.enableFileHooks, config.enableHostGitOperations]) assert.equal(value, false);
  assert.equal(config.skipCustomInstructions, true);
  assert.deepEqual(config.memory, { enabled: false });
  const handler = config.onPermissionRequest!;
  const result = await handler({ kind: "read", intention: "test", path: "test" }, { sessionId: "test" });
  assert.equal(result.kind, "reject");
  assert.equal(runtimeEnvironment().COPILOT_GITHUB_TOKEN, undefined);
  assert.equal(runtimeEnvironment().GITHUB_TOKEN, undefined);
});
test("loopback Host and same-origin mutation requirements reject cross-site attacks", async () => {
  const url = "http://127.0.0.1:3210/api/chats";
  assert.throws(() => assertLocalRequest(new Request(url, { method: "POST", headers: { host: "evil.example", origin: "http://evil.example" } })), /configured URL/);
  assert.throws(() => assertLocalRequest(new Request(url, { method: "POST", headers: { host: "127.0.0.1:3210" } })), /same-origin/);
  assert.throws(() => assertLocalRequest(new Request(url, { headers: { host: "127.0.0.1:3210", "sec-fetch-site": "cross-site" } })), /Cross-site/);
  assert.doesNotThrow(() => assertLocalRequest(new Request(url, { method: "POST", headers: { host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" } })));
  await assert.rejects(() => readBytes(new Request(url, { method: "POST", body: "12345" }), 4), /limit/);
});
test("voice feature detection and permission errors leave a text fallback", () => {
  assert.equal(dictationConstructor({} as Window), undefined);
  assert.match(voiceError("not-allowed"), /keep typing/);
  assert.match(voiceError("audio-capture"), /Text chat/);
  assert.match(voiceError("network"), /Text chat/);
});
