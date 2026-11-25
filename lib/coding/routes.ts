import { z } from "zod";
import type { Store } from "../store";
import type { AccessContext, AccessService } from "../access";
import { AppError } from "../errors";
import { readJson } from "../http";
import { LIMITS, MESSAGE_BODY_BYTES } from "../contracts";
import { listModels, replyReasoningEffort, type ReplyRunner } from "../copilot";
import { THINKING_LEVELS } from "../thinking";
import { createChatStream, type StreamSecurity } from "../stream";
import { codingStatus, requireCoding } from "./access";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { SCREENSHOT_NAME, codingRunner, decideApproval, disposeCodeSession, listProcesses, stopProcess } from "./agent";
import { createProject, isBlockedPath, isInside, listProjects, validateProjectPath } from "./paths";
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
    const { name, template } = await readJson(request, z.object({ name: z.string().min(1).max(64), template: z.enum(["empty", "ios"]).default("empty") }).strict());
    const full = createProject(name, template);
    audit("code.project.create", null, `${template === "ios" ? "iOS app " : ""}${full}`);
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
    if (s.length === 5 && s[3] === "screenshots" && method === "GET") return screenshot(chat.projectPath!, decodeURIComponent(s[4]));
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

// A screenshot a command saved under the project's .modelchat/screenshots folder: only real images, only from there.
export function screenshot(project: string, name: string) {
  const missing = () => new AppError(404, "Screenshot not found.");
  if (!SCREENSHOT_NAME.test(name)) throw missing();
  let file: string;
  try { file = realpathSync.native(path.join(project, ".modelchat", "screenshots", name)); } catch { throw missing(); }
  if (!isInside(file, realpathSync.native(project)) || isBlockedPath(file)) throw missing();
  const info = statSync(file);
  if (!info.isFile() || info.size > 25 * 1024 * 1024) throw missing();
  const bytes = readFileSync(file);
  const head = bytes.subarray(0, 12);
  const type = head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG" ? "image/png"
    : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? "image/jpeg"
    : head.subarray(0, 4).toString("latin1") === "GIF8" ? "image/gif"
    : head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp" : null;
  if (!type) throw new AppError(415, "That file isn't a PNG, JPEG, GIF or WebP image.");
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": type, "Content-Length": String(bytes.length), "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", "Content-Disposition": `inline; filename="${name}"`,
  } });
}

/** A message in a coding chat: the same streamed reply and saved history as chat, run by the owner's coding session. */
export async function handleCodeMessage(request: Request, ctx: AccessContext, guard: AccessService, store: Store, chatId: string, securityFor: (editOf?: string) => StreamSecurity, plain: StreamSecurity) {
  const user = ctx.subject;
  requireCoding(request, ctx, guard, "code.message");
  const body = await readJson(request, z.object({
    content: z.string().trim().min(1, "Write a message first.").max(LIMITS.inputCharacters),
    model: z.string().min(1).max(128),
    thinking: z.enum(THINKING_LEVELS).optional(),
    fileIds: z.array(z.uuid()).max(0, "Coding chats work on the project folder. Put files in the project instead of attaching them.").default([]),
    editOf: z.uuid().optional(),
    keepFileIds: z.array(z.uuid()).max(0).default([]),
  }).strict(), MESSAGE_BODY_BYTES);
  store.assertIdle(user.id, chatId);
  const chat = store.chat(user.id, chatId);
  const model = (await listModels()).find(item => item.id === body.model);
  if (!model) throw new AppError(400, "That model is no longer available. Refresh the model list and select another.");
  const base = body.editOf ? store.editBase(user.id, chatId, body.editOf) : undefined;
  const history = store.messages(user.id, chatId, base ? base.parentId : undefined).filter(message => message.content).map(message => ({ role: message.role, content: message.content }));
  // The coding session remembers the turns it ran; an edit starts a fresh one that gets this branch's recap instead. Files stay as they are.
  if (base) await disposeCodeChat(chatId);
  const runner = codingRunner({ store, chat, ownerId: user.id, history, audit: (action, objectId, outcome, reason) => guard.record(ctx, action, objectId, outcome, reason, true) });
  const effort = replyReasoningEffort(model, body.thinking);
  const wrapped: ReplyRunner = input => runner({ ...input, reasoningEffort: effort });
  const security = base ? securityFor(body.editOf) : plain;
  // Coding access is re-checked throughout the turn: losing the superuser role or the local browser stops it.
  const codingSecurity: StreamSecurity = { ...security, check: () => {
    security.check();
    if (!codingStatus(request, ctx, guard).available) throw new AppError(403, "Coding access ended.");
  } };
  return createChatStream(store, user.id, chatId, body.content, body.model, [], body.content, wrapped, request.signal, codingSecurity, undefined, { thinking: effort ?? null, ...(base ? { edit: { editOf: body.editOf! } } : {}) });
}
