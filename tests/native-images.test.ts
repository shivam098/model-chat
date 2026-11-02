import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import Database from "better-sqlite3";
import type { ModelInfo } from "@github/copilot-sdk";
import { Store } from "../lib/store";
import { extractFile, validateFileName } from "../lib/files";
import { nativeImages } from "../lib/native-images";
import { buildPrompt } from "../lib/context";

const model: ModelInfo = { id: "fixture", name: "Fixture", capabilities: {
  supports: { vision: true, reasoningEffort: false },
  limits: { max_context_window_tokens: 100_000, vision: { supported_media_types: ["image/png", "image/jpeg", "image/webp", "image/gif"], max_prompt_images: 4, max_prompt_image_size: 5 * 1024 * 1024 } },
} };
test("raster images are validated and passed as native blobs, not pretend OCR text", async () => {
  for (const format of ["png", "jpeg", "webp", "gif"] as const) {
    const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: "red" } }).toFormat(format).toBuffer();
    const parsed = await extractFile(`sample.${format}`, bytes);
    assert.equal(parsed.mimeType, `image/${format}`);
    assert.match(parsed.text, /Native image input/);
  }
});
test("native image bytes persist, remain owned and are resent when a chat is reopened", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE user(id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'),('bob')");
  try {
    const store = new Store(db);
    const chat = store.createChat("alice");
    const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).png().toBuffer();
    const parsed = await extractFile("photo.png", bytes);
    const file = store.addFile("alice", chat.id, "photo.png", bytes, parsed.text, parsed.notes, parsed.mimeType);
    const blobs = nativeImages(store.contextImages("alice", chat.id, [file.id]), model);
    assert.equal(blobs[0].type, "blob");
    assert.deepEqual(Buffer.from(blobs[0].data, "base64"), bytes);
    const turn = store.beginTurn("alice", chat.id, "Describe the picture", model.id, [file.id]);
    store.saveReply("alice", chat.id, turn.assistant.id, "fixture", "complete");
    assert.deepEqual(nativeImages(store.contextImages("alice", chat.id, []), model), blobs);
    assert.throws(() => store.contextImages("bob", chat.id, []), /not found/);
    assert.throws(() => nativeImages(store.contextImages("alice", chat.id, []), { ...model, capabilities: { ...model.capabilities, supports: { vision: false, reasoningEffort: false } } }), /vision/);
    assert.throws(() => buildPrompt([], [], "test", 0), /budget/);
  } finally { db.close(); }
});
test("unsupported or misleading inputs fail explicitly instead of pretending to analyze media", async () => {
  await assert.rejects(() => extractFile("fake.png", Buffer.from("<svg></svg>")), /do not match/);
  await assert.rejects(() => extractFile("bad.jpg", Buffer.from("not a jpeg")), /do not match/);
  for (const name of ["recording.wav", "music.mp3", "clip.mp4", "movie.webm"]) assert.equal(validateFileName(name), name.split(".").at(-1));
  assert.throws(() => validateFileName("network-playlist.m3u8"), /supported/);
  const bytes = await sharp({ create: { width: 8200, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(() => extractFile("wide.png", bytes), /dimension limit/);
});
