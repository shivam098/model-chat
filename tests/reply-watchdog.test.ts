import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Store } from "../lib/store";
import { createChatStream, stopReply } from "../lib/stream";
import { silenceWatchdog } from "../lib/reply-watchdog";
import { droppedThinkingError, silentCallDropped, thinkingExhausted, type ReplyInput } from "../lib/copilot";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,expiresAt TEXT);
    INSERT INTO user VALUES ('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user'),('carol','Carol','carol@example.test','user');`);
  return { db, store: new Store(db) };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const untilAborted = (input: ReplyInput) => new Promise<never>((_, reject) => {
  const fail = () => reject(new DOMException("Reply cancelled", "AbortError"));
  if (input.signal.aborted) fail(); else input.signal.addEventListener("abort", fail, { once: true });
});
// Scaled down: a 100 ms silence window stands in for the real 30 minutes.
const SILENCE = 100;
const reply = (store: Store, user: string, chatId: string, runner: (input: ReplyInput) => Promise<void>) =>
  createChatStream(store, user, chatId, "Question", "model-a", [], "{}", runner, new AbortController().signal, undefined, undefined, { silenceMs: SILENCE }).text();

test("the silence watchdog restarts on activity, pauses while held and fires only after a full silent window", async () => {
  let fired = 0;
  const dog = silenceWatchdog(60, () => fired++);
  for (let i = 0; i < 6; i++) { await sleep(25); dog.touch(); }
  assert.equal(fired, 0, "Steady activity past several windows never trips it");
  const resume = dog.hold();
  await sleep(150);
  assert.equal(fired, 0, "Held (waiting on the owner): no silence is counted");
  resume(); resume();
  await sleep(120);
  assert.equal(fired, 1, "After resuming, a full silent window ends it once");
  dog.touch(); await sleep(100);
  assert.equal(fired, 1, "A fired watchdog stays stopped");
  const stopped = silenceWatchdog(20, () => fired++);
  stopped.stop(); await sleep(50);
  assert.equal(fired, 1);
});

test("a request that keeps producing events runs far past the window (and past the old fixed limits) and completes", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    await reply(store, "alice", chat.id, async input => {
      // Long thinking: reasoning events keep arriving, slower than the heartbeat but faster than the silence window.
      for (let i = 0; i < 12; i++) { await sleep(60); input.onActivity?.(); input.onReasoning?.("thinking… ", false); }
      input.onDelta("Final answer after a long think.");
    });
    const done = store.messages("alice", chat.id).at(-1)!;
    assert.equal(done.status, "complete", "Never stopped while still working");
    assert.equal(done.content, "Final answer after a long think.");
    assert.ok(done.reasoning.length > 0);
  } finally { db.close(); }
});

test("a completely silent request is ended by the watchdog with a plain message, keeps its partial text and frees its slots", async () => {
  const { db, store } = fixture();
  try {
    const first = store.createChat("alice"), second = store.createChat("bob");
    const silentAlice = reply(store, "alice", first.id, async input => { input.onActivity?.(); input.onDelta("Partial text"); await untilAborted(input); });
    const silentBob = reply(store, "bob", second.id, async input => { await untilAborted(input); });
    await sleep(20);
    await Promise.all([silentAlice, silentBob]);
    const ended = store.messages("alice", first.id).at(-1)!;
    assert.equal(ended.status, "error");
    assert.equal(ended.content, "Partial text", "Partial text is saved");
    assert.match(ended.error!, /^The model stopped responding: nothing arrived for \d+ seconds, so the reply was ended\. The partial text above is saved\.$/);
    assert.match(store.messages("bob", second.id).at(-1)!.error!, /stopped responding.*No text had arrived yet\./);
    // The chat is free for its next reply.
    await reply(store, "alice", first.id, async input => { input.onDelta("Next reply."); });
    await reply(store, "carol", store.createChat("carol").id, async input => { input.onDelta("Also fine."); });
    assert.equal(store.messages("alice", first.id).at(-1)!.status, "complete");
  } finally { db.close(); }
});

test("Stop ends a long-running request at any time, and waiting on the owner (held) is never counted as silence", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    const running = reply(store, "alice", chat.id, async input => {
      input.onDelta("Working");
      const tick = setInterval(() => input.onActivity?.(), 30);
      try { await untilAborted(input); } finally { clearInterval(tick); }
    });
    await sleep(250);
    stopReply(store, "alice", chat.id);
    await running;
    const stopped = store.messages("alice", chat.id).at(-1)!;
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.error, "Reply stopped. Any partial text is saved.");

    await reply(store, "alice", chat.id, async input => {
      // A coding approval: the owner takes several silence windows to answer.
      const resume = input.holdActivity!();
      await sleep(SILENCE * 3);
      resume();
      input.onActivity?.();
      input.onDelta("Approved and done.");
    });
    assert.equal(store.messages("alice", chat.id).at(-1)!.status, "complete");
  } finally { db.close(); }
});

test("a model that spends its whole output allowance on thinking gets a plain explanation instead of a generic refusal", () => {
  // Shape of the runtime's assistant.usage event measured with Claude Opus 5.5 at Max.
  const usage = { model: "claude-opus-5.5", modelDisplayName: "Claude Opus 5.5", finishReason: "length", maxOutputTokens: 32000 };
  const error = thinkingExhausted(usage, false)!;
  assert.equal(error.status, 503);
  assert.equal(error.message, "Claude Opus 5.5 used its whole 32,000-token output allowance thinking before writing an answer, and Copilot couldn't continue the reply. Its thinking is saved under Show thinking. Try a lower thinking level (for example High) or another model.");
  assert.equal(thinkingExhausted(usage, true), null, "A reply that already has answer text isn't affected");
  assert.equal(thinkingExhausted({ ...usage, finishReason: "stop" }, false), null);
});

test("a GPT call dropped after long silent thinking is recognised, and the final error says so plainly", () => {
  // Shape of the runtime's model.call_failure event measured with GPT-6 Sol at Max.
  assert.equal(silentCallDropped({ failureKind: "transport", durationMs: 631_237 }), 11);
  assert.equal(silentCallDropped({ failureKind: "transport", durationMs: 20_000 }), null, "A quick network blip isn't silent thinking");
  assert.equal(silentCallDropped({ failureKind: "api", durationMs: 631_237 }), null);
  assert.match(droppedThinkingError(11).message, /^The connection to the model closed after about 11 minutes of silent thinking, and Copilot's retries didn't finish either\./);
});
