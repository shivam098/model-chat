import { CopilotClient, type SessionConfig, type CopilotSession, type ModelInfo, type Tool } from "@github/copilot-sdk";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { systemInstruction } from "./context";
import { runtimeEnvironment } from "./runtime-env.mjs";
import type { NativeImage } from "./contracts";

const copilotHome = path.join(dataDirectory, "copilot");
export async function createClient() {
  const cwd = path.join(copilotHome, "empty-workspace");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: copilotHome,
    workingDirectory: cwd,
    env: runtimeEnvironment(),
    useLoggedInUser: true,
    sessionIdleTimeoutSeconds: 300,
    logLevel: "error",
  });
  try { await deadline(client.start(), 30_000); }
  catch (error) {
    await closeClient(client);
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
    const client = await createClient();
    try {
      const auth = await deadline(client.getAuthStatus(), 15_000);
      if (!auth.isAuthenticated) throw new AppError(503, "No usable Copilot sign-in was found in this app's isolated runtime. Run npm run copilot:login on this machine, then refresh the connection.");
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
export function safeSessionConfig(model: string, directory: string, sessionId: string, tools: Tool[] = [], toolInstruction?: string): SessionConfig {
  const allowed = new Set(tools.map(tool => tool.name));
  return {
    sessionId,
    model,
    clientName: "Model Chat",
    // Only app-defined tools are allow-listed; built-in, MCP and every other custom tool stays excluded.
    availableTools: tools.map(tool => `custom:${tool.name}`),
    excludedTools: tools.length ? ["builtin:*", "mcp:*"] : ["builtin:*", "mcp:*", "custom:*"],
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
    systemMessage: { mode: "replace", content: systemInstruction(tools.length ? toolInstruction : undefined) },
    onPermissionRequest: request => request.kind === "custom-tool" && allowed.has(request.toolName)
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
}
export type ReplyRunner = (input: ReplyInput) => Promise<void>;
export function verifyToolMetadata(tools: { name: string; mcpServerName?: string; deferLoading?: boolean }[] | null | undefined, expected: string[]) {
  const names = (tools || []).map(tool => tool.name).sort();
  if (!tools || names.join("\n") !== [...expected].sort().join("\n") || tools.some(tool => tool.mcpServerName || tool.deferLoading)) {
    throw new AppError(503, expected.length
      ? "The runtime did not confirm that only the app's sandboxed code tool is active. Generation was blocked for safety."
      : "The runtime did not confirm a tool-free session. Generation was blocked for safety.");
  }
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
export const runCopilotReply: ReplyRunner = async ({ model, prompt, signal, onDelta, onReplace, images, authorize, onRequestStart, tools = [], toolInstruction }) => {
  onRequestStart?.();
  const sessionId = `modelchat-${randomUUID()}`;
  const directory = path.join(copilotHome, "requests", sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let client: CopilotClient | undefined;
  let session: CopilotSession | undefined;
  let abortListener: (() => void) | undefined;
  const unsubscribe: (() => void)[] = [];
  try {
    signal.throwIfAborted();
    authorize?.();
    client = await createClient();
    signal.throwIfAborted();
    session = await deadline(client.createSession(safeSessionConfig(model, directory, sessionId, tools, toolInstruction)), 30_000);
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
    let sessionError: string | undefined;
    unsubscribe.push(session.on("session.error", event => { sessionError = event.data.message; }));
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
    await Promise.race([session.sendAndWait({ prompt, attachments: images }, tools.length ? 45 * 60_000 : 180_000), aborted]);
    if (sessionError) throw new Error(sessionError);
  } catch (error) {
    if (signal.aborted) throw new DOMException("Reply cancelled", "AbortError");
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
