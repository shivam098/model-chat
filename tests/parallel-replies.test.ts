import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { createChatStream, stopReply, type StreamSecurity } from "../lib/stream";
import { MEMORY_RESERVE_MB, REPLY_MEMORY_MB, WAITING_STAGE, waitForMemory } from "../lib/capacity";
import { acquireSandbox, reserveSandbox } from "../lib/sandbox";
import { copilotError, type ReplyInput } from "../lib/copilot";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,expiresAt TEXT);
    INSERT INTO user VALUES ('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user'),('admin','Admin','admin@example.test','superuser');`);
  for (const id of ["alice", "bob", "admin"]) db.prepare("INSERT INTO session VALUES (?,?,?)").run(`${id}-session`, id, new Date(Date.now() + 3600_000).toISOString());
  const store = new Store(db);
  return { db, store, access: new AccessService(store) };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const plenty = { available: () => 1_000_000, pollMs: 10 };
const security = (actorId: string, sessionId: string): StreamSecurity => ({ actorId, sessionId, check: () => {}, accepted: () => {}, finished: () => {} });
/** A reply whose model keeps working until released; reports when it actually started. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const runner = async (input: ReplyInput) => {
    started = true;
    input.onDelta("Working");
    await Promise.race([gate, new Promise(resolve => input.signal.addEventListener("abort", resolve, { once: true }))]);
    if (!input.signal.aborted) input.onDelta(" and done.");
  };
  return { runner, release, started: () => started };
}

test("many chats stream at once: one account's chats, other accounts, and a superuser alongside the user they're acting as", async () => {
  const { db, store, access } = fixture();
  try {
    const acting = access.start(access.resolve("admin", "admin-session"), "alice");
    const plan = [
      { user: "alice", by: security("alice", "alice-session") },
      { user: "alice", by: security("alice", "alice-session") },
      { user: "alice", by: security("alice", "alice-session") },
      { user: "bob", by: security("bob", "bob-session") },
      { user: "admin", by: security("admin", "admin-session") },
      { user: "alice", by: security(acting.actor.id, acting.sessionId) },
    ];
    const replies = plan.map(({ user, by }) => {
      const chat = store.createChat(user);
      const reply = held();
      const done = createChatStream(store, user, chat.id, "Question", "m", [], "{}", reply.runner, new AbortController().signal, by, undefined, { memory: plenty }).text();
      return { user, chat: chat.id, reply, done };
    });
    for (let i = 0; i < 100 && !replies.every(item => item.reply.started()); i++) await sleep(10);
    assert.ok(replies.every(item => item.reply.started()), "Every reply is generating at the same time");
    assert.equal(replies.filter(item => store.messages(item.user, item.chat).at(-1)?.status === "streaming").length, 6);
    // Each chat still runs one reply at a time.
    assert.throws(() => createChatStream(store, "alice", replies[0].chat, "Again", "m", [], "{}", held().runner, new AbortController().signal), /already running in this chat/);
    for (const item of replies) item.reply.release();
    await Promise.all(replies.map(item => item.done));
    assert.ok(replies.every(item => store.messages(item.user, item.chat).at(-1)?.content === "Working and done."));
  } finally { db.close(); }
});

test("short of memory, a reply waits to start (never an error), starts by itself when memory frees up, and Stop cancels it while it waits", async () => {
  const { db, store } = fixture();
  try {
    let free = MEMORY_RESERVE_MB;
    const memory = { available: () => free, pollMs: 10 };
    const chat = store.createChat("alice");
    const reply = held();
    const response = createChatStream(store, "alice", chat.id, "Question", "m", [], "{}", reply.runner, new AbortController().signal, undefined, undefined, { memory });
    const reader = response.body!.getReader();
    const seen: { type: string; stage?: string }[] = [];
    const pump = (async () => { const decoder = new TextDecoder(); let buffer = ""; for (;;) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let i; while ((i = buffer.indexOf("\n")) >= 0) { seen.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } } })();
    await sleep(80);
    assert.equal(reply.started(), false, "Not started yet");
    assert.ok(seen.some(event => event.type === "progress" && event.stage === WAITING_STAGE), "Shows that it's waiting to start");
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "streaming");
    assert.equal(seen.some(event => event.type === "error"), false);
    free = 10_000;
    for (let i = 0; i < 100 && !reply.started(); i++) await sleep(10);
    assert.ok(reply.started(), "Starts as soon as memory frees up");
    assert.ok(seen.some(event => event.type === "progress" && event.stage === "Generating reply"));
    reply.release();
    await pump;
    assert.equal(store.messages("alice", chat.id).at(-1)?.status, "complete");

    // Stop while waiting: cancelled cleanly, the model never called, and the chat is free again.
    free = 0;
    const never = held();
    const stopped = createChatStream(store, "alice", chat.id, "Another", "m", [], "{}", never.runner, new AbortController().signal, undefined, undefined, { memory }).text();
    await sleep(50);
    stopReply(store, "alice", chat.id);
    await stopped;
    assert.equal(never.started(), false);
    const last = store.messages("alice", chat.id).at(-1)!;
    assert.equal(last.status, "cancelled");
    assert.equal(last.error, "Reply stopped. Any partial text is saved.");
    free = 10_000;
    await createChatStream(store, "alice", chat.id, "Third", "m", [], "{}", async input => { input.onDelta("ok"); }, new AbortController().signal, undefined, undefined, { memory }).text();
    assert.equal(store.messages("alice", chat.id).at(-1)?.content, "ok");
  } finally { db.close(); }
});

test("the memory guard counts replies that are still starting, and frees their share when they end", async () => {
  const memory = { available: () => MEMORY_RESERVE_MB + REPLY_MEMORY_MB * 2 + 1, pollMs: 10 };
  const signal = new AbortController().signal;
  const first = await waitForMemory(signal, () => assert.fail("first waits"), memory);
  const second = await waitForMemory(signal, () => assert.fail("second waits"), memory);
  let waited = false;
  const third = waitForMemory(signal, () => { waited = true; }, memory);
  await sleep(40);
  assert.equal(waited, true, "A third would leave too little memory while two are starting");
  first.release();
  assert.equal((await third).waited, true);
  second.release();
});

test("a code-runner run waits for a free sandbox slot instead of failing, and Stop cancels the wait", async () => {
  const one = reserveSandbox("p1", "alice", "alice");
  const two = reserveSandbox("p2", "bob", "bob");
  let waiting = 0;
  const third = acquireSandbox("p3", "admin", "admin", new AbortController().signal, () => { waiting++; }, 10);
  await sleep(40);
  assert.equal(waiting, 1);
  one();
  const release = await third;
  const stop = new AbortController();
  const fourth = acquireSandbox("p4", "alice", "alice", stop.signal, () => {}, 10);
  await sleep(30);
  stop.abort();
  await assert.rejects(fourth, /cancelled/);
  two(); release();
});

test("Copilot refusing parallel requests shows a plain message on that reply", () => {
  assert.match(copilotError(new Error("Request failed with status 429: Too Many Requests")).message, /^Copilot is limiting how many requests run at once right now, so this reply stopped\. Send it again in a moment; other replies keep running\.$/);
  assert.match(copilotError(new Error("Monthly quota exceeded (402)")).message, /usage limit/);
});
