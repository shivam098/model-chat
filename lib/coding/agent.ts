import { CopilotClient, type CopilotSession, type PermissionRequest, type SessionConfig } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Store } from "../store";
import type { Chat, CodeEvent } from "../contracts";
import { closeClient, copilotError, copilotHomeDirectory, copilotSessionToken, createMessageAccumulator, deadline, type ReplyRunner } from "../copilot";
import { isolatedRuntimeEnvironment } from "../copilot-account";
import { AppError } from "../errors";
import { applyDecision, emptyAllowances, gate, type Allowances, type ApprovalCard, type Decision } from "./policy";

type Audit = (action: string, objectId: string | null, outcome: "allowed" | "denied" | "error", reason: string | null) => void;
type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;

const SHELL = process.platform === "win32" ? "powershell" : "bash";
// File tools differ by model family (e.g. GPT models edit with apply_patch and search with rg); all are equivalent file operations.
const FILE_WRITE_TOOLS = ["create", "edit", "apply_patch", "str_replace_editor"];
/** The only tools a coding session may have: the platform shell family, file view/edit/search, and web fetch. */
export const CODE_TOOLS = [SHELL, `read_${SHELL}`, `write_${SHELL}`, `stop_${SHELL}`, `list_${SHELL}`, "view", ...FILE_WRITE_TOOLS, "glob", "grep", "rg", "web_fetch"];
const QUIET_TOOLS = new Set([`read_${SHELL}`, `list_${SHELL}`, `write_${SHELL}`]);

interface Card { id: string; messageId: string; seq: number; kind: CodeEvent["kind"]; data: Record<string, unknown>; createdAt: number; flush?: ReturnType<typeof setTimeout> }
interface Turn { messageId: string; emit?: (event: CodeEvent) => void; audit: Audit; signal: AbortSignal; activity?: () => void; progress?: (stage: string) => void }
interface CodeSession {
  chatId: string; ownerId: string; project: string; model: string; store: Store;
  client: CopilotClient; session: CopilotSession; sessionId: string;
  allowances: Allowances; cards: Map<string, Card>; toolKeys: Map<string, Set<string>>; turn: Turn | null; lastActive: number; fresh: boolean;
}
interface Pending { chatId: string; ownerId: string; resolve: (decision: Decision) => void }
const registry = globalThis as typeof globalThis & {
  modelChatCodeSessions?: Map<string, CodeSession>;
  modelChatCodeStarting?: Map<string, Promise<CodeSession>>;
  modelChatCodePending?: Map<string, Pending>;
  modelChatCodeSweeper?: ReturnType<typeof setInterval>;
};
const sessions: Map<string, CodeSession> = registry.modelChatCodeSessions ||= new Map();
const starting: Map<string, Promise<CodeSession>> = registry.modelChatCodeStarting ||= new Map();
const pending: Map<string, Pending> = registry.modelChatCodePending ||= new Map();
registry.modelChatCodeSweeper ||= setInterval(() => {
  for (const session of sessions.values()) if (!session.turn && Date.now() - session.lastActive > 3 * 60 * 60_000) void disposeCodeSession(session.chatId);
}, 10 * 60_000);
registry.modelChatCodeSweeper.unref?.();

// Shells get the machine's normal environment for builds, minus the app's own settings and anything secret-looking.
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE|CREDENTIAL|COOKIE)/i;
const APP_NAME = /^(GH_|GITHUB_|COPILOT_|BETTER_AUTH|MODEL_CHAT_|NEXT_|__NEXT|npm_|NODE_OPTIONS$|NODE_ENV$|PORT$|INIT_CWD$|TURBOPACK)/i;
export function codingEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !SECRET_NAME.test(entry[0]) && !APP_NAME.test(entry[0])));
  return { ...environment, GH_CONFIG_DIR: isolatedRuntimeEnvironment(copilotHomeDirectory()).GH_CONFIG_DIR!, GIT_TERMINAL_PROMPT: "0" };
}

