import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { crc32, deflateSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
test("native image bytes persist and remain available only to their owner after reopening", async () => {
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
  const panorama = await sharp({ create: { width: 20000, height: 900, channels: 3, background: "red" } }).jpeg().toBuffer();
  assert.match((await extractFile("panorama.jpg", panorama)).text, /20000 x 900/);
});

function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(1000))), chunk("IEND", Buffer.alloc(0))]);
}
async function processUpload(name: string, bytes: Buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-chat-image-"));
  try {
    const input = path.join(directory, name);
    await writeFile(input, bytes);
    const worker = new Worker(path.resolve("scripts", "extract-file.mjs"), { workerData: { inputPath: input, outputPath: path.join(directory, "text.txt"), extension: name.split(".").at(-1) } });
    try { return await new Promise<{ ok: boolean; error?: string; analysisBytes?: Uint8Array }>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }); }
    finally { await worker.terminate(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("large phone photos are accepted, turned upright and shrunk for the model; unsafe images get plain messages", { timeout: 60_000 }, async () => {
  // Stored as red | green over blue | yellow, with EXIF orientation 6 (display rotated 90 degrees clockwise).
  const quarter = (background: string) => ({ create: { width: 4000, height: 3000, channels: 3 as const, background } });
  const photo = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "yellow" } })
    .composite([{ input: quarter("red"), left: 0, top: 0 }, { input: quarter("lime"), left: 4000, top: 0 }, { input: quarter("blue"), left: 0, top: 3000 }])
    .jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  const accepted = await processUpload("phone.jpg", photo);
  assert.equal(accepted.ok, true, accepted.error);
  const { data, info } = await sharp(Buffer.from(accepted.analysisBytes!)).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1536, 2048]);
  const pixel = (x: number) => [...data.subarray(x * info.channels, x * info.channels + 3)].map(value => Math.round(value / 255));
  assert.deepEqual([pixel(5), pixel(info.width - 6)], [[0, 0, 1], [1, 0, 0]]);

  const rejected = async (name: string, bytes: Buffer, expected: RegExp) => {
    const result = await processUpload(name, bytes);
    assert.equal(result.ok, false);
    assert.match(result.error!, expected);
    assert.doesNotMatch(result.error!, /Input image|vips|libpng|jpeg_/i);
  };
  await rejected("huge.png", png(100_000, 100_000), /100,000 × 100,000 pixels.*up to 268 megapixels.*Export a smaller copy/);
  await rejected("bomb.png", png(16_000, 16_000), /only 1 KB but claims to hold 16,000 × 16,000 pixels/);
  const damaged = Buffer.from(photo); for (let index = 4; index < 400; index++) damaged[index] = index * 37 & 0xff;
  await rejected("damaged.jpg", damaged, /couldn't be read.*export it again as JPEG or PNG/);
});
