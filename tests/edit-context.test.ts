import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { ModelInfo } from "@github/copilot-sdk";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { prepareImageTurn } from "../lib/image-turn";
import { createChatStream } from "../lib/stream";
import { buildPrompt, estimateTokens, modelPromptLimit, promptTokenBudget } from "../lib/context";
import { chooseSummaryModel, condenseHistory, pickExcerpts, planHistory, type SavedSummary } from "../lib/condense";
import type { Message } from "../lib/contracts";
import type { ReplyInput, ReplyRunner } from "../lib/copilot";

function fixture(db = new Database(":memory:")) {
  db.exec(`CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT);
    CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY,userId TEXT,expiresAt TEXT);
    INSERT OR IGNORE INTO user VALUES ('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user'),('admin','Admin','admin@example.test','superuser');`);
  for (const id of ["alice", "bob", "admin"]) db.prepare("INSERT OR REPLACE INTO session VALUES (?,?,?)").run(id + "-session", id, new Date(Date.now() + 3600000).toISOString());
  const store = new Store(db);
  return { db, store, access: new AccessService(store) };
}
// Catalogue entries shaped like the live ones (default pricing tier plus the larger long-context tier).
const priced = (id: string, prompt: number, tier: number | undefined, input: number, output: number, levels?: string[]): ModelInfo => ({
  id, name: id, capabilities: { supports: { vision: false, reasoningEffort: Boolean(levels) }, limits: { max_prompt_tokens: prompt, max_context_window_tokens: prompt + 128000, max_output_tokens: 128000 } },
  supportedReasoningEfforts: levels, billing: { tokenPrices: { inputPrice: input, outputPrice: output, ...(tier ? { maxPromptTokens: tier, contextMax: tier } : {}) } },
} as ModelInfo);
const astra = priced("gpt-6-astra", 1_050_000, 272_000, 1000, 5000, ["low", "medium", "high", "xhigh", "max"]);
const opus = priced("claude-opus-5.5", 1_000_000, 200_000, 400, 2000, ["low", "medium", "high", "xhigh", "max"]);
const haiku = priced("claude-haiku-5.5", 936_000, 100_000, 10, 50, ["low", "medium", "high", "xhigh", "max"]);
const luna = priced("gpt-6-luna", 872_000, 272_000, 10, 50, ["none", "low", "medium", "high", "xhigh", "max"]);
const flash = priced("mai-code-2-flash", 922_000, undefined, 10, 50, ["low", "medium", "high"]);
const small = priced("small-model", 40_000, undefined, 5, 5);
const words = (count: number, seed: string) => Array.from({ length: count }, (_, index) => `${seed}${index % 97}`).join(" ");

test("budgets use each model's real default-tier window with a fixed reserve, not the old 100 KB cap", () => {
  assert.equal(modelPromptLimit(astra), 272_000, "GPT-6 Astra: the 272k default tier, not the pricier 1.05M long-context tier");
  assert.equal(modelPromptLimit(opus), 200_000);
  assert.equal(modelPromptLimit(haiku), 100_000);
  assert.equal(modelPromptLimit(flash), 922_000, "No pricing tier: the advertised prompt limit");
  assert.equal(modelPromptLimit({ capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 64_000, max_output_tokens: 16_000 } } } as ModelInfo), 48_000, "Window minus output room");
  assert.equal(promptTokenBudget(272_000), 219_200);
  assert.equal(promptTokenBudget(100_000), 73_000);
  assert.equal(estimateTokens("abc".repeat(1000)), 1000, "3 bytes a token");
  assert.equal(estimateTokens("€"), 1);
  // The screenshot's case: a long paper chat of ~300 KB fits GPT-6 Astra now (it failed above 100 KB before).
  const history: Message[] = Array.from({ length: 12 }, (_, index) => ({ id: `m${index}`, chatId: "c", role: index % 2 ? "assistant" : "user", content: "Paper text. ".repeat(2500), model: "m", status: "complete", error: null, createdAt: index, reasoning: "" }));
  assert.doesNotThrow(() => buildPrompt(history, [], "Improve section 3.", modelPromptLimit(astra)));
  assert.throws(() => buildPrompt(history, [], "Improve section 3.", modelPromptLimit(small)), /doesn't fit the model's context window/);
});

