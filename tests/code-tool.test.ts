import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { PermissionRequest } from "@github/copilot-sdk";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { UploadStore } from "../lib/upload-store";
import { createCodeTool, detectOutput, previewMatches } from "../lib/code-tool";
import { safeFileName } from "../lib/safe-name";
import { createMessageAccumulator, safeSessionConfig, verifyToolMetadata } from "../lib/copilot";
import { reserveSandbox, type SandboxConfig, type SandboxResult, type runSandbox } from "../lib/sandbox";
import { systemInstruction } from "../lib/context";
import { createChatStream } from "../lib/stream";

const config: SandboxConfig = {
  distro: "ModelChatSandbox", ready: true, libraries: ["numpy", "matplotlib"], extraApt: [], extraPip: [],
  limits: { wallSeconds: 180, cpuSeconds: 300, memoryBytes: 2 ** 31, pids: 256, cpus: 2, workBytes: 2 ** 30, inputBytes: 2 ** 28, inputFiles: 32, codeBytes: 200_000, outputFiles: 20, outputBytes: 2 ** 28, fileBytes: 2 ** 27, logBytes: 16384 },
};
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT,expiresAt TEXT);
    INSERT INTO user VALUES ('alice','Alice','alice@example.test','user'),('bob','Bob','bob@example.test','user'),('admin','Admin','admin@example.test','superuser');`);
  for (const id of ["alice", "bob", "admin"]) db.prepare("INSERT INTO session VALUES (?,?,?)").run(`${id}-session`, id, new Date(Date.now() + 3600_000).toISOString());
  const store = new Store(db);
  const access = new AccessService(store);
  return { db, store, access };
}
function result(files: { name: string; bytes: Buffer }[], extra: Partial<SandboxResult> = {}): SandboxResult {
  return { status: "ok", exitCode: 0, durationMs: 1200, stdout: "done", stderr: "", processLimitReached: false, rejected: [], files, ...extra };
}
const invoke = (tool: ReturnType<typeof createCodeTool>, args: unknown) => tool.handler!(args, { sessionId: "s", toolCallId: "t", toolName: "run_python", arguments: args });

test("the SDK session exposes only the app's run_python tool and denies every other permission", async () => {
  const { db, store, access } = fixture();
  try {
    const chat = store.createChat("alice");
    const turn = store.beginTurn("alice", chat.id, "Make a chart", "m", []);
    const tool = createCodeTool({ store, access: access.resolve("alice", "alice-session"), chatId: chat.id, assistantMessageId: turn.assistant.id, signal: new AbortController().signal, authorize: () => {}, config });
    const session = safeSessionConfig("model", "C:\\fixture", "id", [tool], "TOOL TEXT");
    assert.deepEqual(session.availableTools, ["custom:run_python"]);
    assert.deepEqual(session.excludedTools, ["builtin:*", "mcp:*"]);
    assert.deepEqual(session.mcpServers, {}); assert.deepEqual(session.customAgents, []); assert.deepEqual(session.skillDirectories, []);
    assert.equal(session.enableConfigDiscovery, false); assert.equal(session.enableSkills, false);
    assert.match((session.systemMessage as { content: string }).content, /TOOL TEXT/);
    assert.doesNotMatch((session.systemMessage as { content: string }).content, /You have no tools/);
    const decide = (request: PermissionRequest) => session.onPermissionRequest!(request, { sessionId: "id" });
    assert.equal((await decide({ kind: "custom-tool", toolName: "run_python", toolDescription: "x" } as PermissionRequest)).kind, "approved");
    for (const request of [
      { kind: "custom-tool", toolName: "other_tool", toolDescription: "x" },
      { kind: "shell", fullCommandText: "whoami", intention: "x", commands: [], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false },
      { kind: "write", fileName: "C:\\x", intention: "x", diff: "" }, { kind: "read", path: "C:\\x", intention: "x" },
      { kind: "url", url: "https://example.com", intention: "x" }, { kind: "mcp", serverName: "x", toolName: "x", toolTitle: "x", readOnly: true },
    ]) assert.equal((await decide(request as unknown as PermissionRequest)).kind, "reject", JSON.stringify(request));
    const plain = safeSessionConfig("model", "C:\\fixture", "id");
    assert.deepEqual(plain.availableTools, []); assert.deepEqual(plain.excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
    assert.match((plain.systemMessage as { content: string }).content, /You have no tools/);
    assert.equal(systemInstruction(), (plain.systemMessage as { content: string }).content);
    assert.doesNotThrow(() => verifyToolMetadata([{ name: "run_python" }], ["run_python"]));
    assert.doesNotThrow(() => verifyToolMetadata([], []));
    for (const metadata of [[], [{ name: "run_python" }, { name: "bash" }], [{ name: "run_python", mcpServerName: "x" }], [{ name: "run_python", deferLoading: true }], null]) {
      assert.throws(() => verifyToolMetadata(metadata, ["run_python"]), /blocked/);
    }
    assert.throws(() => verifyToolMetadata([{ name: "view" }], []), /tool-free/);
  } finally { db.close(); }
});

test("multi-message tool turns keep earlier assistant text in the saved reply", () => {
  const events: string[] = [];
  let text = "";
  const add = createMessageAccumulator(delta => { text += delta; events.push("delta"); }, full => { text = full; events.push("replace"); });
  add("a", "I'll make ", false); add("a", "the chart.", false); add("a", "I'll make the chart.", true);
  add("b", "Done: chart.png", false); add("b", "Done: chart.png is attached.", true);
  assert.equal(text, "I'll make the chart.\n\nDone: chart.png is attached.");
  assert.ok(!events.includes("replace"));
  add("b", "Corrected final text.", true);
  assert.equal(text, "I'll make the chart.\n\nCorrected final text.");
});

test("runs use only this chat's selected files and save validated outputs to the owner's reply", async () => {
  const { db, store, access } = fixture();
  try {
    const chat = store.createChat("alice");
    const data = store.addFile("alice", chat.id, "data.csv", Buffer.from("a,b\n1,2"), "a,b\n1,2", "");
    const unused = store.addFile("alice", chat.id, "unused.txt", Buffer.from("NOT NEEDED"), "NOT NEEDED", "");
    const bobChat = store.createChat("bob");
    const bobFile = store.addFile("bob", bobChat.id, "bob.csv", Buffer.from("BOB SECRET"), "BOB SECRET", "");
    const turn = store.beginTurn("alice", chat.id, "Chart this", "m", [data.id, unused.id]);
    const audits: unknown[][] = [];
    const calls: { code: string; inputs: string[] }[] = [];
    const run: typeof runSandbox = async (code, inputs) => {
      calls.push({ code, inputs: inputs.map(input => `${input.name}:${Buffer.concat([...input.chunks()]).toString()}`) });
      return result([
        { name: "chart.png", bytes: PNG }, { name: "report/summary.txt", bytes: Buffer.from("Total 3") },
        { name: "page.html", bytes: Buffer.from("<script>alert(1)</script>") }, { name: "tool.exe", bytes: Buffer.from("MZ...") },
        { name: "renamed.png", bytes: Buffer.from("MZ disguised executable") }, { name: "fake.png", bytes: Buffer.from("<svg onload=alert(1)>") },
      ], { rejected: [{ name: "link", reason: "symbolic_link" }] });
    };
    const attachmentsEvents: number[] = [];
    const tool = createCodeTool({ store, access: access.resolve("alice", "alice-session"), chatId: chat.id, assistantMessageId: turn.assistant.id,
      signal: new AbortController().signal, authorize: () => {}, config, run, audit: (...entry) => audits.push(entry), onAttachments: () => attachmentsEvents.push(1) });
    const missing = await invoke(tool, { code: "print(1)", input_files: [bobFile.id] }) as { resultType: string; textResultForLlm: string };
    assert.equal(missing.resultType, "failure");
    assert.doesNotMatch(missing.textResultForLlm, /BOB SECRET|bob\.csv/);
    const output = JSON.parse(await invoke(tool, { code: "SECRET_PROGRAM_TEXT", input_files: ["data.csv"] }) as string);
    assert.deepEqual(calls.at(-1)!.inputs, ["data.csv:a,b\n1,2"], "Only the requested owned file is copied in");
    assert.deepEqual(output.generatedFiles.map((file: { name: string; type: string; preview: string | null }) => [file.name.replace(/-[0-9a-f]{6}\./, "-HASH."), file.type, file.preview]), [
      ["chart.png", "image/png", "image"], ["report-summary-HASH.txt", "text/plain", null], ["page.html", "text/html", null], ["fake.png", "application/octet-stream", null],
    ]);
    assert.deepEqual(output.inputFiles, [{ file: "data.csv", id: data.id, path: "/work/input/data.csv" }]);
    assert.deepEqual(output.rejectedOutputs.map((item: { reason: string }) => item.reason).sort(), ["executable_content", "executable_or_script_extension", "symbolic_link"]);
    const saved = store.attachments("alice", chat.id).filter(file => file.messageId === turn.assistant.id);
    assert.equal(saved.length, 4);
    assert.deepEqual(saved.map(file => file.preview), ["image", null, null, null]);
    assert.equal(store.fileText("alice", chat.id, saved[1].id).text, "Total 3");
    assert.throws(() => store.attachments("bob", chat.id), /not found/);
    const uploads = new UploadStore(store);
    assert.deepEqual(Buffer.concat([...uploads.rawChunks(saved[0].id)]), PNG);
    assert.deepEqual(Buffer.concat([...uploads.rangeChunks(saved[0].id, 2, 5)]), PNG.subarray(2, 6));
    assert.equal(previewMatches("image/png", PNG), true);
    assert.equal(previewMatches("image/png", Buffer.from("<svg>")), false);
    assert.deepEqual(detectOutput("x.svg", Buffer.from("<svg/>")), { extension: "svg", mimeType: "image/svg+xml" });
    assert.equal(attachmentsEvents.length, 1);
    const serialized = JSON.stringify(audits) + JSON.stringify(db.prepare("SELECT * FROM app_audit").all());
    assert.equal(/SECRET_PROGRAM_TEXT|Total 3|a,b/.test(serialized), false, "Audit entries never contain code or file contents");
    assert.ok(audits.some(entry => entry[0] === "code.run" && entry[3] === "started"));
    assert.ok(audits.some(entry => entry[0] === "code.run" && entry[3] === "ok"));
    assert.equal(audits.filter(entry => entry[0] === "code.output").length, 4);
    for (let index = 0; index < 6; index++) await invoke(tool, { code: "print(1)" });
    assert.equal(store.attachments("alice", chat.id).filter(file => file.messageId === turn.assistant.id).length, 4, "Retried runs replace same-name outputs instead of duplicating them");
    assert.ok(audits.some(entry => entry[0] === "code.output" && entry[3] === "replaced_by_later_run"));
    const limited = await invoke(tool, { code: "print(1)" }) as { resultType: string; textResultForLlm: string };
    assert.equal(limited.resultType, "failure"); assert.match(limited.textResultForLlm, /limit of 8/);
  } finally { db.close(); }
});

test("revoked access or cancellation discards outputs, and the superuser actor stays separate from the owner", async () => {
  const { db, store, access } = fixture();
  try {
    const chat = store.createChat("alice");
    const turn = store.beginTurn("alice", chat.id, "Make it", "m", []);
    const acting = access.start(access.resolve("admin", "admin-session"), "alice");
    const audits: unknown[][] = [];
    let allowed = true;
    const authorize = () => { if (!allowed) throw new Error("access ended"); access.check(acting); };
    const tool = createCodeTool({ store, access: acting, chatId: chat.id, assistantMessageId: turn.assistant.id, signal: new AbortController().signal, authorize, config,
      audit: (...entry) => audits.push(entry), run: async () => { allowed = false; return result([{ name: "chart.png", bytes: PNG }]); } });
    await assert.rejects(() => Promise.resolve(invoke(tool, { code: "x" })), /access ended/);
    assert.equal(store.attachments("alice", chat.id).length, 0);
    assert.ok(audits.some(entry => entry[0] === "code.run" && entry[2] === "denied"));
    const recorded: { actorId: string; subjectId: string }[] = [];
    const save = createCodeTool({ store, access: acting, chatId: chat.id, assistantMessageId: turn.assistant.id, signal: new AbortController().signal,
      authorize: () => access.check(acting), config, run: async () => result([{ name: "chart.png", bytes: PNG }]),
      audit: (action, objectId, outcome, reason) => access.record(acting, action, objectId, outcome, reason, true) });
    await invoke(save, { code: "x" });
    const file = store.attachments("alice", chat.id)[0];
    assert.equal(file.messageId, turn.assistant.id);
    recorded.push(...db.prepare("SELECT actorId,subjectId FROM app_audit WHERE action IN ('code.run','code.output')").all() as typeof recorded);
    assert.ok(recorded.length >= 3 && recorded.every(row => row.actorId === "admin" && row.subjectId === "alice"));
    const job = db.prepare("SELECT actorId,subjectId,status FROM app_file_job WHERE fileId=?").get(file.id);
    assert.deepEqual(job, { actorId: "admin", subjectId: "alice", status: "ready" });
    const controller = new AbortController();
    const cancelled = createCodeTool({ store, access: access.resolve("alice", "alice-session"), chatId: chat.id, assistantMessageId: turn.assistant.id, signal: controller.signal,
      authorize: () => {}, config, run: async () => { controller.abort(); throw new DOMException("cancelled", "AbortError"); } });
    await assert.rejects(() => Promise.resolve(invoke(cancelled, { code: "x" })));
    assert.equal(store.attachments("alice", chat.id).length, 1);
    store.saveReply("alice", chat.id, turn.assistant.id, "done", "complete");
    const late = createCodeTool({ store, access: access.resolve("alice", "alice-session"), chatId: chat.id, assistantMessageId: turn.assistant.id,
      signal: new AbortController().signal, authorize: () => {}, config, run: async () => result([{ name: "late.png", bytes: PNG }]) });
    await assert.rejects(() => Promise.resolve(invoke(late, { code: "x" })), /no longer active/);
  } finally { db.close(); }
});

test("safe names keep Unicode, never collapse different names, and close trailing-dot or space extension bypasses", async () => {
  assert.equal(safeFileName("销售图.png").name, "销售图.png");
  assert.equal(safeFileName("Résumé 2024.pdf").name, "Résumé 2024.pdf");
  assert.equal(safeFileName("отчёт.docx").name, "отчёт.docx");
  const first = safeFileName("P&L?.xlsx").name, second = safeFileName("P&L*.xlsx").name;
  assert.match(first, /^P_L-[0-9a-f]{6}\.xlsx$/); assert.notEqual(first, second);
  assert.match(safeFileName("???.png").name, /^output-[0-9a-f]{6}\.png$/);
  assert.notEqual(safeFileName("???.png").name, safeFileName("!!!.png").name);
  assert.match(safeFileName(`${"a".repeat(30)} ${"b".repeat(115)}.pdf`).name, /^a{30} b{69}-[0-9a-f]{6}\.pdf$/);
  for (const name of ["invoice.hta.", "run.bat ", "script.js. . ", "tool.EXE", "a.txt:evil.exe"]) assert.deepEqual(detectOutput(name, Buffer.from("echo hi")), { blocked: "executable_or_script_extension" }, name);
  const { db, store, access } = fixture();
  try {
    const chat = store.createChat("alice");
    const turn = store.beginTurn("alice", chat.id, "Make files", "m", []);
    const tool = createCodeTool({ store, access: access.resolve("alice", "alice-session"), chatId: chat.id, assistantMessageId: turn.assistant.id, signal: new AbortController().signal, authorize: () => {}, config,
      run: async () => result([{ name: "销售图.png", bytes: PNG }, { name: "利润图.png", bytes: PNG }, { name: "a?b.png", bytes: PNG }, { name: "a*b.png", bytes: PNG }], { status: "rejected", error: "Unsupported input file name: x" }) });
    const output = JSON.parse(await invoke(tool, { code: "x" }) as string);
    assert.equal(output.error, "Unsupported input file name: x");
    assert.equal(new Set(output.generatedFiles.map((file: { name: string }) => file.name)).size, 4);
    assert.equal(store.attachments("alice", chat.id).length, 4);
  } finally { db.close(); }
});

test("generated outputs are listed compactly and never exhaust the user's document budget", () => {
  const { db, store, access } = fixture();
  try {
    const chat = store.createChat("alice");
    const document = store.addFile("alice", chat.id, "notes.txt", Buffer.from("Important note"), "Important note. ".repeat(200), "");
    const turn = store.beginTurn("alice", chat.id, "Make many files", "m", [document.id]);
    const uploads = new UploadStore(store);
    const own = access.resolve("alice", "alice-session");
    for (let index = 0; index < 300; index++) uploads.storeGenerated(own, chat.id, turn.assistant.id, { name: `chart-${index}.png`, extension: "png", bytes: PNG, mimeType: "image/png", text: "[Generated]", notes: "Generated" });
    const files = store.contextFiles("alice", chat.id, []);
    assert.equal(files.length, 41);
    assert.match(files[0].text, /Important note/);
    assert.ok(files.slice(1).every(file => /Generated by run_python/.test(file.text)));
    assert.equal(store.imageSources("alice", chat.id, []).length, 0, "Generated images do not crowd the vision context");
  } finally { db.close(); }
});

test("sandbox concurrency is limited per account, per actor and app-wide", () => {
  const first = reserveSandbox("r1", "alice", "alice");
  assert.throws(() => reserveSandbox("r2", "alice", "alice"), /busy/);
  assert.throws(() => reserveSandbox("r3", "bob", "alice"), /busy/);
  const second = reserveSandbox("r4", "bob", "bob");
  assert.throws(() => reserveSandbox("r5", "carol", "carol"), /busy/);
  first(); second();
  reserveSandbox("r6", "carol", "carol")();
});

test("a streamed tool turn saves generated files under the assistant reply and notifies the browser", async () => {
  const { db, store, access } = fixture();
  try {
    const chat = store.createChat("alice");
    const own = access.resolve("alice", "alice-session");
    const response = createChatStream(store, "alice", chat.id, "Make a chart", "m", [], "{}", async input => {
      const tool = createCodeTool({ store, access: own, chatId: chat.id, assistantMessageId: input.assistantMessageId!, signal: input.signal,
        authorize: () => {}, config, onAttachments: input.onAttachments, onProgress: input.onProgress, run: async () => result([{ name: "chart.png", bytes: PNG }]) });
      input.onDelta("Creating it.");
      await invoke(tool, { code: "x" });
      input.onDelta(" Done.");
    }, new AbortController().signal);
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === "attachments"));
    assert.ok(events.some(event => event.type === "progress" && /offline sandbox/.test(event.stage)));
    const last = store.messages("alice", chat.id).at(-1)!;
    assert.equal(last.status, "complete");
    assert.equal(store.attachments("alice", chat.id)[0].messageId, last.id);
  } finally { db.close(); }
});
