import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { ModelInfo } from "@github/copilot-sdk";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { prepareImageTurn } from "../lib/image-turn";
import { createChatStream } from "../lib/stream";
import { SYSTEM_INSTRUCTION } from "../lib/context";
import type { ReplyRunner } from "../lib/copilot";

const model: ModelInfo = { id: "single-image-fixture", name: "Fixture", capabilities: {
  supports: { vision: true, reasoningEffort: false },
  limits: { max_context_window_tokens: 128000, vision: { max_prompt_images: 1, max_prompt_image_size: 5 * 1024 * 1024, supported_media_types: ["image/png", "image/jpeg"] } },
} };
function fixture(filename = ":memory:") {
  const db = new Database(filename);
  db.exec(`CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT);
    CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY,userId TEXT,expiresAt TEXT);
    INSERT OR IGNORE INTO user VALUES ('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user'),('admin','Admin','admin@example.test','superuser');`);
  for (const id of ["alice", "bob", "admin"]) db.prepare("INSERT OR REPLACE INTO session VALUES (?,?,?)").run(id + "-session", id, new Date(Date.now() + 3600000).toISOString());
  const store = new Store(db), access = new AccessService(store);
  return { db, store, access };
}
async function image(store: Store, chatId: string, name: string, color: string) {
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: color } }).png().toBuffer();
  return { file: store.addFile("alice", chatId, name, bytes, "[Image]", "", "image/png"), bytes };
}
async function send(store: Store, chatId: string, files: string[], runner: ReplyRunner, selected = model, content = "Compare every file and image.") {
  const prepared = prepareImageTurn(store, "alice", chatId, content, files, selected, runner);
  const response = createChatStream(store, "alice", chatId, content, selected.id, files, prepared.prompt, prepared.runner, new AbortController().signal);
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  return { prepared, events, last: store.messages("alice", chatId).at(-1)! };
}
test("one mixed-file turn includes all six files; overflow adds exactly one detailed request and persists by image", async () => {
  const directory = await mkdtemp(path.resolve(".local", "image-turn-test-"));
  let db: Database.Database | undefined;
  try {
    const first = fixture(path.join(directory, "test.db"));
    db = first.db;
    const { store } = first;
    const chat = store.createChat("alice");
    const red = await image(store, chat.id, "red.png", "red");
    const blue = await image(store, chat.id, "blue.png", "blue");
    const files = [red.file, blue.file, ...["txt", "csv", "json", "md"].map(ext =>
      store.addFile("alice", chat.id, `notes.${ext}`, Buffer.from("Fixture value 42"), "Fixture value 42", ""))];
    const calls: { prompt: string; pixels: Buffer[] }[] = [];
    const runner: ReplyRunner = async input => {
      input.onRequestStart?.();
      const body = JSON.parse(input.prompt);
      calls.push({ prompt: input.prompt, pixels: (input.images || []).map(image => Buffer.from(image.data, "base64")) });
      if (body.conversation.at(-1).content.startsWith("Inspect EACH")) {
        assert.deepEqual(calls.at(-1)!.pixels, [blue.bytes], "Overflow uses supplied pixels, not a collage or thumbnail");
        input.onReplace(JSON.stringify({ images: body.files.map((file: { id: string }) => ({ id: file.id, analysis: "Detailed blue image evidence, including visible value 42." })) }));
      } else {
        assert.equal(body.files.length, 6);
        assert.equal(body.imageContext.find((entry: { id: string }) => entry.id === blue.file.id).evidence, "saved_ai_analysis");
        assert.deepEqual(calls.at(-1)!.pixels, [red.bytes]);
        input.onDelta("One answer covering all six files.");
      }
    };
    const result = await send(store, chat.id, files.map(file => file.id), runner);
    assert.equal(result.prepared.additionalRequests, 1);
    assert.equal(calls.length, 2);
    assert.equal(result.last.status, "complete");
    assert.equal(store.attachments("alice", chat.id).filter(file => file.messageId).length, 6);
    assert.equal((store.db.prepare("SELECT count(*) n FROM app_image_analysis").get() as { n: number }).n, 1);
    const originals = store.messages("alice", chat.id);
    db.close(); db = undefined;
    const second = fixture(path.join(directory, "test.db"));
    db = second.db;
    assert.deepEqual(second.store.messages("alice", chat.id), originals);
    const green = await image(second.store, chat.id, "green.png", "green");
    const read = second.store.imageFile.bind(second.store);
    second.store.imageFile = (userId, chatId, source) => {
      assert.equal(source.id, green.file.id, "Earlier images must not be reopened merely to send a new image");
      return read(userId, chatId, source);
    };
    let followCalls = 0;
    const follow = await send(second.store, chat.id, [green.file.id], async input => {
      followCalls++;
      const body = JSON.parse(input.prompt);
      assert.deepEqual((input.images || []).map(image => Buffer.from(image.data, "base64")), [green.bytes]);
      assert.equal(body.imageContext.find((entry: { id: string }) => entry.id === red.file.id).evidence, "prior_conversation_only");
      assert.equal(body.imageContext.find((entry: { id: string }) => entry.id === blue.file.id).model, model.id);
      input.onDelta("Green, with saved prior evidence.");
    }, { ...model, id: "another-model" });
    assert.equal(follow.prepared.additionalRequests, 0);
    assert.equal(followCalls, 1);
    assert.equal(follow.last.status, "complete");
    assert.throws(() => second.store.imageAnalysis("bob", chat.id, { id: blue.file.id, fileId: blue.file.id, name: "", mimeType: "image/png", size: 0 }), /not found/);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
});
test("within-limit images make one request; overflow batches respect the model limit and video-frame provenance", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    const pixels = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).jpeg().toBuffer();
    const video = store.addFile("alice", chat.id, "video.mp4", Buffer.from("original"), "Machine transcript", "", "video/mp4",
      [0, 1, 2, 3].map(seconds => ({ seconds, mimeType: "image/jpeg", bytes: pixels })));
    const two = { ...model, capabilities: { ...model.capabilities, limits: { ...model.capabilities.limits, vision: { ...model.capabilities.limits.vision!, max_prompt_images: 2 } } } };
    let calls = 0;
    const result = await send(store, chat.id, [video.id], async input => {
      calls++; assert.equal(input.images?.length, 2);
      const body = JSON.parse(input.prompt);
      if (calls === 1) {
        assert.match(body.files[0].name, /sample at 2.00s/);
        input.onReplace(JSON.stringify({ images: body.files.map((file: { id: string }) => ({ id: file.id, analysis: "Blue frame." })) }));
      } else input.onDelta("Four sampled frames analyzed.");
    }, two);
    assert.equal(calls, 2); assert.equal(result.prepared.additionalRequests, 1); assert.equal(result.last.status, "complete");
    const next = store.createChat("alice");
    const single = await image(store, next.id, "one.png", "red");
    let one = 0;
    const within = await send(store, next.id, [single.file.id], async input => { one++; input.onDelta("Red."); });
    assert.equal(one, 1); assert.equal(within.prepared.additionalRequests, 0);
  } finally { db.close(); }
});
test("invalid overflow never synthesizes a pretend combined answer and non-vision rejection is preflight", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    const first = await image(store, chat.id, "a.png", "red");
    const second = await image(store, chat.id, "b.png", "blue");
    let calls = 0;
    const result = await send(store, chat.id, [first.file.id, second.file.id], async input => {
      calls++; input.onReplace('{"images":[]}');
    });
    assert.equal(calls, 1); assert.equal(result.last.status, "error");
    assert.equal(result.last.content, ""); assert.equal(store.attachments("alice", chat.id).filter(file => file.messageId).length, 2);
    assert.equal((db.prepare("SELECT count(*) n FROM app_image_analysis").get() as { n: number }).n, 0);
    const textModel = { ...model, capabilities: { ...model.capabilities, supports: { vision: false, reasoningEffort: false } } };
    const pending = await image(store, chat.id, "c.png", "green");
    assert.throws(() => prepareImageTurn(store, "alice", chat.id, "look", [pending.file.id], textModel, async () => {}), /vision/);
    assert.equal(store.messages("alice", chat.id).length, 2, "Preflight failure cannot append a turn");
  } finally { db.close(); }
});
test("cancellation stops the remaining image requests but preserves completed analysis and every attachment", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    const images = await Promise.all(["red", "blue", "green"].map(color => image(store, chat.id, `${color}.png`, color)));
    const abort = new AbortController();
    let calls = 0;
    const files = images.map(image => image.file.id);
    const prepared = prepareImageTurn(store, "alice", chat.id, "Compare", files, model, async input => {
      calls++;
      if (calls === 2) { abort.abort(); return; }
      const body = JSON.parse(input.prompt);
      input.onReplace(JSON.stringify({ images: body.files.map((file: { id: string }) => ({ id: file.id, analysis: "Completed blue analysis." })) }));
    });
    await createChatStream(store, "alice", chat.id, "Compare", model.id, files, prepared.prompt, prepared.runner, abort.signal).text();
    assert.equal(calls, 2, "Cancellation must prevent synthesis and any further calls");
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "cancelled");
    assert.equal((db.prepare("SELECT count(*) n FROM app_image_analysis").get() as { n: number }).n, 1);
    assert.equal(store.attachments("alice", chat.id).filter(file => file.messageId).length, 3);
  } finally { db.close(); }
});
test("analysis-table migration preserves populated old rows and deletion cascades only to owned analyses", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    const file = await image(store, chat.id, "preserved.png", "red");
    const turn = store.beginTurn("alice", chat.id, "Original prompt", model.id, [file.file.id]);
    store.saveReply("alice", chat.id, turn.assistant.id, "Original reply", "complete");
    store.saveDraft("alice", chat.id, "Original draft");
    db.exec("DROP TABLE app_image_analysis");
    const tables = ["user", "session", "app_chat", "app_message", "app_file", "app_media_frame"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const migrated = new Store(db);
    assert.deepEqual(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()), before);
    const source = migrated.imageSources("alice", chat.id, [])[0];
    migrated.saveImageAnalysis("alice", chat.id, source, model.id, "Saved analysis.");
    assert.throws(() => migrated.saveImageAnalysis("bob", chat.id, source, model.id, "Replace"), /not found/);
    migrated.deleteChat("alice", chat.id);
    assert.equal((db.prepare("SELECT count(*) n FROM app_image_analysis").get() as { n: number }).n, 0);
  } finally { db.close(); }
});
test("delegated analysis saves only under current authority and audits actor/subject without image content", async () => {
  const { db, store, access } = fixture();
  try {
    const chat = store.createChat("alice");
    const first = await image(store, chat.id, "first.png", "red");
    const second = await image(store, chat.id, "second.png", "blue");
    const context = access.start(access.resolve("admin", "admin-session"), "alice");
    const prepared = prepareImageTurn(store, "alice", chat.id, "Compare", [first.file.id, second.file.id], model, async input => {
      const body = JSON.parse(input.prompt);
      input.onReplace(JSON.stringify({ images: body.files.map((file: { id: string }) => ({ id: file.id, analysis: "PRIVATE_IMAGE_TEXT_NOT_FOR_AUDIT" })) }));
      access.setRoleLocally("admin@example.test", "user");
    }, (id, outcome, reason) => access.record(context, "image.analysis", id, outcome, reason, true));
    const response = createChatStream(store, "alice", chat.id, "Compare", model.id, [first.file.id, second.file.id], prepared.prompt, prepared.runner, new AbortController().signal, {
      actorId: "admin", sessionId: "admin-session", check: () => { access.check(context); }, accepted: () => {}, finished: () => {},
    });
    await response.text();
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "cancelled");
    assert.equal((db.prepare("SELECT count(*) n FROM app_image_analysis").get() as { n: number }).n, 0);
    const audit = db.prepare("SELECT actorId,subjectId,outcome,reason FROM app_audit WHERE action='image.analysis'").all();
    assert.ok(audit.some(row => (row as { outcome: string }).outcome === "denied"));
    assert.ok(audit.every(row => (row as { actorId: string; subjectId: string }).actorId === "admin" && (row as { subjectId: string }).subjectId === "alice"));
    assert.equal(JSON.stringify(audit).includes("PRIVATE_IMAGE_TEXT"), false);
  } finally { db.close(); }
});
test("many file excerpts fit remaining context without dropping any selected file or saved history", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    const previous = store.beginTurn("alice", chat.id, "old question", model.id, []);
    store.saveReply("alice", chat.id, previous.assistant.id, "Previous context. ".repeat(3800), "complete");
    const before = store.messages("alice", chat.id);
    const files = Array.from({ length: 10 }, (_, index) => store.addFile("alice", chat.id, `${index}.txt`, Buffer.from("original"), "Long file data. ".repeat(5000), ""));
    const result = await send(store, chat.id, files.map(file => file.id), async input => {
      const body = JSON.parse(input.prompt);
      assert.equal(body.files.length, 10);
      assert.ok(body.files.every((file: { text: string }) => file.text.includes("Selected excerpts")));
      assert.ok(Buffer.byteLength(input.prompt) + Buffer.byteLength(SYSTEM_INSTRUCTION) < 100000);
      input.onDelta("All ten file excerpts considered.");
    });
    assert.equal(result.last.status, "complete");
    assert.deepEqual(store.messages("alice", chat.id).slice(0, 2), before);
  } finally { db.close(); }
});
