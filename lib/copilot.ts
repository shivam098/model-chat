import { CopilotClient, type SessionConfig, type CopilotSession, type ModelInfo, type SessionEvent, type Tool } from "@github/copilot-sdk";
type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { systemInstruction } from "./context";
import type { CodeEvent, NativeImage, WebSource } from "./contracts";
import { WEB_SERVER, WEB_TOOL, extractSources, mergeSources } from "./web-search";
import { nearestLevel, orderedLevels, type ThinkingLevel } from "./thinking";
import { SDK_WAIT_MS } from "./reply-watchdog";
import { checkTokenWithGitHub, credentialPlan, isAccountError, isolatedRuntimeEnvironment, selectStoredSignIn, tokenLogin, tokenProblem, verifyRuntimeIdentity, type CredentialPlan } from "./copilot-account";
import { redactSecrets, takeCopilotToken } from "./secret-env.mjs";

const copilotHome = process.env.MODEL_CHAT_COPILOT_HOME ? path.resolve(process.env.MODEL_CHAT_COPILOT_HOME) : path.join(dataDirectory, "copilot");
interface CopilotCredential { login: string; source: string; token: string; at: number; viaToken: boolean }
const credentialState = globalThis as typeof globalThis & {
  modelChatCopilotCredential?: CopilotCredential;
  modelChatCopilotCredentialPending?: Promise<CopilotCredential>;
};
const CREDENTIAL_TTL_MS = 10 * 60_000;
export function forgetCopilotCredential() {
  credentialState.modelChatCopilotCredential = undefined;
}
/** True when this copy signs in with MODEL_CHAT_COPILOT_TOKEN instead of npm run copilot:login. */
export function usesCopilotToken() {
  return Boolean(takeCopilotToken());
}
// The token stays in this process's memory; it is never logged or written by the app.
async function copilotCredential(refresh = false): Promise<CopilotCredential> {
  const plan = credentialPlan(copilotHome, takeCopilotToken());
  const cached = credentialState.modelChatCopilotCredential;
  const sameAccount = cached && cached.source === plan.source && (!plan.login || cached.login.toLowerCase() === plan.login.toLowerCase());
  if (!refresh && cached && sameAccount && Date.now() - cached.at < CREDENTIAL_TTL_MS) return cached;
  if (credentialState.modelChatCopilotCredentialPending) return credentialState.modelChatCopilotCredentialPending;
  credentialState.modelChatCopilotCredentialPending = (async () => {
    forgetCopilotCredential();
    const cwd = path.join(copilotHome, "empty-workspace");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const credential = plan.kind === "token" ? await tokenCredential(plan, cwd) : await storedCredential(plan, cwd);
    credentialState.modelChatCopilotCredential = credential;
    return credential;
  })().finally(() => { credentialState.modelChatCopilotCredentialPending = undefined; });
  return credentialState.modelChatCopilotCredentialPending;
}
async function storedCredential(plan: Extract<CredentialPlan, { kind: "stored" }>, cwd: string): Promise<CopilotCredential> {
  // Only "copilot-cli" mode may read the OS credential store where `copilot login` keeps the app's sign-in
  // ("empty" mode disables it). This client only reads the account roster and never creates a session.
  const broker = new CopilotClient({
    mode: "copilot-cli",
    baseDirectory: copilotHome,
    workingDirectory: cwd,
    env: isolatedRuntimeEnvironment(copilotHome),
    useLoggedInUser: true,
    logLevel: "error",
  });
  try {
    await deadline(broker.start(), 30_000);
    const signIn = selectStoredSignIn(await deadline(broker.rpc.account.getAllUsers(), 15_000), plan.login);
    return { ...signIn, source: plan.source, at: Date.now(), viaToken: false };
  } finally { await closeClient(broker); }
}
async function tokenCredential(plan: Extract<CredentialPlan, { kind: "token" }>, cwd: string): Promise<CopilotCredential> {
  // The token reaches only the Copilot runtime (as gitHubToken), which resolves the account it belongs to. This client never creates a session.
  const probe = new CopilotClient({
    mode: "empty",
    baseDirectory: copilotHome,
    workingDirectory: cwd,
    env: isolatedRuntimeEnvironment(copilotHome),
    gitHubToken: plan.token,
    useLoggedInUser: false,
    logLevel: "error",
  });
  try {
    await deadline(probe.start(), 30_000);
    const current = await deadline(probe.rpc.account.getCurrentAuth(), 15_000);
    const login = tokenLogin(current, plan.login);
    if (!login) throw tokenProblem(await checkTokenWithGitHub(plan.token), (current.authErrors ?? []).map(redactSecrets));
    return { login, token: plan.token, source: plan.source, at: Date.now(), viaToken: true };
  } finally { await closeClient(probe); }
}
/** The account the app is using, for owner diagnostics. */
export async function copilotAccount(): Promise<{ login: string; source: string }> {
  const { login, source } = await copilotCredential();
  return { login, source };
}
/** For coding sessions only: the token is handed to the runtime over RPC per session, never through its environment. */
export async function copilotSessionToken(): Promise<{ login: string; token: string }> {
  const { login, token } = await copilotCredential();
  return { login, token };
}
export function copilotHomeDirectory() { return copilotHome; }
export async function createClient(refreshCredential = false, environment?: Record<string, string | undefined>) {
  const cwd = path.join(copilotHome, "empty-workspace");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const credential = await copilotCredential(refreshCredential);
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: copilotHome,
    workingDirectory: cwd,
    env: environment ?? isolatedRuntimeEnvironment(copilotHome),
    // Only this app's credential (stored sign-in or MODEL_CHAT_COPILOT_TOKEN); useLoggedInUser:false stops any fallback to gh or environment tokens.
    gitHubToken: credential.token,
    useLoggedInUser: false,
    sessionIdleTimeoutSeconds: 300,
    logLevel: "error",
  });
  try {
    await deadline(client.start(), 30_000);
    verifyRuntimeIdentity(await deadline(client.rpc.account.getCurrentAuth(), 15_000), credential.login, credential.viaToken);
  } catch (error) {
    await closeClient(client);
    if (isAccountError(error)) forgetCopilotCredential();
    throw error;
  }
  return client;
}
export async function closeClient(client: CopilotClient) {
  try {
    const errors = await deadline(client.stop(), 5000);
    if (errors.length) console.error("[model-chat] Copilot cleanup reported errors:", errors.map(e => e.name).join(", "));
  } catch (error) {
    console.error("[model-chat] Copilot cleanup failed:", error instanceof Error ? error.name : "Unknown");
    await client.forceStop();
  }
}
export function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(504, "Copilot timed out. Check your connection and try again.")), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
export function copilotError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/auth|sign.?in|token|401|403|entitle|subscription/i.test(message)) {
    forgetCopilotCredential();
    return new AppError(503, usesCopilotToken()
      ? "Copilot authentication or entitlement is unavailable. The host owner can run npm run check:copilot on this machine for details."
      : "Copilot authentication or entitlement is unavailable. Run npm run copilot:login on this machine, then refresh the connection.", { cause: error });
  }
  if (/model.*(not|invalid|unavailable)|quota|rate.limit|429|402|budget/i.test(message)) {
    return new AppError(503, "Copilot refused the selected model or its usage limit was reached. Refresh the model list or check your Copilot plan.", { cause: error });
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return new AppError(504, "Copilot timed out. Check your connection and try again.");
  console.error("[model-chat] Copilot failure:", error instanceof Error ? error.name : "Unknown");
  return new AppError(503, "The local Copilot runtime could not complete this request. Check your network, Copilot sign-in and the server console; then try again.", { cause: error });
}
const catalogState = globalThis as typeof globalThis & {
  modelChatCatalog?: { models: ModelInfo[]; at: number };
  modelChatCatalogPending?: Promise<ModelInfo[]>;
};
export function modelPromptTokens(limits: ModelInfo["capabilities"]["limits"]): number | undefined {
  const reported = [limits.max_prompt_tokens, limits.max_context_window_tokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return reported.length ? Math.min(...reported) : undefined;
}
export async function listModels(refresh = false): Promise<ModelInfo[]> {
  if (!refresh && catalogState.modelChatCatalog && Date.now() - catalogState.modelChatCatalog.at < 60_000) return catalogState.modelChatCatalog.models;
  if (catalogState.modelChatCatalogPending) return catalogState.modelChatCatalogPending;
  catalogState.modelChatCatalogPending = (async () => {
    const client = await createClient(refresh);
    try {
      const allowed = (await deadline(client.listModels(), 30_000)).filter(m => m.policy?.state !== "disabled");
      const models = allowed.filter(model => (modelPromptTokens(model.capabilities.limits) ?? 0) > 8192);
      if (models.length !== allowed.length) console.warn("[model-chat] Omitted catalog entries without a usable advertised context limit:", allowed.length - models.length);
      if (!models.length) throw new AppError(503, "Copilot did not return any allowed models with a usable advertised context limit. Check your subscription, policy and runtime.");
      catalogState.modelChatCatalog = { models, at: Date.now() };
      return models;
    } finally { await closeClient(client); }
  })().catch(error => { throw copilotError(error); }).finally(() => { catalogState.modelChatCatalogPending = undefined; });
  return catalogState.modelChatCatalogPending;
}
export function safeSessionConfig(model: string, directory: string, sessionId: string, tools: Tool[] = [], toolInstruction?: string, reasoningEffort?: ThinkingLevel, webSearch = false, extra: { hooks?: SessionConfig["hooks"]; pageReader?: boolean } = {}): SessionConfig {
  const allowed = new Set(tools.map(tool => tool.name));
  return {
    sessionId,
    model,
    clientName: "Model Chat",
    // "none" (Off) is a catalogue level the SDK's type doesn't list yet; the runtime accepts it and then returns no reasoning.
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ReasoningEffort, ...(reasoningEffort === "none" ? {} : { reasoningSummary: "detailed" as const }) } : {}),
    // Only app-defined tools (and, for web-enabled chats, GitHub's hosted web search) are allow-listed; every other built-in, MCP and custom tool stays excluded.
    availableTools: [...tools.map(tool => `custom:${tool.name}`), ...(webSearch ? [`mcp:${WEB_TOOL}`] : [])],
    excludedTools: webSearch ? (tools.length ? ["builtin:*"] : ["builtin:*", "custom:*"]) : tools.length ? ["builtin:*", "mcp:*"] : ["builtin:*", "mcp:*", "custom:*"],
    // The runtime's built-in GitHub MCP server starts only for web-enabled chats, limited to its web search toolset; the filter above admits only web_search.
    ...(webSearch ? { githubMcpToolConfig: { additionalToolsets: ["web_search"] }, toolSearch: { enabled: false } } : {}),
    tools,
    mcpServers: {},
    customAgents: [],
    includedBuiltinSkills: [],
    skillDirectories: [],
    // Only the app's own in-process hooks (deep research uses one to cap searches); nothing is loaded from the environment.
    hooks: extra.hooks ?? {},
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    enableSessionTelemetry: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    memory: { enabled: false },
    infiniteSessions: { enabled: false },
    requestExtensions: false,
    requestCanvasRenderer: false,
    manageScheduleEnabled: false,
    workingDirectory: directory,
    configDirectory: copilotHome,
    streaming: true,
    systemMessage: { mode: "replace", content: systemInstruction(tools.length ? toolInstruction : undefined, webSearch, extra.pageReader) },
    onPermissionRequest: request => (request.kind === "custom-tool" && allowed.has(request.toolName))
      || (webSearch && request.kind === "mcp" && request.serverName === WEB_SERVER && request.toolName === WEB_TOOL)
      ? { kind: "approved" }
      : { kind: "reject", feedback: "Model Chat denies every built-in, filesystem, shell, URL, MCP and unknown tool request." },
  };
}
export interface ReplyInput {
  model: string;
  prompt: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onReplace: (text: string) => void;
  images?: NativeImage[];
  authorize?: () => void;
  onProgress?: (stage: string) => void;
  /** Real runtime activity (any SDK event, a tool's progress): restarts the reply's silence watchdog. */
  onActivity?: () => void;
  /** Pauses the silence watchdog while waiting on the owner, such as a coding approval; returns the resume function. */
  holdActivity?: () => () => void;
  assistantMessageId?: string;
  onAttachments?: () => void;
  tools?: Tool[];
  toolInstruction?: string;
  reasoningEffort?: ThinkingLevel;
  onReasoning?: (text: string, replace: boolean) => void;
  /** Coding mode: a command, file change or approval card was created or updated. */
  onCodeEvent?: (event: CodeEvent) => void;
  /** Offer GitHub's hosted web search in this turn (decided by the server for the account). */
  webSearch?: boolean;
  onWeb?: (update: { searching: boolean; searches: number; sources: WebSource[] }) => void;
  /** Deep research: the session also has the read_page tool, a tool call can be refused before it runs, and every session event is observed. */
  pageReader?: boolean;
  preToolUse?: (toolName: string, args: unknown) => string | null;
  onSessionEvent?: (event: SessionEvent) => void;
}
export type ReplyRunner = (input: ReplyInput) => Promise<void>;
// Without an explicit level the runtime requests no reasoning; "medium" lets models think when a question warrants it.
// A chosen level is used when the model supports it, otherwise the nearest one it does.
export function replyReasoningEffort(model: ModelInfo, requested?: string | null): ThinkingLevel | undefined {
  if (!model.capabilities.supports.reasoningEffort) return undefined;
  const levels = model.supportedReasoningEfforts as string[] | undefined;
  if (!requested && model.defaultReasoningEffort && orderedLevels(levels).includes(model.defaultReasoningEffort as ThinkingLevel)) return model.defaultReasoningEffort as ThinkingLevel;
  return nearestLevel(levels, requested);
}
/** The levels a model offers in the picker, or undefined when it has no adjustable reasoning. */
export function modelLevels(model: ModelInfo): string[] | undefined {
  if (!model.capabilities.supports.reasoningEffort) return undefined;
  const levels = orderedLevels(model.supportedReasoningEfforts as string[] | undefined);
  return levels.length ? levels : undefined;
}
export function verifyToolMetadata(tools: { name: string; mcpServerName?: string; deferLoading?: boolean }[] | null | undefined, expected: string[]) {
  const names = (tools || []).map(tool => tool.name).sort();
  if (!tools || names.join("\n") !== [...expected].sort().join("\n") || tools.some(tool => tool.mcpServerName || tool.deferLoading)) {
    throw new AppError(503, expected.length
      ? "The runtime did not confirm that only the app's sandboxed code tool is active. Generation was blocked for safety."
      : "The runtime did not confirm a tool-free session. Generation was blocked for safety.");
  }
}
const toolViolationError = () => new AppError(503, "The runtime offered a tool Model Chat doesn't allow in this chat, so the reply was stopped for safety.");
/**
 * A model that spent its whole output allowance on thinking and wrote no answer. Measured with Claude Opus 5.5 at Max on a hard proof:
 * 283 s of streamed reasoning used all 32,000 output tokens, and the runtime's continuation then failed (its fallback model isn't offered to apps).
 */
