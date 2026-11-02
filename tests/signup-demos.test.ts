import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Store } from "../lib/store";
import { signupSchema } from "../lib/signup";
import { createDemoChat } from "../lib/demo-storage";
import { DEMOS } from "../lib/demos";
import { buildPrompt } from "../lib/context";

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'),('bob')");
  return { db, store: new Store(db) };
}
test("signup accepts email/password only including Gmail without weakening validation", () => {
  assert.deepEqual(signupSchema.parse({ email: " reader@gmail.com ", password: "A unique password 143!" }), {
    email: "reader@gmail.com", password: "A unique password 143!", name: "reader",
  });
  for (const input of [
    { email: "invalid", password: "A unique password 143!" },
    { email: "reader@gmail.com", password: "short" },
    { email: "reader@gmail.com", password: "x".repeat(129) },
  ]) assert.equal(signupSchema.safeParse(input).success, false);
});
test("draft migration preserves an old database's chats and owners", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'); CREATE TABLE app_chat(id TEXT PRIMARY KEY,userId TEXT NOT NULL,title TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL); INSERT INTO app_chat VALUES ('old','alice','Keep me','old-model',1,2)");
    const store = new Store(db);
    assert.deepEqual(store.chat("alice", "old"), { id: "old", title: "Keep me", model: "old-model", createdAt: 1, updatedAt: 2, draft: "" });
    new Store(db);
    assert.equal(store.listChats("alice").length, 1);
  } finally { db.close(); }
});
test("all demos create independent drafts without generating or modifying previous messages", () => {
  const { db, store } = fixture();
  try {
    const old = store.createChat("alice");
    const turn = store.beginTurn("alice", old.id, "My previous question", "old-model", []);
    store.saveReply("alice", old.id, turn.assistant.id, "A saved answer", "complete");
    const before = store.messages("alice", old.id);
    const ids = new Set<string>();
    for (const demo of DEMOS) {
      const result = createDemoChat(store, "alice", demo.id, { chatId: old.id, draft: "Keep this unsent draft." });
      assert.ok(!ids.has(result.detail.chat.id));
      ids.add(result.detail.chat.id);
      assert.notEqual(result.detail.chat.id, old.id);
      assert.deepEqual(result.detail.messages, []);
      assert.equal(store.chat("alice", result.detail.chat.id).draft, demo.prompt);
      assert.equal(store.chat("alice", old.id).draft, "Keep this unsent draft.");
      assert.deepEqual(store.messages("alice", old.id), before);
      if (demo.file) {
        const file = result.detail.attachments[0];
        assert.equal(store.file("alice", result.detail.chat.id, file.id).bytes.toString(), demo.file.content);
        const prompt = buildPrompt([], store.contextFiles("alice", result.detail.chat.id, [file.id]), demo.prompt);
        assert.match(prompt, /Groceries/);
        assert.match(prompt, /sample-budget.csv/);
      }
    }
    const next = createDemoChat(store, "alice", "budget");
    assert.ok(!ids.has(next.detail.chat.id));
    const send = store.beginTurn("alice", next.detail.chat.id, next.detail.chat.draft!, "model", next.detail.attachments.map(f => f.id));
    assert.equal(store.chat("alice", next.detail.chat.id).draft, "");
    store.saveReply("alice", next.detail.chat.id, send.assistant.id, "", "cancelled");
  } finally { db.close(); }
});
test("demos preserve a never-saved draft and deny cross-account draft/file access", () => {
  const { db, store } = fixture();
  try {
    const demo = createDemoChat(store, "alice", "budget", { draft: "Not saved in a chat yet." });
    const saved = store.listChats("alice").find(chat => chat.title === "Saved draft")!;
    assert.equal(store.chat("alice", saved.id).draft, "Not saved in a chat yet.");
    assert.throws(() => createDemoChat(store, "bob", "writing", { chatId: saved.id, draft: "overwrite" }), /not found/);
    assert.equal(store.listChats("bob").length, 0);
    const other = createDemoChat(store, "bob", "budget");
    assert.notEqual(demo.detail.chat.id, other.detail.chat.id);
    assert.notEqual(demo.detail.attachments[0].id, other.detail.attachments[0].id);
    assert.throws(() => store.file("bob", demo.detail.chat.id, demo.detail.attachments[0].id), /not found/);
  } finally { db.close(); }
});
test("a demo failure rolls back new chats and prior-draft changes atomically", () => {
  const { db, store } = fixture();
  try {
    for (let i = 0; i < 99; i++) store.createChat("alice");
    assert.throws(() => createDemoChat(store, "alice", "budget", { draft: "Must not be discarded" }), /limit/);
    assert.equal(store.listChats("alice").length, 99);
    assert.equal(store.listChats("alice").some(chat => chat.title === "Saved draft"), false);
  } finally { db.close(); }
});