export function codingInstruction(project: string) {
  const mac = process.platform === "darwin";
  return [
    "You are Model Chat's coding mode, working for the owner of this computer.",
    `Project folder: ${project}. Work inside it; only go outside it when the owner asks, and say so first.`,
    "Every command, file change and web fetch needs the owner's approval in the app. If something is denied, don't retry it; explain and suggest an alternative.",
    "Never read, print or change Model Chat's own folder, .env files, credentials, tokens, keychains or SSH keys, and never print environment variables.",
    mac ? "This is a Mac: use zsh/bash and the installed tools (Homebrew, Xcode, xcodebuild, xcrun simctl, xcodegen). Never ask for Apple ID details or passwords; signing and keychain prompts appear on the Mac itself, for the owner."
      : "This is Windows: use PowerShell and the installed tools (node/npm, python, dotnet, git). Package installs use the machine's configured feeds; if a download is blocked, report it rather than working around it.",
    ...(mac ? ["iOS apps: a project with project.yml is an XcodeGen project (run xcodegen generate after changing it or adding files; never hand-edit .xcodeproj). If it has ios.sh, use ./ios.sh build, ./ios.sh run (installs and launches it in the iPhone Simulator and saves a screenshot) and ./ios.sh test. For a new iOS app without it, suggest the owner create a project from Model Chat's iOS template, or write an XcodeGen project.yml. Fix build errors and run the tests before saying it works."] : []),
    "To show the owner an image (for example a Simulator or app screenshot), save it as a PNG or JPEG in .modelchat/screenshots/ inside the project; Model Chat shows it with the command that created it.",
    "For web apps and other long-running commands (dev servers, watchers), run them with the shell tool in mode \"async\" without detach, bound to 127.0.0.1, and print the URL. They then appear in Model Chat's process list, where the owner can stop them, and end with the coding session. Don't use detach, Start-Process, Start-Job, nohup, disown, setsid or a trailing &: Model Chat refuses them because it couldn't stop the process.",
    "Keep replies short: what you changed, how to run it, and anything that needs the owner.",
  ].join("\n");
}

function codingSessionConfig(model: string, project: string, sessionId: string, effort: ReasoningEffort | undefined, onPermissionRequest: SessionConfig["onPermissionRequest"]): SessionConfig {
  return {
    sessionId, model, clientName: "Model Chat code",
    ...(effort ? { reasoningEffort: effort, reasoningSummary: "detailed" as const } : {}),
    availableTools: CODE_TOOLS.map(name => `builtin:${name}`),
    excludedTools: ["mcp:*", "custom:*"],
    tools: [], mcpServers: {}, customAgents: [], includedBuiltinSkills: [], skillDirectories: [], hooks: {},
    enableConfigDiscovery: false, skipCustomInstructions: true, enableOnDemandInstructionDiscovery: false, enableFileHooks: false,
    enableHostGitOperations: false, enableSessionStore: false, enableSkills: false, enableSessionTelemetry: false,
    skipEmbeddingRetrieval: true, embeddingCacheStorage: "in-memory", memory: { enabled: false }, infiniteSessions: { enabled: true },
    requestExtensions: false, requestCanvasRenderer: false, manageScheduleEnabled: false,
    workingDirectory: project, configDirectory: copilotHomeDirectory(), streaming: true,
    systemMessage: { mode: "append", content: codingInstruction(project) },
    onPermissionRequest,
  };
}
export function verifyCodingTools(tools: { name: string; mcpServerName?: string }[] | null | undefined) {
  const names = (tools || []).map(tool => tool.name);
  if (!tools || !names.includes(SHELL) || !names.some(name => FILE_WRITE_TOOLS.includes(name)) || names.some(name => !CODE_TOOLS.includes(name)) || tools.some(tool => tool.mcpServerName)) {
    throw new AppError(503, "The runtime did not confirm the coding tool set. Coding was blocked for safety.", { cause: new Error(`Runtime tools: ${names.join(", ") || "none"}`) });
  }
}