export function thinkingExhausted(usage: { finishReason?: string; maxOutputTokens?: number; model?: string; modelDisplayName?: string }, answered: boolean) {
  if (answered || usage.finishReason !== "length") return null;
  const budget = usage.maxOutputTokens ? `${usage.maxOutputTokens.toLocaleString("en-US")}-token ` : "";
  return new AppError(503, `${usage.modelDisplayName || usage.model || "The model"} used its whole ${budget}output allowance thinking before writing an answer, and Copilot couldn't continue the reply. Its thinking is saved under Show thinking. Try a lower thinking level (for example High) or another model.`);
}
/**
 * GPT models send nothing while they think. Measured with GPT-6 Sol at Max: the connection to the model closed after about 631 s
 * without data ("unexpected EOF", failureKind "transport"), and the runtime retried from scratch. Returns the silent minutes, or null.
 */
export function silentCallDropped(failure: { failureKind?: string; durationMs?: number }) {
  return failure.failureKind === "transport" && (failure.durationMs ?? 0) >= 5 * 60_000 ? Math.round(failure.durationMs! / 60_000) : null;
}
export function droppedThinkingError(minutes: number) {
  return new AppError(503, `The connection to the model closed after about ${minutes} minutes of silent thinking, and Copilot's retries didn't finish either. GPT models send nothing while they think, and that connection doesn't stay open longer. Try a lower thinking level or another model.`);
}
export function createMessageAccumulator(onDelta: (text: string) => void, onReplace: (text: string) => void) {
  const parts = new Map<string, string>();
  let sent = "";
  return (messageId: string, text: string, complete: boolean) => {
    parts.set(messageId, complete ? text : (parts.get(messageId) || "") + text);
    const full = [...parts.values()].filter(part => part.trim()).join("\n\n");
    if (full.startsWith(sent)) { if (full.length > sent.length) onDelta(full.slice(sent.length)); }
    else onReplace(full);
    sent = full;
  };
}
/** Every tool the runtime offers mid-turn must be an app tool or, for web-enabled chats, GitHub's web search; anything else stops the reply. */
export function unexpectedTool(tools: { name: string; mcpServerName?: string }[], customNames: string[], webSearch: boolean) {
  return tools.find(tool => tool.mcpServerName
    ? !(webSearch && tool.mcpServerName === WEB_SERVER && tool.name === WEB_TOOL)
    : !customNames.includes(tool.name))?.name ?? null;
}
export const runCopilotReply: ReplyRunner = async ({ model, prompt, signal, onDelta, onReplace, images, authorize, onActivity, onProgress, tools = [], toolInstruction, reasoningEffort, onReasoning, webSearch = false, onWeb, pageReader = false, preToolUse, onSessionEvent }) => {
  onActivity?.();
  const sessionId = `modelchat-${randomUUID()}`;
  const directory = path.join(copilotHome, "requests", sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let client: CopilotClient | undefined;
  let session: CopilotSession | undefined;
  let abortListener: (() => void) | undefined;
  let toolViolation: string | undefined;
  let exhausted: AppError | null = null;
  let dropped: number | null = null;
  let answered = false;
  const unsubscribe: (() => void)[] = [];
  try {
    signal.throwIfAborted();
    authorize?.();
    client = await createClient();
    signal.throwIfAborted();
    const hooks: SessionConfig["hooks"] = preToolUse ? {
      onPreToolUse: input => {
        const reason = preToolUse(input.toolName, input.toolArgs);
        return reason ? { permissionDecision: "deny", permissionDecisionReason: reason } : undefined;
      },
    } : undefined;
    session = await deadline(client.createSession(safeSessionConfig(model, directory, sessionId, tools, toolInstruction, reasoningEffort, webSearch, { hooks, pageReader })), 30_000);
    signal.throwIfAborted();
    await deadline(session.rpc.tools.initializeAndValidate(), 15_000);
    const metadata = await deadline(session.rpc.tools.getCurrentMetadata(), 15_000);
    verifyToolMetadata(metadata.tools, tools.map(tool => tool.name));
    signal.throwIfAborted();
    authorize?.();
    // Every runtime event (reasoning, text, tool calls, usage, progress) shows the request is still alive.
    unsubscribe.push(session.on(() => onActivity?.()));
    if (onSessionEvent) unsubscribe.push(session.on(event => onSessionEvent(event)));
    // A tool-using turn can contain several assistant messages; keep all of them in one saved reply.
    const accumulate = createMessageAccumulator(onDelta, onReplace);
    unsubscribe.push(session.on("assistant.message_delta", event => accumulate(event.data.messageId, event.data.deltaContent, false)));
    unsubscribe.push(session.on("assistant.message", event => accumulate(event.data.messageId, event.data.content || "", true)));
    if (onReasoning) {
      const reason = createMessageAccumulator(text => onReasoning(text, false), text => onReasoning(text, true));
      unsubscribe.push(session.on("assistant.reasoning_delta", event => reason(event.data.reasoningId, event.data.deltaContent, false)));
      unsubscribe.push(session.on("assistant.reasoning", event => reason(event.data.reasoningId, event.data.content || "", true)));
    }
    let sessionError: string | undefined;
    unsubscribe.push(session.on("session.error", event => { sessionError = event.data.message; }));
    unsubscribe.push(session.on("assistant.message_delta", event => { if (event.data.deltaContent.trim()) answered = true; }));
    unsubscribe.push(session.on("assistant.usage", event => { exhausted = thinkingExhausted(event.data as Parameters<typeof thinkingExhausted>[0], answered) ?? exhausted; }));
    let attempts = 1;
    unsubscribe.push(session.on("model.call_failure", event => { dropped = silentCallDropped(event.data) ?? dropped; }));
    // A retry restarts the model's work; it isn't stopped, but the owner sees it and can Stop. (Not in the SDK's typed event list.)
    unsubscribe.push(session.on(event => {
      if ((event.type as string) !== "assistant.turn_retry") return;
      attempts++;
      onProgress?.(dropped ? `Connection closed after ${dropped} min of silent thinking; retrying (attempt ${attempts})` : `Retrying the model request (attempt ${attempts})`);
    }));
    if (webSearch) {
      // GitHub's MCP tools load when the turn starts, so the tool set is checked again then, and every tool call is checked as it starts.
      const customNames = tools.map(tool => tool.name);
      const pending = new Set<string>();
      const hosted = new Map<number, boolean>();
      let searches = 0;
      let sources: WebSource[] = [];
      const report = () => onWeb?.({ searching: pending.size > 0 || [...hosted.values()].some(Boolean), searches, sources });
      const violate = (name: string) => {
        toolViolation ||= name;
        void session?.abort().catch(error => console.error("[model-chat] Copilot abort failed:", error.name));
      };
      unsubscribe.push(session.on("session.tools_updated", () => {
        void session?.rpc.tools.getCurrentMetadata().then(metadata => { const bad = unexpectedTool(metadata.tools ?? [], customNames, true); if (bad) violate(bad); })
          .catch(() => violate("unverifiable tool list"));
      }));
      unsubscribe.push(session.on("tool.execution_start", event => {
        const { toolCallId, toolName, mcpServerName } = event.data;
        if (mcpServerName === WEB_SERVER && toolName === WEB_TOOL) {
          pending.add(toolCallId); searches++;
          onProgress?.("Searching the web"); report();
        } else if (unexpectedTool([{ name: toolName, mcpServerName }], customNames, true)) violate(toolName);
      }));
      unsubscribe.push(session.on("tool.execution_complete", event => {
        if (!pending.delete(event.data.toolCallId)) return;
        if (event.data.success !== false) sources = mergeSources(sources, extractSources(event.data.result?.content));
        onProgress?.(pending.size ? "Searching the web" : "Reading web results");
        report();
      }));
      // Provider-hosted search (not offered to this app's account today) reports progress without a tool call.
      unsubscribe.push(session.on("assistant.server_tool_progress", event => {
        if (event.data.kind !== "web_search") return;
        if (!hosted.has(event.data.outputIndex)) searches++;
        hosted.set(event.data.outputIndex, event.data.status !== "completed");
        onProgress?.(event.data.status === "completed" ? "Reading web results" : "Searching the web"); report();
      }));
    }
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => {
        void session?.abort().catch(error => console.error("[model-chat] Copilot abort failed:", error.name));
        reject(new DOMException("Reply cancelled", "AbortError"));
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
    signal.throwIfAborted();
    authorize?.();
    // No per-request deadline: the caller's silence watchdog or Stop ends the request (SDK_WAIT_MS only satisfies the API).
    await Promise.race([session.sendAndWait({ prompt, attachments: images }, SDK_WAIT_MS), aborted]);
    if (toolViolation) throw toolViolationError();
    if (sessionError) throw new Error(sessionError);
    if (exhausted && !answered) throw exhausted;
  } catch (error) {
    if (signal.aborted) throw new DOMException("Reply cancelled", "AbortError");
    if (toolViolation) throw toolViolationError();
    if (exhausted && !answered) throw exhausted;
    if (dropped && !answered) throw droppedThinkingError(dropped);
    throw copilotError(error);
  } finally {
    for (const off of unsubscribe) off();
    if (abortListener) signal.removeEventListener("abort", abortListener);
    if (client) {
      if (session) {
        try {
          await deadline(session.disconnect(), 5000);
          await deadline(client.deleteSession(sessionId), 5000);
        }
        catch (error) { console.error("[model-chat] SDK session cleanup failed:", error instanceof Error ? error.name : "Unknown"); }
      }
      await closeClient(client);
    }
    await rm(directory, { recursive: true, force: true });
  }
};
