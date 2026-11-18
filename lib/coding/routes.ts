import { z } from "zod";
import type { Store } from "../store";
import type { AccessContext, AccessService } from "../access";
import { AppError } from "../errors";
import { readJson } from "../http";
import { LIMITS } from "../contracts";
import { listModels, replyReasoningEffort, type ReplyRunner } from "../copilot";
import { createChatStream, type StreamSecurity } from "../stream";
import { codingStatus, requireCoding } from "./access";
import { codingRunner, decideApproval, disposeCodeSession, listProcesses, stopProcess } from "./agent";
import { createProject, listProjects, validateProjectPath } from "./paths";
import { createPreview, revokePreviews } from "./preview";

const appPort = () => Number(process.env.PORT || 3210);

/** Handles /api/code/*. Status is open to any signed-in account (it says why coding is unavailable); everything else requires coding access. */
export async function handleCodeApi(request: Request, s: string[], ctx: AccessContext, guard: AccessService, store: Store): Promise<Response> {
  const method = request.method;
  const user = ctx.subject;
  if (s.length === 2 && s[1] === "status" && method === "GET") return Response.json(codingStatus(request, ctx, guard));
  const action = `code.${s[1] || "request"}`;
  requireCoding(request, ctx, guard, action);
  const audit = (name: string, objectId: string | null, reason: string | null) => guard.record(ctx, name, objectId, "allowed", reason, true);
  if (s.length === 2 && s[1] === "projects" && method === "GET") return Response.json(listProjects());
  if (s.length === 2 && s[1] === "projects" && method === "POST") {
    const { name } = await readJson(request, z.object({ name: z.string().min(1).max(64) }).strict());
    const full = createProject(name);
    audit("code.project.create", null, full);
    return Response.json({ path: full }, { status: 201 });
  }
  if (s.length === 2 && s[1] === "chats" && method === "POST") {
    const { projectPath } = await readJson(request, z.object({ projectPath: z.string().min(1).max(1024) }).strict());
    const full = validateProjectPath(projectPath);
    const chat = store.createChat(user.id, { projectPath: full });
    audit("code.chat.create", chat.id, full);
    return Response.json({ chat }, { status: 201 });
  }
  if (s.length === 3 && s[1] === "approvals" && method === "POST") {
    const { decision } = await readJson(request, z.object({ decision: z.enum(["once", "session", "deny"]) }).strict());
    return Response.json(decideApproval(user.id, s[2], decision));
  }
  if (s[1] === "chats" && s.length >= 4) {
    const chatId = s[2];
    if (!z.uuid().safeParse(chatId).success) throw new AppError(404, "Chat not found.");
    const chat = store.chat(user.id, chatId);
    if (chat.mode !== "code") throw new AppError(404, "Not a coding chat.");
    if (s.length === 4 && s[3] === "processes" && method === "GET") return Response.json({ processes: await listProcesses(chatId, user.id) });
    if (s.length === 6 && s[3] === "processes" && s[5] === "stop" && method === "POST") {
      const result = await stopProcess(chatId, user.id, s[4]);
      audit("code.process.stop", chatId, s[4]);
      return Response.json(result);
    }
    if (s.length === 4 && s[3] === "previews" && method === "POST") {
      const { port } = await readJson(request, z.object({ port: z.number().int() }).strict());
      const preview = await createPreview(chatId, user.id, port, appPort());
      audit("code.preview", chatId, `port ${port}`);
      return Response.json(preview);
    }
  }
  throw new AppError(404, "Endpoint not found.");
}

export async function disposeCodeChat(chatId: string) {
  revokePreviews(chatId);
  await disposeCodeSession(chatId);
}

/** A message in a coding chat: the same streamed reply and saved history as chat, run by the owner's coding session. */
export async function handleCodeMessage(request: Request, ctx: AccessContext, guard: AccessService, store: Store, chatId: string, security: StreamSecurity) {
  const user = ctx.subject;
  requireCoding(request, ctx, guard, "code.message");
  const body = await readJson(request, z.object({
    content: z.string().trim().min(1, "Write a message first.").max(LIMITS.inputCharacters),
    model: z.string().min(1).max(128),
    fileIds: z.array(z.uuid()).max(0, "Coding chats work on the project folder. Put files in the project instead of attaching them.").default([]),
  }).strict());
  store.assertIdle(user.id, chatId);
  const chat = store.chat(user.id, chatId);
  const model = (await listModels()).find(item => item.id === body.model);
  if (!model) throw new AppError(400, "That model is no longer available. Refresh the model list and select another.");
  const history = store.messages(user.id, chatId).filter(message => message.content).map(message => ({ role: message.role, content: message.content }));
  const runner = codingRunner({ store, chat, ownerId: user.id, history, audit: (action, objectId, outcome, reason) => guard.record(ctx, action, objectId, outcome, reason, true) });
  const effort = replyReasoningEffort(model);
  const wrapped: ReplyRunner = input => runner({ ...input, reasoningEffort: effort });
  // Coding access is re-checked throughout the turn: losing the superuser role or the local browser stops it.
  const codingSecurity: StreamSecurity = { ...security, check: () => {
    security.check();
    if (!codingStatus(request, ctx, guard).available) throw new AppError(403, "Coding access ended.");
  } };
  return createChatStream(store, user.id, chatId, body.content, body.model, [], body.content, wrapped, request.signal, codingSecurity, undefined, { idleMs: 30 * 60_000 });
}