const relative = (session: CodeSession, value: unknown) => {
  if (typeof value !== "string" || !value) return "";
  const full = path.resolve(session.project, value);
  const inside = path.relative(session.project, full);
  return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? inside.replace(/\\/g, "/") : full;
};
// Write approvals arrive one file at a time, so each file of a multi-file patch gets its own card.
const fileKey = (toolCallId: string, file: string) => `${toolCallId}|${file.toLowerCase()}`;
function track(session: CodeSession, toolCallId: string, key: string) {
  const keys = session.toolKeys.get(toolCallId) || new Set<string>();
  keys.add(key);
  session.toolKeys.set(toolCallId, keys);
}
// Diff headers name files relative to the project rather than by full path.
function tidyDiff(session: CodeSession, diff: string) {
  const project = session.project.replace(/\\/g, "/").replace(/\/$/, "");
  const prefix = new RegExp(`(^|[ab]/)${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, process.platform === "win32" ? "gi" : "g");
  return diff.split(/\r?\n/).map(line => /^(diff --git|---|\+\+\+) /.test(line) ? line.replace(prefix, "$1") : line).join("\n").slice(0, 64_000);
}
const writeAction = (intention: unknown, diff: string) => /^--- (a\/)?\/?dev\/null/m.test(diff) || /creat/i.test(String(intention || "")) ? "Created" : /delet/i.test(String(intention || "")) ? "Deleted" : "Edited";
// Images a command saved in the project's .modelchat/screenshots folder (for example a Simulator screenshot) are shown on its card.
export const SCREENSHOT_NAME = /^[A-Za-z0-9._-]{1,120}\.(png|jpe?g|gif|webp)$/i;
const newScreenshots = (session: CodeSession, since: number) => screenshotsSince(session.project, since);
export function screenshotsSince(project: string, since: number) {
  const folder = path.join(project, ".modelchat", "screenshots");
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isFile() && SCREENSHOT_NAME.test(entry.name))
      .map(entry => ({ name: entry.name, at: statSync(path.join(folder, entry.name)).mtimeMs }))
      .filter(file => file.at >= since - 2000).sort((a, b) => b.at - a.at).slice(0, 4).map(file => file.name);
  } catch { return []; }
}
function snapshot(session: CodeSession, card: Card): CodeEvent {
  return { id: card.id, chatId: session.chatId, messageId: card.messageId, seq: card.seq, kind: card.kind, data: card.data, createdAt: card.createdAt, updatedAt: Date.now() };
}
function upsert(session: CodeSession, key: string, kind: CodeEvent["kind"], patch: Record<string, unknown>, lazy = false) {
  let card = session.cards.get(key);
  if (!card) {
    const messageId = session.turn?.messageId;
    if (!messageId) return;
    const event = session.store.addCodeEvent(session.ownerId, session.chatId, messageId, kind, patch);
    card = { id: event.id, messageId, seq: event.seq, kind, data: patch, createdAt: event.createdAt };
    session.cards.set(key, card);
    session.turn?.emit?.(event);
    return;
  }
  card.data = { ...card.data, ...patch };
  const write = () => {
    card!.flush = undefined;
    try { session.store.updateCodeEvent(session.ownerId, session.chatId, card!.id, card!.data); } catch { /* The chat was deleted. */ }
    if (session.turn?.messageId === card!.messageId) session.turn.emit?.(snapshot(session, card!));
  };
  if (!lazy) { clearTimeout(card.flush); write(); }
  else card.flush ||= setTimeout(write, 300);
}

function onToolStart(session: CodeSession, data: { toolCallId: string; toolName: string; arguments?: unknown }) {
  session.turn?.activity?.();
  const args = (data.arguments && typeof data.arguments === "object" ? data.arguments : {}) as Record<string, unknown>;
  const tool = data.toolName;
  if (QUIET_TOOLS.has(tool)) return;
  session.turn?.progress?.(tool === SHELL ? "Running a command" : FILE_WRITE_TOOLS.includes(tool) ? "Editing files" : tool === "web_fetch" ? "Fetching a page" : "Reading the project");
  if (tool === SHELL) {
    upsert(session, data.toolCallId, "command", { tool, command: String(args.command || ""), description: String(args.description || ""), background: args.mode === "async", detached: args.detach === true, status: "running", output: "" });
  } else if (tool === "str_replace_editor" && args.command === "view") {
    upsert(session, data.toolCallId, "tool", { tool, summary: `Read ${relative(session, args.path) || "a file"}`, status: "running" });
  } else if (FILE_WRITE_TOOLS.includes(tool)) {
    const patch = Object.values(args).find((value): value is string => typeof value === "string" && value.includes("*** "));
    const targets = patch ? [...patch.matchAll(/\*\*\* (Add|Update|Delete) File: (.+)/g)].map(match => ({ file: relative(session, match[2].trim()), action: match[1] === "Add" ? "Created" : match[1] === "Delete" ? "Deleted" : "Edited" }))
      : typeof args.path === "string" ? [{ file: relative(session, args.path), action: tool === "create" ? "Created" : "Edited" }] : [];
    for (const target of targets) {
      const key = fileKey(data.toolCallId, target.file);
      track(session, data.toolCallId, key);
      upsert(session, key, "file", { tool, path: target.file, action: target.action, status: "running" });
    }
  } else {
    const summary = tool === "view" ? `Read ${relative(session, args.path) || "a file"}`
      : tool === "grep" || tool === "rg" ? `Searched for “${String(args.pattern || "").slice(0, 120)}”`
      : tool === "glob" ? `Listed files matching ${String(args.pattern || "").slice(0, 120)}`
      : tool === "web_fetch" ? `Fetched ${String(args.url || "").slice(0, 200)}`
      : tool === `stop_${SHELL}` ? "Stopped a background command" : tool;
    upsert(session, data.toolCallId, "tool", { tool, summary, status: "running" });
  }
}
function onShellOutput(session: CodeSession, data: { toolCallId: string; text: string }) {
  const card = session.cards.get(data.toolCallId);
  if (!card || card.kind !== "command") return;
  session.turn?.activity?.();
  const output = String(card.data.output || "") + data.text;
  upsert(session, data.toolCallId, "command", { output: output.length > 64_000 ? output.slice(-64_000) : output }, true);
}
function onToolComplete(session: CodeSession, data: { toolCallId: string; success?: boolean; result?: { content?: string }; error?: { message?: string } }) {
  const keys = [...(session.toolKeys.get(data.toolCallId) || []), ...(session.cards.has(data.toolCallId) ? [data.toolCallId] : [])];
  session.toolKeys.delete(data.toolCallId);
  if (keys.length) session.turn?.activity?.();
  const failed = data.success === false || Boolean(data.error);
  for (const key of keys) {
    const card = session.cards.get(key);
    if (!card) continue;
    const approval = card.data.approval as { state?: string } | undefined;
    const denied = approval?.state === "deny" || card.data.status === "blocked";
    const status = denied ? card.data.status === "blocked" ? "blocked" : "denied" : failed ? "failed" : card.data.background ? "started" : "done";
    const patch: Record<string, unknown> = { status };
    if (card.kind === "command") {
      const result = data.result?.content || data.error?.message || "";
      if (!card.data.output && result) patch.output = result.slice(-64_000);
      const images = newScreenshots(session, card.createdAt);
      if (images.length) patch.images = images;
    } else if (failed && data.error?.message) patch.error = data.error.message.slice(0, 2000);
    upsert(session, key, card.kind, patch);
    if (card.kind === "command" || card.kind === "file") {
      session.turn?.audit(card.kind === "command" ? "code.command" : "code.file", session.chatId, denied ? "denied" : failed ? "error" : "allowed",
        String(card.kind === "command" ? card.data.command : `${card.data.action} ${card.data.path}`).slice(0, 400));
    }
  }
}

async function permission(session: CodeSession, request: PermissionRequest) {
  const turn = session.turn;
  if (!turn) return { kind: "reject" as const, feedback: "Nothing runs between turns in Model Chat's coding mode." };
  const toolCallId = request.toolCallId || randomUUID();
  const write = request.kind === "write" ? request as unknown as { fileName?: string; diff?: string; newFileContents?: string; intention?: string } : null;
  const file = write ? relative(session, write.fileName) : "";
  const key = write ? fileKey(toolCallId, file) : toolCallId;
  if (write) track(session, toolCallId, key);
  const kind: CodeEvent["kind"] = request.kind === "shell" ? "command" : write ? "file" : "tool";
  const diff = write ? tidyDiff(session, write.diff || write.newFileContents || "") : "";
  const fileFields = write ? { path: file, action: session.cards.get(key)?.data.action || writeAction(write.intention, diff), ...(diff ? { diff } : {}) } : {};
  // Detached processes outlive the session where Model Chat can't list or stop them.
  const detached = request.kind === "shell" && session.cards.get(toolCallId)?.data.detached === true;
  const decision = detached ? { action: "reject" as const, reason: "Model Chat can't list or stop detached processes. Run it with mode \"async\" and without detach." } : gate(request, session.project, session.allowances);
  if (decision.action === "approve") {
    if (write) upsert(session, key, "file", fileFields);
    return { kind: "approve-once" as const };
  }
  if (decision.action === "reject") {
    upsert(session, key, kind, { status: "blocked", blockedReason: decision.reason, ...fileFields, ...(request.kind === "shell" ? { command: request.fullCommandText } : {}) });
    turn.audit("code.blocked", session.chatId, "denied", `${request.kind}: ${decision.reason}`.slice(0, 400));
    return { kind: "reject" as const, feedback: decision.reason };
  }
  const card: ApprovalCard = decision.card;
  const id = randomUUID();
  turn.progress?.("Waiting for your approval");
  upsert(session, key, kind, {
    status: "awaiting approval",
    ...(card.kind === "command" ? { command: card.subject } : card.kind === "write" ? fileFields : { summary: card.kind === "url" ? `Fetch ${card.subject}` : `Read ${card.subject}` }),
    approval: { id, kind: card.kind, subject: card.subject, intention: card.intention, outside: card.outside, warning: card.warning, sessionScope: card.sessionScope, state: "pending" },
  });
  const answer = await new Promise<Decision>(resolve => {
    const cancel = () => resolve("deny");
    pending.set(id, { chatId: session.chatId, ownerId: session.ownerId, resolve: value => { turn.signal.removeEventListener("abort", cancel); resolve(value); } });
    turn.signal.addEventListener("abort", cancel, { once: true });
    if (turn.signal.aborted) cancel();
  }).finally(() => pending.delete(id));
  const current = session.cards.get(key);
  turn.progress?.(answer === "deny" ? "Continuing without that step" : "Working in the project");
  upsert(session, key, kind, { status: answer === "deny" ? "denied" : "running", approval: { ...(current?.data.approval as object), state: answer } });
  turn.audit("code.approval", session.chatId, answer === "deny" ? "denied" : "allowed", `${answer} ${card.kind}: ${card.subject}`.slice(0, 400));
  return applyDecision(card, answer, session.allowances);
}

async function startSession(chat: Chat, ownerId: string, model: string, effort: ReasoningEffort | undefined, store: Store): Promise<CodeSession> {
  // Shells inherit the runtime's environment, so this client gets no token there: each session receives it over RPC.
  const home = copilotHomeDirectory();
  const cwd = path.join(home, "empty-workspace");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const client = new CopilotClient({ mode: "empty", baseDirectory: home, workingDirectory: cwd, env: codingEnvironment(), useLoggedInUser: false, logLevel: "error" });
  const expected = await copilotSessionToken();
  const sessionId = `modelchat-code-${randomUUID()}`;
  const partial = { chatId: chat.id, ownerId, project: chat.projectPath!, model, store, client, sessionId, allowances: emptyAllowances(), cards: new Map(), toolKeys: new Map(), turn: null, lastActive: Date.now(), fresh: true } as unknown as CodeSession;
  try {
    await deadline(client.start(), 30_000);
    const config = codingSessionConfig(model, partial.project, sessionId, effort, request => permission(partial, request));
    let provided = 0;
    config.gitHubTokenProvider = async () => {
      const current = await copilotSessionToken();
      if (current.login.toLowerCase() !== expected.login.toLowerCase()) return { kind: "cancelled" };
      provided += 1;
      return { kind: "token", accessToken: current.token, expiresIn: 8 * 60 * 60 };
    };
    partial.session = await deadline(client.createSession(config), 60_000);
    // This runtime has no keychain, gh or environment credential, so the only identity it can use is the provider's token.
    const status = await deadline(partial.session.rpc.accounts.get({ query: { kind: "status" } }), 15_000);
    const ambient = status.kind === "status" ? status.status.activeLogin : null;
    if (!provided || (ambient && ambient.toLowerCase() !== expected.login.toLowerCase())) throw new AppError(503, "The coding session didn't use this app's Copilot account. Coding was blocked.");
    await deadline(partial.session.rpc.tools.initializeAndValidate(), 30_000);
    verifyCodingTools((await deadline(partial.session.rpc.tools.getCurrentMetadata(), 15_000)).tools);
    partial.session.on("tool.execution_start", event => onToolStart(partial, event.data));
    partial.session.on("tool.shell_output", event => onShellOutput(partial, event.data));
    partial.session.on("tool.execution_complete", event => onToolComplete(partial, event.data));
    // Background commands can end on their own (a crash, or a finished build); their cards follow.
    partial.session.on("session.background_tasks_changed", () => {
      void partial.session.rpc.tasks.list().then(list => {
        const running = new Set(list.tasks.filter(task => task.type === "shell" && task.status === "running").map(task => (task as { command?: string }).command));
        markStopped(partial, card => !running.has(String(card.data.command)));
      }).catch(() => undefined);
    });
    return partial;
  } catch (error) {
    await closeClient(client);
    throw error;
  }
}
async function ensureSession(chat: Chat, ownerId: string, model: string, effort: ReasoningEffort | undefined, store: Store) {
  const existing = sessions.get(chat.id);
  if (existing && existing.ownerId === ownerId && existing.project === chat.projectPath) {
    if (existing.model !== model) { await deadline(existing.session.setModel(model, effort ? { reasoningEffort: effort } : undefined), 30_000); existing.model = model; }
    return existing;
  }
  if (existing) await disposeCodeSession(chat.id);
  let start = starting.get(chat.id);
  if (!start) {
    start = startSession(chat, ownerId, model, effort, store).finally(() => starting.delete(chat.id));
    starting.set(chat.id, start);
  }
  const session = await start;
  sessions.set(chat.id, session);
  return session;
}

/** A ReplyRunner for one coding turn in a long-lived session; createChatStream saves the reply and relays events. */
export function codingRunner(args: { store: Store; chat: Chat; ownerId: string; audit: Audit; history: { role: string; content: string }[] }): ReplyRunner {
  return async input => {
    if (!args.chat.projectPath) throw new AppError(400, "This coding chat has no project folder.");
    const session = await ensureSession(args.chat, args.ownerId, input.model, input.reasoningEffort, args.store);
    if (session.turn) throw new AppError(409, "A coding turn is already running in this chat.");
    session.turn = { messageId: input.assistantMessageId!, emit: input.onCodeEvent, audit: args.audit, signal: input.signal, activity: input.onRequestStart, progress: input.onProgress };
    input.onProgress?.("Working in the project");
    session.lastActive = Date.now();
    const accumulate = createMessageAccumulator(input.onDelta, input.onReplace);
    const reason = input.onReasoning ? createMessageAccumulator(text => input.onReasoning!(text, false), text => input.onReasoning!(text, true)) : null;
    let sessionError: string | undefined;
    const off = [
      session.session.on("assistant.message_delta", event => { session.turn?.activity?.(); accumulate(event.data.messageId, event.data.deltaContent, false); }),
      session.session.on("assistant.message", event => accumulate(event.data.messageId, event.data.content || "", true)),
      session.session.on("session.error", event => { sessionError = event.data.message; }),
      ...(reason ? [
        session.session.on("assistant.reasoning_delta", event => reason(event.data.reasoningId, event.data.deltaContent, false)),
        session.session.on("assistant.reasoning", event => reason(event.data.reasoningId, event.data.content || "", true)),
      ] : []),
    ];
    let abortListener: (() => void) | undefined;
    try {
      args.audit("code.turn", args.chat.id, "allowed", `project ${session.project}`.slice(0, 400));
      const prior = session.fresh ? args.history.slice(-12).map(item => `${item.role === "user" ? "Owner" : "You"}: ${item.content.slice(0, 2000)}`).join("\n\n") : "";
      session.fresh = false;
      const prompt = prior ? `Earlier in this coding conversation (for context only):\n${prior}\n\nNew request:\n${input.prompt}` : input.prompt;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => { void session.session.abort().catch(() => undefined); reject(new DOMException("Reply cancelled", "AbortError")); };
        input.signal.addEventListener("abort", abortListener, { once: true });
        if (input.signal.aborted) abortListener();
      });
      input.authorize?.();
      // A turn ends when the agent's loop does; attached background commands (dev servers) keep running and stay stoppable.
      let finish!: () => void, fail!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      off.push(
        session.session.on("assistant.idle", event => { if (!event.agentId) finish(); }),
        session.session.on("session.idle", () => finish()),
        session.session.on("session.error", event => fail(new Error(event.data.message))),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(504, "The coding turn ran for 6 hours and was stopped.")), 6 * 60 * 60_000); });
      try {
        await Promise.race([session.session.send({ prompt }).then(() => finished), aborted, limit]);
      } finally { clearTimeout(timer); }
      if (sessionError) throw new Error(sessionError);
    } catch (error) {
      if (input.signal.aborted) throw new DOMException("Reply cancelled", "AbortError");
      throw copilotError(error);
    } finally {
      for (const unsubscribe of off) unsubscribe();
      if (abortListener) input.signal.removeEventListener("abort", abortListener);
      for (const [id, item] of pending) if (item.chatId === args.chat.id) item.resolve("deny");
      // After Stop or a failure nothing from this turn is still running or waiting.
      for (const [key, card] of session.cards) if (card.messageId === input.assistantMessageId && ["running", "awaiting approval"].includes(String(card.data.status))) upsert(session, key, card.kind, { status: "stopped" });
      for (const card of session.cards.values()) if (card.flush) { clearTimeout(card.flush); card.flush = undefined; try { args.store.updateCodeEvent(args.ownerId, args.chat.id, card.id, card.data); } catch { /* deleted */ } }
      session.turn = null;
      session.lastActive = Date.now();
    }
  };
}

export function decideApproval(ownerId: string, approvalId: string, decision: Decision) {
  const item = pending.get(approvalId);
  if (!item || item.ownerId !== ownerId) throw new AppError(404, "That approval is no longer waiting.");
  item.resolve(decision);
  return { chatId: item.chatId };
}
export async function listProcesses(chatId: string, ownerId: string) {
  const session = sessions.get(chatId);
  if (!session || session.ownerId !== ownerId) return [];
  const list = await deadline(session.session.rpc.tasks.list(), 15_000);
  return list.tasks.filter(task => task.type === "shell").map(task => {
    const shell = task as { id: string; command: string; description: string; status: string; startedAt: string; completedAt?: string; pid?: number };
    return { id: shell.id, command: shell.command, description: shell.description, status: shell.status, startedAt: shell.startedAt, completedAt: shell.completedAt ?? null, pid: shell.pid ?? null };
  });
}
export async function stopProcess(chatId: string, ownerId: string, taskId: string) {
  const session = sessions.get(chatId);
  if (!session || session.ownerId !== ownerId) throw new AppError(404, "No running coding session for this chat.");
  const task = (await deadline(session.session.rpc.tasks.list(), 15_000)).tasks.find(item => item.id === taskId) as { command?: string } | undefined;
  const result = await deadline(session.session.rpc.tasks.cancel({ id: taskId }), 15_000);
  if (task?.command) markStopped(session, card => card.data.command === task.command);
  return result;
}
function markStopped(session: CodeSession, match: (card: Card) => boolean) {
  for (const [key, card] of session.cards) if (card.kind === "command" && card.data.status === "started" && match(card)) upsert(session, key, "command", { status: "stopped" });
}
export async function disposeCodeSession(chatId: string) {
  const session = sessions.get(chatId);
  if (!session) return;
  sessions.delete(chatId);
  for (const [id, item] of pending) if (item.chatId === chatId) { item.resolve("deny"); pending.delete(id); }
  markStopped(session, () => true);
  try { await deadline(session.session.disconnect(), 5000); await deadline(session.client.deleteSession(session.sessionId), 5000); } catch { /* Best effort; stopping the client ends its processes. */ }
  await closeClient(session.client);
}
export function hasCodeSession(chatId: string) { return sessions.has(chatId); }
