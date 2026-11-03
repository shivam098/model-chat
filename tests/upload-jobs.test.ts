import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import JSZip from "jszip";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { UploadStore, fileContextExcerpt, fileTextPage } from "../lib/upload-store";
import { FileJobQueue } from "../lib/file-jobs";
import { buildPrompt } from "../lib/context";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT DEFAULT 'user');
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT REFERENCES user(id) ON DELETE CASCADE,expiresAt TEXT);
    INSERT INTO user VALUES ('admin','Admin','admin@example.test','superuser'),('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user');`);
  for (const user of ["admin", "alice", "bob"]) db.prepare("INSERT INTO session VALUES (?,?,?)").run(`${user}-session`, user, new Date(Date.now() + 3600_000).toISOString());
  const store = new Store(db), access = new AccessService(store), uploads = new UploadStore(store);
  const own = access.resolve("alice", "alice-session"), chat = store.createChat("alice");
  return { db, store, access, uploads, own, chat };
}
test("ordered idempotent chunks bind to owner and actor session; original bytes survive cancel/retry/recovery", () => {
  const { db, store, access, uploads, own, chat } = fixture();
  try {
    const id = uploads.create(own, chat.id, "private.txt", "txt", 6);
    assert.throws(() => uploads.assertUploader(access.resolve("bob", "bob-session"), id), /different/);
    assert.throws(() => uploads.append(id, 1, Buffer.from("abc")), /order/);
    uploads.append(id, 0, Buffer.from("abc"));
    uploads.append(id, 0, Buffer.from("abc"));
    assert.equal(store.file("alice", chat.id, id).size, 3);
    assert.throws(() => uploads.append(id, 0, Buffer.from("bad")), /match/);
    assert.throws(() => uploads.enqueue(id), /incomplete/);
    uploads.append(id, 1, Buffer.from("def"));
    uploads.enqueue(id); uploads.enqueue(id);
    assert.throws(() => store.contextFiles("alice", chat.id, [id]), /still processing/);
    const first = uploads.claim(false)!;
    uploads.cancel(own, chat.id, id);
    assert.throws(() => uploads.check(first), /cancelled/);
    assert.equal(Buffer.concat([...uploads.rawChunks(id)]).toString(), "abcdef");
    uploads.retry(own, chat.id, id);
    const second = uploads.claim(false)!;
    assert.notEqual(first.lease, second.lease);
    uploads.fail(first, "stale error");
    assert.equal(uploads.job(id)?.status, "processing");
    uploads.recover();
    assert.equal(uploads.job(id)?.status, "queued");
    assert.equal(Buffer.concat([...uploads.rawChunks(id)]).toString(), "abcdef");
    const hiddenExecutable = uploads.create(own, chat.id, "fake.txt", "txt", 3);
    uploads.append(hiddenExecutable, 0, Buffer.from("M")); uploads.append(hiddenExecutable, 1, Buffer.from("Z!"));
    assert.throws(() => uploads.enqueue(hiddenExecutable), /Executable/);
    const incomplete = uploads.create(own, chat.id, "unfinished.txt", "txt", 20);
    uploads.recover();
    assert.equal(uploads.job(incomplete)?.status, "failed");
    assert.throws(() => uploads.retry(own, chat.id, incomplete), /completely/);
    assert.throws(() => [...uploads.rawChunks(incomplete)], /incomplete/);
    store.deleteChat("alice", chat.id);
    for (const table of ["app_file_chunk", "app_file_job", "app_text_chunk"]) assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, 0);
  } finally { db.close(); }
});
test("accepted delegated jobs retain their subject on return, but revocation and logout stop access", () => {
  const { db, access, uploads, chat } = fixture();
  try {
    const acting = access.start(access.resolve("admin", "admin-session"), "alice");
    const id = uploads.create(acting, chat.id, "note.txt", "txt", 4);
    uploads.append(id, 0, Buffer.from("note")); uploads.enqueue(id);
    const job = uploads.claim(false)!;
    access.stop(acting);
    assert.doesNotThrow(() => uploads.check(job));
    access.setRoleLocally("admin@example.test", "user");
    assert.throws(() => uploads.check(job), /cancelled/);
    access.setRoleLocally("admin@example.test", "superuser");
    assert.throws(() => uploads.check(job), /cancelled/);
    const fresh = access.start(access.resolve("admin", "admin-session"), "alice");
    uploads.retry(fresh, chat.id, id);
    const second = uploads.claim(false)!;
    db.prepare("DELETE FROM session WHERE id='admin-session'").run();
    access.logout("admin", "admin-session");
    assert.throws(() => uploads.check(second), /cancelled/);
    assert.deepEqual(db.prepare("SELECT actorId,subjectId,outcome,reason FROM app_audit WHERE action='file.process'").get(),
      { actorId: "admin", subjectId: "alice", outcome: "denied", reason: "role_changed" });
  } finally { db.close(); }
});
test("background processing indexes full large text, preserves drafts, isolates search and normalizes images", { timeout: 45_000 }, async () => {
  const { db, store, access, uploads, own, chat } = fixture();
  const queue = new FileJobQueue(store);
  try {
    const prior = store.beginTurn("alice", chat.id, "Old private prompt", "model-a", []);
    store.saveReply("alice", chat.id, prior.assistant.id, "Old private reply", "complete");
    store.saveDraft("alice", chat.id, "Keep this draft", "model-b");
    const before = store.messages("alice", chat.id);
    const text = "Ordinary material.\n".repeat(4000) + "ZEBRA421 special finding after the old text limit.\n" + "More material.\n".repeat(4000);
    const id = uploads.create(own, chat.id, "long.txt", "txt", Buffer.byteLength(text));
    uploads.append(id, 0, Buffer.from(text)); uploads.enqueue(id);
    const imageBytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).png().toBuffer();
    const image = uploads.create(own, chat.id, "image.png", "png", imageBytes.length);
    uploads.append(image, 0, imageBytes); uploads.enqueue(image);
    const zip = new JSZip();
    zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Background DOCX text.</w:t></w:r></w:p></w:body></w:document>');
    const doc = await zip.generateAsync({ type: "nodebuffer" });
    const document = uploads.create(own, chat.id, "office.docx", "docx", doc.length);
    uploads.append(document, 0, doc); uploads.enqueue(document);
    db.prepare("DELETE FROM session WHERE id='alice-session'").run();
    queue.start();
    for (let count = 0; count < 300 && [id, image, document].some(file => ["queued", "processing"].includes(uploads.job(file)!.status)); count++) await delay(50);
    for (const file of [id, image, document]) assert.equal(uploads.job(file)?.status, "ready", uploads.job(file)?.error || file);
    let full = "", cursor: number | null = 0;
    do { const page = fileTextPage(db, id, cursor); full += page.text; cursor = page.nextCursor; } while (cursor !== null);
    assert.equal(full, text);
    const excerpt = fileContextExcerpt(db, id, "Where is ZEBRA421?", 8000);
    assert.match(excerpt, /ZEBRA421/); assert.match(excerpt, /not the entire file/); assert.ok(excerpt.length <= 8000);
    assert.ok(fileContextExcerpt(db, id, "summary", 1000).length <= 1000);
    const unicode = store.addFile("alice", chat.id, "unicode.txt", Buffer.from("original"), "\u4f60\u597d\n".repeat(10000), "");
    assert.ok(Buffer.byteLength(JSON.stringify(fileContextExcerpt(db, unicode.id, "", 8000))) <= 8000);
    assert.deepEqual(store.messages("alice", chat.id), before);
    assert.equal(store.chat("alice", chat.id).draft, "Keep this draft");
    assert.equal(store.chat("alice", chat.id).model, "model-b");
    assert.throws(() => store.contextFiles("bob", chat.id, [id]), /not found/);
    assert.match(store.fileText("alice", chat.id, document).text, /Background DOCX/);
    assert.deepEqual(Buffer.concat([...uploads.rawChunks(image)]), imageBytes);
    assert.equal(store.contextImages("alice", chat.id, [image])[0].mimeType, "image/jpeg");
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM app_audit").all()).includes("ZEBRA421"), false);
    const prompt = JSON.parse(buildPrompt([], [], "Hello", undefined, [{ name: "pending.wav", status: "processing" }]));
    assert.equal(prompt.files.length, 0); assert.equal(prompt.unavailableFiles[0].status, "processing");
    assert.equal(access.resolve("bob", "bob-session").subject.id, "bob");
  } finally { await queue.stop(); db.close(); }
});
test("populated old-schema migration preserves original rows and backup manifests handle FTS tables", async () => {
  const directory = await mkdtemp(path.resolve(".local", "upload-migration-test-"));
  const filename = path.join(directory, "model-chat.db");
  let db: Database.Database | undefined;
  try {
    db = new Database(filename);
    db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('preserved-user')");
    const before = new Store(db);
    const chat = before.createChat("preserved-user");
    const file = before.addFile("preserved-user", chat.id, "original.txt", Buffer.from("Original file bytes"), "Original file text", "");
    const turn = before.beginTurn("preserved-user", chat.id, "Original prompt", "original-model", [file.id]);
    before.saveReply("preserved-user", chat.id, turn.assistant.id, "Original reply", "complete");
    before.saveDraft("preserved-user", chat.id, "Original unsent draft");
    db.exec("DROP TRIGGER app_text_insert; DROP TRIGGER app_text_delete; DROP TABLE app_text_search; DROP TABLE app_text_chunk; DROP TABLE app_file_chunk; DROP TABLE app_file_job; DROP TABLE app_analysis_image;");
    db.close(); db = undefined;
    const backup = () => {
      const result = spawnSync(process.execPath, ["scripts/backup-db.mjs"], { env: { ...process.env, MODEL_CHAT_DATA_DIR: directory }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))).manifestPath as string;
    };
    const originalManifest = backup();
    db = new Database(filename);
    const after = new Store(db);
    assert.equal(after.chat("preserved-user", chat.id).draft, "Original unsent draft");
    assert.equal(after.messages("preserved-user", chat.id)[1].content, "Original reply");
    assert.deepEqual(after.file("preserved-user", chat.id, file.id).bytes, Buffer.from("Original file bytes"));
    db.prepare("INSERT INTO app_text_chunk(fileId,position,content) VALUES (?,0,?)").run(file.id, "Original file text");
    db.close(); db = undefined;
    const verify = (manifest: string) => {
      const result = spawnSync(process.execPath, ["scripts/backup-db.mjs", "--verify", manifest], { env: { ...process.env, MODEL_CHAT_DATA_DIR: directory }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    verify(originalManifest);
    verify(backup());
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
});
