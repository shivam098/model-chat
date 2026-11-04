import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { UploadStore } from "../lib/upload-store";
import { createChatStream } from "../lib/stream";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,expiresAt TEXT);
    INSERT INTO user VALUES ('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user'),('admin','Admin','admin@example.test','superuser');`);
  for (const id of ["alice", "bob", "admin"]) db.prepare("INSERT INTO session VALUES (?,?,?)").run(`${id}-session`, id, new Date(Date.now() + 3600_000).toISOString());
  const store = new Store(db);
  return { db, store, access: new AccessService(store), uploads: new UploadStore(store) };
}
// Starts a real streaming turn whose reply finishes only when the test releases it.
function streaming(store: Store, chatId: string, content: string, fileIds: string[] = []) {
  let finish!: () => void;
  const released = new Promise<void>(resolve => { finish = resolve; });
  const response = createChatStream(store, "alice", chatId, content, "model-a", fileIds, "{}", async input => {
    input.onDelta("Partial answer");
    await Promise.race([released, new Promise(resolve => input.signal.addEventListener("abort", resolve, { once: true }))]);
    if (!input.signal.aborted) input.onDelta(" complete.");
  }, new AbortController().signal);
  const turn = store.messages("alice", chatId).slice(-2);
  return { finish, done: response.text(), user: turn[0], assistant: turn[1] };
}

test("drafts typed while a reply streams are saved, survive completion, and are never cleared by that turn", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    store.saveDraft("alice", chat.id, "First question");
    const reply = streaming(store, chat.id, "First question");
    assert.equal(store.chat("alice", chat.id).draft, "", "The sent text is cleared from the draft when its turn starts");
    store.saveDraft("alice", chat.id, "Next question typed mid-reply", "model-b");
    assert.equal(store.chat("alice", chat.id).draft, "Next question typed mid-reply");
    assert.equal(store.chat("alice", chat.id).model, "model-b");
    reply.finish(); await reply.done;
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "complete");
    assert.equal(store.chat("alice", chat.id).draft, "Next question typed mid-reply", "Completion keeps the next draft");
    assert.equal(store.messages("alice", chat.id)[0].content, "First question", "The streaming turn never absorbs the new draft");
    store.saveDraft("alice", chat.id, "An unrelated newer draft");
    store.beginTurn("alice", chat.id, "Different sent text", "m", []);
    assert.equal(store.chat("alice", chat.id).draft, "An unrelated newer draft", "A newer draft that differs from the sent text is kept");
  } finally { db.close(); }
});

test("files added or removed mid-reply stay pending and bind only to the next turn", async () => {
  const { db, store, access, uploads } = fixture();
  try {
    const chat = store.createChat("alice");
    const own = access.resolve("alice", "alice-session");
    const first = store.addFile("alice", chat.id, "first.txt", Buffer.from("one"), "one", "");
    const reply = streaming(store, chat.id, "Use first.txt", [first.id]);
    assert.equal(store.attachments("alice", chat.id).find(file => file.id === first.id)?.messageId, reply.user.id);
    const chunked = uploads.create(own, chat.id, "second.txt", "txt", 3);
    uploads.append(chunked, 0, Buffer.from("two")); uploads.enqueue(chunked);
    const legacy = store.addFile("alice", chat.id, "third.txt", Buffer.from("three"), "three", "");
    const removable = store.addFile("alice", chat.id, "remove-me.txt", Buffer.from("x"), "x", "");
    store.deleteFile("alice", chat.id, removable.id);
    assert.throws(() => store.deleteFile("alice", chat.id, first.id), /already sent/, "Files bound to the streaming turn stay protected");
    assert.throws(() => store.beginTurn("alice", chat.id, "too early", "m", [legacy.id]), /in progress/, "Send still waits for the reply");
    const pending = store.attachments("alice", chat.id).filter(file => !file.messageId).map(file => file.name).sort();
    assert.deepEqual(pending, ["second.txt", "third.txt"]);
    reply.finish(); await reply.done;
    db.prepare("UPDATE app_file_job SET status='ready' WHERE fileId=?").run(chunked);
    const next = store.beginTurn("alice", chat.id, "Use the new files", "m", [chunked, legacy.id]);
    const bound = store.attachments("alice", chat.id);
    assert.deepEqual(bound.filter(file => file.messageId === reply.user.id).map(file => file.name), ["first.txt"]);
    assert.deepEqual(bound.filter(file => file.messageId === next.user.id).map(file => file.name).sort(), ["second.txt", "third.txt"]);
  } finally { db.close(); }
});

test("mid-reply composer changes keep delegation, audit attribution and account isolation", async () => {
  const { db, store, access, uploads } = fixture();
  try {
    const chat = store.createChat("alice");
    const reply = streaming(store, chat.id, "Owner question");
    const acting = access.start(access.resolve("admin", "admin-session"), "alice");
    access.run(acting, "draft.save", chat.id, () => store.saveDraft(acting.subject.id, chat.id, "ADMIN_DRAFT_TEXT"));
    const file = access.run(acting, "file.upload.begin", null, () => uploads.create(acting, chat.id, "admin.txt", "txt", 1), id => id);
    assert.equal(store.chat("alice", chat.id).draft, "ADMIN_DRAFT_TEXT");
    const audit = db.prepare("SELECT actorId,subjectId,action FROM app_audit WHERE action IN ('draft.save','file.upload.begin')").all();
    assert.deepEqual(audit, [{ actorId: "admin", subjectId: "alice", action: "draft.save" }, { actorId: "admin", subjectId: "alice", action: "file.upload.begin" }]);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM app_audit").all()).includes("ADMIN_DRAFT_TEXT"), false);
    const bob = access.resolve("bob", "bob-session");
    assert.throws(() => access.run(bob, "draft.save", chat.id, () => store.saveDraft("bob", chat.id, "stolen")), /not found/);
    assert.throws(() => store.deleteFile("bob", chat.id, file), /not found/);
    assert.throws(() => uploads.create(bob, chat.id, "bob.txt", "txt", 1), /not found/);
    access.setRoleLocally("admin@example.test", "user");
    assert.throws(() => access.run(acting, "draft.save", chat.id, () => store.saveDraft("alice", chat.id, "after revoke")), /changed/);
    assert.equal(store.chat("alice", chat.id).draft, "ADMIN_DRAFT_TEXT");
    reply.finish(); await reply.done;
  } finally { db.close(); }
});
