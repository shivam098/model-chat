import { CopilotClient, type SessionConfig, type CopilotSession, type ModelInfo, type Tool } from "@github/copilot-sdk";
type ReasoningEffort = NonNullable<SessionConfig["reasoningEffort"]>;
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { systemInstruction } from "./context";
import type { CodeEvent, NativeImage, WebSource } from "./contracts";
import { WEB_SERVER, WEB_TOOL, extractSources, mergeSources } from "./web-search";
import { expectedCopilotLogin, isAccountError, isolatedRuntimeEnvironment, selectStoredSignIn, verifyRuntimeIdentity } from "./copilot-account";

const copilotHome = process.env.MODEL_CHAT_COPILOT_HOME ? path.resolve(process.env.MODEL_CHAT_COPILOT_HOME) : path.join(dataDirectory, "copilot");
interface CopilotCredential { login: string; source: string; token: string; at: number }
const credentialState = globalThis as typeof globalThis & {
  modelChatCopilotCredential?: CopilotCredential;
  modelChatCopilotCredentialPending?: Promise<CopilotCredential>;
};
const CREDENTIAL_TTL_MS = 10 * 60_000;
export function forgetCopilotCredential() {
  credentialState.modelChatCopilotCredential = undefined;
}
// The token stays in this process's memory; it is never logged or written by the app.
async function copilotCredential(refresh = false): Promise<CopilotCredential> {
  const expected = expectedCopilotLogin(copilotHome);
  const cached = credentialState.modelChatCopilotCredential;
  if (!refresh && cached && cached.login.toLowerCase() === expected.login.toLowerCase() && Date.now() - cached.at < CREDENTIAL_TTL_MS) return cached;
  if (credentialState.modelChatCopilotCredentialPending) return credentialState.modelChatCopilotCredentialPending;
  credentialState.modelChatCopilotCredentialPending = (async () => {
    forgetCopilotCredential();
    const cwd = path.join(copilotHome, "empty-workspace");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
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
      const signIn = selectStoredSignIn(await deadline(broker.rpc.account.getAllUsers(), 15_000), expected.login);
      const credential = { ...signIn, source: expected.source, at: Date.now() };
      credentialState.modelChatCopilotCredential = credential;
      return credential;
    } finally { await closeClient(broker); }
  })().finally(() => { credentialState.modelChatCopilotCredentialPending = undefined; });
  return credentialState.modelChatCopilotCredentialPending;
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
    // Only the app's own stored sign-in; useLoggedInUser:false stops any fallback to gh or environment tokens.
    gitHubToken: credential.token,
    useLoggedInUser: false,
    sessionIdleTimeoutSeconds: 300,
    logLevel: "error",
  });
  try {
    await deadline(client.start(), 30_000);
    verifyRuntimeIdentity(await deadline(client.rpc.account.getCurrentAuth(), 15_000), credential.login);
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
    return new AppError(503, "Copilot authentication or entitlement is unavailable. Run npm run copilot:login on this machine, then refresh the connection.", { cause: error });
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
export function safeSessionConfig(model: string, directory: string, sessionId: string, tools: Tool[] = [], toolInstruction?: string, reasoningEffort?: ReasoningEffort, webSearch = false): SessionConfig {
  const allowed = new Set(tools.map(tool => tool.name));
  return {
    sessionId,
    model,
    clientName: "Model Chat",
    ...(reasoningEffort ? { reasoningEffort, reasoningSummary: "detailed" as const } : {}),
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
    hooks: {},
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
    systemMessage: { mode: "replace", content: systemInstruction(tools.length ? toolInstruction : undefined, webSearch) },
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
  onRequestStart?: () => void;
  assistantMessageId?: string;
  onAttachments?: () => void;
  tools?: Tool[];
  toolInstruction?: string;
  reasoningEffort?: ReasoningEffort;
  onReasoning?: (text: string, replace: boolean) => void;
  /** Coding mode: a command, file change or approval card was created or updated. */
  onCodeEvent?: (event: CodeEvent) => void;
  /** Offer GitHub's hosted web search in this turn (decided by the server for the account). */
  webSearch?: boolean;
  onWeb?: (update: { searching: boolean; searches: number; sources: WebSource[] }) => void;
}
export type ReplyRunner = (input: ReplyInput) => Promise<void>;
// Without an explicit level the runtime requests no reasoning; "medium" lets models think when a question warrants it.
export function replyReasoningEffort(model: ModelInfo): ReasoningEffort | undefined {
  if (!model.capabilities.supports.reasoningEffort) return undefined;
  const supported = (model.supportedReasoningEfforts ?? []).filter(level => (level as string) !== "none");
  if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
  return supported.includes("medium") ? "medium" : supported[0];
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
export const runCopilotReply: ReplyRunner = async ({ model, prompt, signal, onDelta, onReplace, images, authorize, onRequestStart, onProgress, tools = [], toolInstruction, reasoningEffort, onReasoning, webSearch = false, onWeb }) => {
  onRequestStart?.();
  const sessionId = `modelchat-${randomUUID()}`;
  const directory = path.join(copilotHome, "requests", sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let client: CopilotClient | undefined;
  let session: CopilotSession | undefined;
  let abortListener: (() => void) | undefined;
  let toolViolation: string | undefined;
  const unsubscribe: (() => void)[] = [];
  try {
    signal.throwIfAborted();
    authorize?.();
    client = await createClient();
    signal.throwIfAborted();
    session = await deadline(client.createSession(safeSessionConfig(model, directory, sessionId, tools, toolInstruction, reasoningEffort, webSearch)), 30_000);
    signal.throwIfAborted();
    await deadline(session.rpc.tools.initializeAndValidate(), 15_000);
    const metadata = await deadline(session.rpc.tools.getCurrentMetadata(), 15_000);
    verifyToolMetadata(metadata.tools, tools.map(tool => tool.name));
    signal.throwIfAborted();
    authorize?.();
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
          onRequestStart?.(); onProgress?.("Searching the web"); report();
        } else if (unexpectedTool([{ name: toolName, mcpServerName }], customNames, true)) violate(toolName);
      }));
      unsubscribe.push(session.on("tool.execution_complete", event => {
        if (!pending.delete(event.data.toolCallId)) return;
        onRequestStart?.();
        if (event.data.success !== false) sources = mergeSources(sources, extractSources(event.data.result?.content));
        onProgress?.(pending.size ? "Searching the web" : "Reading web results");
        report();
      }));
      // Provider-hosted search (not offered to this app's account today) reports progress without a tool call.
      unsubscribe.push(session.on("assistant.server_tool_progress", event => {
        if (event.data.kind !== "web_search") return;
        if (!hosted.has(event.data.outputIndex)) searches++;
        hosted.set(event.data.outputIndex, event.data.status !== "completed");
        onRequestStart?.(); onProgress?.(event.data.status === "completed" ? "Reading web results" : "Searching the web"); report();
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
    await Promise.race([session.sendAndWait({ prompt, attachments: images }, tools.length ? 45 * 60_000 : webSearch ? 10 * 60_000 : 180_000), aborted]);
    if (toolViolation) throw toolViolationError();
    if (sessionError) throw new Error(sessionError);
  } catch (error) {
    if (signal.aborted) throw new DOMException("Reply cancelled", "AbortError");
    if (toolViolation) throw toolViolationError();
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