test("the cheapest model by token price summarises, preferring one that can skip thinking", () => {
  assert.equal(chooseSummaryModel([astra, opus, haiku, luna, flash], astra).id, "gpt-6-luna", "Tied on price with Haiku 5.5 and MAI Code 2 Flash, but it can run with no thinking");
  assert.equal(chooseSummaryModel([astra, opus], astra).id, "claude-opus-5.5");
  assert.equal(chooseSummaryModel([astra, luna], astra, "gpt-6-astra").id, "gpt-6-astra", "MODEL_CHAT_SUMMARY_MODEL wins");
  const unpriced = { ...astra, billing: undefined } as ModelInfo;
  assert.equal(chooseSummaryModel([unpriced], unpriced).id, "gpt-6-astra", "Without prices, the reply's own model");
});

const message = (index: number, content: string): Message => ({ id: `m${index}`, chatId: "c", role: index % 2 ? "assistant" : "user", content, model: "m", status: "complete", error: null, createdAt: index, reasoning: "" });
test("history plans: verbatim when it fits; otherwise recent turns verbatim, a summary, then reuse until the recent part outgrows it", () => {
  const history = Array.from({ length: 20 }, (_, index) => message(index, words(300, index % 2 ? "answer" : "question")));
  assert.deepEqual(planHistory(history, 1_000_000, new Map(), "q").conversation, history);
  const budget = 6000;
  const first = planHistory(history, budget, new Map(), "question7 detail");
  assert.ok(first.needs && first.needs.from === 0 && first.needs.previous === undefined);
  assert.equal(first.conversation[0].role, "user", "Recent turns start at a question");
  assert.equal(first.needs.through + 1 + first.conversation.length, history.length);
  // Once saved, the summary is reused (no new request) while the recent turns fit next to it…
  const saved: SavedSummary = { throughMessageId: history[first.needs.through].id, covers: first.needs.through + 1, content: "Summary of the early discussion.", model: "gpt-6-luna", createdAt: 1 };
  const summaries = new Map([[saved.throughMessageId, saved]]);
  const reused = planHistory(history, budget, summaries, "question7 detail");
  assert.equal(reused.needs, undefined);
  assert.equal(reused.earlier?.coveredMessages, first.needs.through + 1);
  assert.equal(reused.earlier?.summary, "Summary of the early discussion.");
  const longer = [...history, message(20, words(300, "question")), message(21, words(300, "answer"))];
  assert.equal(planHistory(longer, budget, summaries, "x").needs, undefined, "A turn later it still fits");
  // …and extended from where it stopped once they don't.
  const muchLonger = [...longer, ...Array.from({ length: 10 }, (_, index) => message(22 + index, words(300, index % 2 ? "answer" : "question")))];
  const next = planHistory(muchLonger, budget, summaries, "x");
  assert.equal(next.needs?.from, first.needs.through + 1);
  assert.equal(next.needs?.previous?.content, "Summary of the early discussion.");
  // Too little room for anything older: only the message and files go.
  assert.deepEqual(planHistory(history, 500, new Map(), "x"), { conversation: [], dropped: 20 });
});

test("older passages that match the new message come back as verbatim excerpts, rarest words first, in order", () => {
  const older = [
    message(0, "We chose the Kestrel dataset for the survival analysis.\n\nUnrelated planning notes about fonts."),
    message(1, "Agreed. Kestrel gives 4,812 patients and a median follow-up of 31 months."),
    message(2, "Something else entirely about formatting the bibliography."),
  ];
  const excerpts = pickExcerpts(older, "What follow-up did the Kestrel cohort have?", 2000);
  assert.deepEqual(excerpts.map(item => item.message), [1, 2]);
  assert.match(excerpts[1].text, /31 months/);
  assert.ok(!excerpts.some(item => /bibliography/.test(item.text)), "Passages without the words aren't sent");
  assert.deepEqual(pickExcerpts(older, "the and of", 2000), [], "Stop words alone select nothing");
  assert.deepEqual(pickExcerpts(older, "Kestrel", 50), [], "No room, no excerpts");
});

