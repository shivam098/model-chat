import { CopilotClient, type SessionConfig, type CopilotSession, type ModelInfo } from "@github/copilot-sdk";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDirectory } from "./config";
import { AppError } from "./errors";
import { SYSTEM_INSTRUCTION } from "./context";
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
export async function listModels(refresh = false): Promise<ModelInfo[]> {
  if (!refresh && catalogState.modelChatCatalog && Date.now() - catalogState.modelChatCatalog.at < 60_000) return catalogState.modelChatCatalog.models;
  if (catalogState.modelChatCatalogPending) return catalogState.modelChatCatalogPending;
  catalogState.modelChatCatalogPending = (async () => {
    const client = await createClient();
    try {
      const auth = await deadline(client.getAuthStatus(), 15_000);
      if (!auth.isAuthenticated) throw new AppError(503, "No usable Copilot sign-in was found in this app's isolated runtime. Run npm run copilot:login on this machine, then refresh the connection.");
      const models = (await deadline(client.listModels(), 30_000)).filter(m => m.policy?.state !== "disabled");
      if (!models.length) throw new AppError(503, "Your Copilot account did not return any usable models. Check your subscription and organization policy.");
      catalogState.modelChatCatalog = { models, at: Date.now() };
      return models;
    } finally { await closeClient(client); }
  })().catch(error => { throw copilotError(error); }).finally(() => { catalogState.modelChatCatalogPending = undefined; });
  return catalogState.modelChatCatalogPending;
}
export function safeSessionConfig(model: string, directory: string, sessionId: string): SessionConfig {
  return {
    sessionId,
    model,
    clientName: "Model Chat",
    availableTools: [],
    excludedTools: ["builtin:*", "mcp:*", "custom:*"],
    tools: [],
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
    systemMessage: { mode: "replace", content: SYSTEM_INSTRUCTION },
    onPermissionRequest: () => ({ kind: "reject", feedback: "Model Chat is data-only. All tool and filesystem operations are denied." }),
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
}
export type ReplyRunner = (input: ReplyInput) => Promise<void>;
export const runCopilotReply: ReplyRunner = async ({ model, prompt, signal, onDelta, onReplace, images, authorize }) => {
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
    session = await deadline(client.createSession(safeSessionConfig(model, directory, sessionId)), 30_000);
    signal.throwIfAborted();
    await deadline(session.rpc.tools.initializeAndValidate(), 15_000);
    const metadata = await deadline(session.rpc.tools.getCurrentMetadata(), 15_000);
    if (!metadata.tools || metadata.tools.length !== 0) throw new AppError(503, "The runtime did not confirm a tool-free session. Generation was blocked for safety.");
    signal.throwIfAborted();
    authorize?.();
    unsubscribe.push(session.on("assistant.message_delta", event => onDelta(event.data.deltaContent)));
    unsubscribe.push(session.on("assistant.message", event => onReplace(event.data.content)));
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
    await Promise.race([session.sendAndWait({ prompt, attachments: images }, 180_000), aborted]);
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
