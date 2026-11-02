import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { createChatStream } from "../lib/stream";
import { setTimeout as delay } from "node:timers/promises";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT DEFAULT 'user');
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT REFERENCES user(id) ON DELETE CASCADE,expiresAt TEXT);
    INSERT INTO user VALUES ('admin','Admin','admin@example.test','superuser'),('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user'),('other-admin','Other','other@example.test','superuser');`);
  for (const [id, user] of [["admin-session", "admin"], ["second-admin-session", "admin"], ["alice-session", "alice"], ["bob-session", "bob"]]) {
    db.prepare("INSERT INTO session VALUES (?,?,?)").run(id, user, new Date(Date.now() + 3600_000).toISOString());
  }
  const store = new Store(db);
  const access = new AccessService(store);
  return { db, store, access, own: access.resolve("admin", "admin-session") };
}
test("acting identity is session-scoped and never changes the authenticated actor", () => {
  const { db, access, own } = fixture();
  try {
    const acting = access.start(own, "alice");
    assert.equal(acting.actor.id, "admin");
    assert.equal(acting.subject.id, "alice");
    assert.equal(access.resolve("admin", "admin-session").subject.id, "alice");
    assert.equal(access.resolve("admin", "second-admin-session").subject.id, "admin");
    assert.equal(access.resolve("alice", "alice-session").subject.id, "alice");
    assert.throws(() => access.start(acting, "bob"), /Return/);
    assert.throws(() => access.start(access.resolve("admin", "second-admin-session"), "other-admin"), /another superuser/);
    assert.throws(() => access.start(access.resolve("bob", "bob-session"), "alice"), /Superuser/);
    assert.throws(() => access.assertExpectedSubject(access.resolve("bob", "bob-session"), "alice"), /workspace changed/);
    assert.throws(() => access.audit(access.resolve("bob", "bob-session"), Number.MAX_SAFE_INTEGER), /Superuser/);
    access.stop(acting);
    assert.equal(access.resolve("admin", "admin-session").subject.id, "admin");
    assert.throws(() => access.check(acting), /changed/);
  } finally { db.close(); }
});
test("admin listing, writes and audit record actor/subject IDs without prompt or credential data", () => {
  const { db, store, access, own } = fixture();
  try {
    assert.equal(access.users(own, "alice", 0).users[0].id, "alice");
    const existing = store.createChat("alice");
    const old = store.beginTurn("alice", existing.id, "OLD_PRIVATE_PROMPT", "first-model", []);
    store.saveReply("alice", existing.id, old.assistant.id, "OLD_PRIVATE_REPLY", "complete");
    store.saveDraft("alice", existing.id, "PRIVATE_DRAFT");
    const acting = access.start(own, "alice");
    const messages = store.messages("alice", existing.id);
    access.run(acting, "chat.read", existing.id, () => store.messages("alice", existing.id));
    access.run(acting, "chat.rename", existing.id, () => store.renameChat("alice", existing.id, "RENAMED_PRIVATE_TITLE"));
    assert.deepEqual(store.messages("alice", existing.id), messages);
    assert.equal(store.chat("alice", existing.id).draft, "PRIVATE_DRAFT");
    assert.throws(() => access.run(acting, "chat.read", existing.id, () => store.chat("bob", existing.id)), /not found/);
    access.stop(acting);
    const logs = access.audit(own, Number.MAX_SAFE_INTEGER).events;
    const read = logs.find(log => log.action === "chat.read" && log.outcome === "allowed")!;
    assert.equal(read.actorId, "admin"); assert.equal(read.subjectId, "alice"); assert.equal(read.objectId, existing.id);
    const serialized = JSON.stringify(logs);
    for (const secret of ["OLD_PRIVATE_PROMPT", "OLD_PRIVATE_REPLY", "PRIVATE_DRAFT", "RENAMED_PRIVATE_TITLE", "password", "token"]) assert.equal(serialized.includes(secret), false);
  } finally { db.close(); }
});
test("fresh checks reject role revocation, target promotion/deletion, logout and expired sessions", () => {
  const { db, access, own } = fixture();
  try {
    const acting = access.start(own, "alice");
    access.setRoleLocally("admin@example.test", "user");
    assert.throws(() => access.check(acting), /changed/);
    assert.equal(access.resolve("admin", "admin-session").subject.id, "admin");
    assert.throws(() => access.requireAdmin(own), /Superuser/);
    access.setRoleLocally("admin@example.test", "superuser");
    const next = access.start(access.resolve("admin", "admin-session"), "alice");
    access.setRoleLocally("alice@example.test", "superuser");
    assert.throws(() => access.check(next), /changed/);
    const bob = access.start(access.resolve("admin", "admin-session"), "bob");
    db.prepare("DELETE FROM user WHERE id='bob'").run();
    assert.throws(() => access.check(bob), /exists/);
    const current = access.resolve("admin", "admin-session");
    db.prepare("UPDATE session SET expiresAt=? WHERE id=?").run(new Date(0).toISOString(), current.sessionId);
    assert.throws(() => access.check(current), /session ended/);
    db.prepare("DELETE FROM session WHERE id=?").run(current.sessionId);
    assert.throws(() => access.resolve("admin", current.sessionId), /sign in/);
  } finally { db.close(); }
});
test("delegated streaming is fixed to its owner and stops before exposing data after revocation", async () => {
  const { db, store, access, own } = fixture();
  try {
    const target = store.createChat("alice");
    const acting = access.start(own, "alice");
    const response = createChatStream(store, "alice", target.id, "Accepted question", "model", [], "prompt", async input => {
      input.onDelta("Accepted partial");
      access.setRoleLocally("admin@example.test", "user");
      input.onDelta(" MUST_NOT_APPEAR");
      await delay(20);
    }, new AbortController().signal, {
      actorId: acting.actor.id, sessionId: acting.sessionId, check: () => { access.check(acting); },
      accepted: id => access.record(acting, "message.send", id, "allowed"),
      finished: (id, status, lost) => access.record(acting, "message.finish", id, lost ? "denied" : "allowed", status),
    });
    const output = await response.text();
    assert.equal(output.includes("MUST_NOT_APPEAR"), false);
    const messages = store.messages("alice", target.id);
    assert.equal(messages[0].content, "Accepted question");
    assert.equal(messages[1].content, "Accepted partial");
    assert.equal(messages[1].status, "cancelled");
    assert.equal(store.listChats("admin").length, 0);
    assert.equal(store.listChats("bob").length, 0);
    const end = db.prepare("SELECT actorId,subjectId,outcome FROM app_audit WHERE action='message.finish'").get() as { actorId: string; subjectId: string; outcome: string };
    assert.deepEqual(end, { actorId: "admin", subjectId: "alice", outcome: "denied" });
  } finally { db.close(); }
});
test("role assignment requires an exact existing account and never creates a reserved identity", () => {
  const { db, access } = fixture();
  try {
    assert.throws(() => access.setRoleLocally("future@example.test", "superuser"), /existing account/);
    assert.equal((db.prepare("SELECT count(*) count FROM user").get() as { count: number }).count, 4);
  } finally { db.close(); }
});