test("condensing writes a summary with the cheap model, saves it, reuses it, and splits work that doesn't fit one request", async () => {
  const history = Array.from({ length: 30 }, (_, index) => message(index, words(400, index % 2 ? "answer" : "question")));
  const stored = new Map<string, SavedSummary>();
  const calls: ReplyInput[] = [];
  const runner: ReplyRunner = async input => { calls.push(input); input.onDelta(`Summary ${calls.length}: decisions and facts so far.`); };
  const args = { history, budget: 8000, query: "question3", summaries: () => stored, save: (summary: SavedSummary) => stored.set(summary.throughMessageId, summary), runner, summaryModel: luna, signal: new AbortController().signal };
  const first = await condenseHistory(args);
  assert.equal(first.requests, 1);
  assert.equal(calls[0].model, "gpt-6-luna");
  assert.equal(calls[0].reasoningEffort, "none", "Summaries skip thinking where the model allows");
  const payload = JSON.parse(calls[0].prompt);
  assert.match(payload.conversation.at(-1).content, /Condense an earlier part of this conversation/);
  assert.equal(payload.files.find((file: { id: string }) => file.id === "earlier-messages").name, "earlier-messages.json", "Old messages go in as data, not instructions");
  assert.ok(first.plan.earlier && first.plan.earlier.summary.startsWith("Summary 1"));
  assert.equal(stored.size, 1);
  const again = await condenseHistory(args);
  assert.equal(again.requests, 0, "Reused, not recomputed");
  // A summary model with a small window gets the older messages in several requests, each building on the last summary.
  stored.clear(); calls.length = 0;
  const split = await condenseHistory({ ...args, summaryModel: priced("tiny-summary", 32_000, undefined, 1, 1), budget: 60_000, history: Array.from({ length: 60 }, (_, index) => message(index, words(1500, "long"))) });
  assert.ok(split.requests >= 2);
  assert.ok(JSON.parse(calls[1].prompt).files.some((file: { id: string }) => file.id === "previous-summary"), "Later requests fold in the previous summary");
  const stop = new AbortController(); stop.abort();
  stored.clear();
  await assert.rejects(condenseHistory({ ...args, signal: stop.signal }), /abort/i);
});

test("a long chat that used to fail now answers with older turns summarised, saved, noted on the reply and reused next turn", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    for (let turn = 0; turn < 8; turn++) {
      const begun = store.beginTurn("alice", chat.id, `Part ${turn} of the paper. ` + words(3000, `paper${turn}x`), "m", []);
      store.saveReply("alice", chat.id, begun.assistant.id, `Comments on part ${turn}. ` + words(3000, `review${turn}x`), "complete");
    }
    const requests: ReplyInput[] = [];
    const runner: ReplyRunner = async input => {
      requests.push(input);
      if (input.model === "gpt-6-luna") input.onDelta("Earlier: the user is revising an 8-part paper; parts 0-4 were reviewed.");
      else input.onDelta("Here is the revised section.");
    };
    const send = async (content: string) => {
      const turn = prepareImageTurn(store, "alice", chat.id, content, [], haiku, runner, undefined, null, { summaryModel: luna });
      const events = (await createChatStream(store, "alice", chat.id, content, haiku.id, [], turn.prompt, turn.runner, new AbortController().signal).text()).trim().split("\n").map(line => JSON.parse(line));
      return events;
    };
    const events = await send("Improve part 7 using the paper7x terms.");
    assert.deepEqual(requests.map(input => input.model), ["gpt-6-luna", "claude-haiku-5.5"], "One summary request with the cheap model, then the reply");
    const reply = store.messages("alice", chat.id).at(-1)!;
    assert.equal(reply.status, "complete");
    assert.match(reply.contextNote!, /^Earlier messages were summarised to fit \(\d+ of 16 messages\)$/);
    assert.ok(events.some(event => event.type === "context" && event.note === reply.contextNote), "Streamed as it happens");
    const final = JSON.parse(requests[1].prompt);
    assert.match(final.earlierConversation.summary, /8-part paper/);
    assert.ok(estimateTokens(requests[1].prompt) <= promptTokenBudget(100_000));
    assert.equal(final.conversation.at(-1).content, "Improve part 7 using the paper7x terms.");
    assert.ok(final.conversation.length >= 3 && final.conversation[0].role === "user", "The latest turns stay verbatim, starting at a question");
    assert.ok(Buffer.byteLength(JSON.stringify(store.messages("alice", chat.id).slice(0, 16))) > 300_000, "This history was over three times the old 100 KB cap");
    assert.equal(store.messages("alice", chat.id).length, 18, "The full history stays saved and shown");
    requests.length = 0;
    await send("And part 6?");
    assert.deepEqual(requests.map(input => input.model), ["claude-haiku-5.5"], "The saved summary is reused: no new summary request");
    // A message that can't fit on its own fails before anything is saved, saying what to do.
    const before = store.messages("alice", chat.id).length;
    assert.throws(() => prepareImageTurn(store, "alice", chat.id, "x".repeat(400_000), [], haiku, runner), /too long for claude-haiku-5\.5: it has 400,000 characters, and about [\d,]+ fit.*Shorten it or send it in parts/);
    assert.equal(store.messages("alice", chat.id).length, before);
  } finally { db.close(); }
});

test("editing a message branches the chat: versions, switching, branch-correct context and attachments, all saved", async () => {
  const { db, store } = fixture();
  try {
    const chat = store.createChat("alice");
    const kept = store.addFile("alice", chat.id, "kept.txt", Buffer.from("k"), "KEPT_FILE_TEXT", "");
    const dropped = store.addFile("alice", chat.id, "dropped.txt", Buffer.from("d"), "DROPPED_FILE_TEXT", "");
    const one = store.beginTurn("alice", chat.id, "First question", "m", []);
    store.saveReply("alice", chat.id, one.assistant.id, "First answer", "complete");
    const two = store.beginTurn("alice", chat.id, "Original second question", "m", [kept.id, dropped.id]);
    store.saveReply("alice", chat.id, two.assistant.id, "ORIGINAL_ANSWER", "complete");
    const three = store.beginTurn("alice", chat.id, "Follow-up on the original", "m", []);
    store.saveReply("alice", chat.id, three.assistant.id, "ORIGINAL_FOLLOW_UP", "complete");
    const prompts: string[] = [];
    const runner: ReplyRunner = async input => { prompts.push(input.prompt); input.onDelta("Answer to the edit."); };
    const edit = { editOf: two.user.id, keepFileIds: [kept.id] };
    const turn = prepareImageTurn(store, "alice", chat.id, "Edited second question", [], haiku, runner, undefined, null, edit);
    await createChatStream(store, "alice", chat.id, "Edited second question", haiku.id, [], turn.prompt, turn.runner, new AbortController().signal, undefined, undefined, { edit }).text();
    const shown = store.messages("alice", chat.id);
    assert.deepEqual(shown.map(item => item.content), ["First question", "First answer", "Edited second question", "Answer to the edit."], "Later turns of the old version aren't on the new branch");
    assert.deepEqual(shown[2].siblings, [two.user.id, shown[2].id]);
    assert.equal(shown[0].siblings, undefined);
    // The model saw the conversation up to the edited message, and only the kept attachment.
    const sent = JSON.parse(prompts[0]);
    assert.deepEqual(sent.conversation.map((item: { content: string }) => item.content), ["First question", "First answer", "Edited second question"]);
    assert.deepEqual(sent.files.map((file: { name: string }) => file.name), ["kept.txt"]);
    assert.doesNotMatch(prompts[0], /ORIGINAL_ANSWER|ORIGINAL_FOLLOW_UP|DROPPED_FILE_TEXT/);
    assert.deepEqual(store.attachments("alice", chat.id).find(file => file.id === kept.id)?.linkedMessageIds, [shown[2].id]);
    // A turn on the new branch builds on it, not on the old one.
    assert.doesNotMatch(prepareImageTurn(store, "alice", chat.id, "Next", [], haiku, runner).prompt, /ORIGINAL_|DROPPED_FILE_TEXT/);
    // Switching back restores the old version with its latest follow-up; nothing was lost.
    const old = store.switchBranch("alice", chat.id, two.user.id);
    assert.deepEqual(old.map(item => item.content), ["First question", "First answer", "Original second question", "ORIGINAL_ANSWER", "Follow-up on the original", "ORIGINAL_FOLLOW_UP"]);
    assert.match(prepareImageTurn(store, "alice", chat.id, "Next", [], haiku, runner).prompt, /ORIGINAL_FOLLOW_UP/);
    assert.equal(store.messages("alice", chat.id).length, 6, "The branch shown is remembered");
    store.switchBranch("alice", chat.id, shown[2].id);
    assert.equal(store.messages("alice", chat.id).at(-1)?.content, "Answer to the edit.");
    // Guards: only own attachments, only messages on the branch shown, only the owner, not mid-reply.
    assert.throws(() => store.beginTurn("alice", chat.id, "x", "m", [], null, { editOf: one.user.id, keepFileIds: [kept.id] }), /Only the edited message's own attachments/);
    assert.throws(() => store.beginTurn("alice", chat.id, "x", "m", [], null, { editOf: three.user.id }), /isn't in the conversation shown/);
    assert.throws(() => store.switchBranch("bob", chat.id, two.user.id), /Chat not found/);
    assert.throws(() => store.switchBranch("alice", chat.id, one.assistant.id), /Message not found/);
    const streaming = store.beginTurn("alice", chat.id, "Running", "m", []);
    assert.throws(() => store.switchBranch("alice", chat.id, two.user.id), /reply is in progress/);
    assert.throws(() => store.beginTurn("alice", chat.id, "x", "m", [], null, { editOf: shown[2].id }), /reply is in progress/);
    store.saveReply("alice", chat.id, streaming.assistant.id, "done", "complete");
    // Saved files of other branches stay protected, and deleting the chat removes every branch.
    assert.throws(() => store.deleteFile("alice", chat.id, dropped.id), /already sent/);
    store.deleteChat("alice", chat.id);
    assert.equal((db.prepare("SELECT count(*) n FROM app_file_link").get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test("existing chats migrate to a single branch in their saved order, with nothing else changed", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT); CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,expiresAt TEXT);
    INSERT INTO user VALUES ('alice','Alice','alice@example.test','user');
    CREATE TABLE app_chat (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, title TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', draft TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE app_message (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES app_chat(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL);
    INSERT INTO app_chat VALUES ('c1','alice','Old chat','m','',1,5);
    INSERT INTO app_message VALUES ('a','c1','user','Q1','m','complete',NULL,10),('b','c1','assistant','A1','m','complete',NULL,11),
      ('c','c1','user','Q2','m','complete',NULL,20),('d','c1','assistant','A2','m','error','Stopped',21),('e','c1','user','Q3 same time','m','complete',NULL,21);`);
  try {
    const store = new Store(db);
    const messages = store.messages("alice", "c1");
    assert.deepEqual(messages.map(item => [item.id, item.parentId ?? null]), [["a", null], ["b", "a"], ["c", "b"], ["d", "c"], ["e", "d"]]);
    assert.deepEqual(messages.map(item => item.content), ["Q1", "A1", "Q2", "A2", "Q3 same time"]);
    assert.equal(messages.some(item => item.siblings), false);
    assert.equal((db.prepare("SELECT leafId,updatedAt FROM app_chat WHERE id='c1'").get() as { leafId: string }).leafId, "e");
    assert.equal((db.prepare("SELECT updatedAt FROM app_chat WHERE id='c1'").get() as { updatedAt: number }).updatedAt, 5);
    new Store(db);
    assert.deepEqual(store.messages("alice", "c1").map(item => item.id), ["a", "b", "c", "d", "e"], "Running the migration again changes nothing");
  } finally { db.close(); }
});
