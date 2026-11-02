import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { AccessService, type AccessContext } from "@/lib/access";
import { AppError, errorResponse } from "@/lib/errors";
import { assertLocalRequest, readBytes, readJson, requireAccess } from "@/lib/http";
import { LIMITS, isMediaExtension, uploadByteLimit } from "@/lib/contracts";
import { extractFile, validateFileName } from "@/lib/files";
import { listModels, runCopilotReply } from "@/lib/copilot";
import { buildPrompt } from "@/lib/context";
import { createChatStream, stopReply, stopSessionReplies, hasSessionReply } from "@/lib/stream";
import { tunnelMode } from "@/lib/config";
import { signupSchema } from "@/lib/signup";
import { DEMO_IDS } from "@/lib/demos";
import { createDemoChat } from "@/lib/demo-storage";
import { nativeImages } from "@/lib/native-images";
import { mediaStatus, processMedia, type MediaFrame } from "@/lib/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const parsingState = globalThis as typeof globalThis & { modelChatParsing?: Set<string> };
const parsing = parsingState.modelChatParsing ||= new Set();
const mediaState = globalThis as typeof globalThis & { modelChatMediaBusy?: boolean };
type RouteContext = { params: Promise<{ segments: string[] }> };
const accountId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const draftSchema = z.object({
  chatId: z.uuid().optional(), draft: z.string().max(LIMITS.inputCharacters), model: z.string().max(128).optional(),
}).strict();
const pagination = z.coerce.number().int().min(0).max(100_000);

async function handle(request: Request, routeContext: RouteContext): Promise<Response> {
  let access: AccessContext | null = null;
  let security: AccessService | undefined;
  let category = "request";
  try {
    assertLocalRequest(request);
    const { segments: s } = await routeContext.params;
    const method = request.method;
    category = s[0] === "admin" ? "admin.request" : s[0] === "auth" ? "account.request" : "workspace.request";
    if (s.length === 1 && s[0] === "health" && method === "GET") return Response.json({ ok: true });
    if (s.length === 1 && s[0] === "access" && method === "GET") return Response.json({ registrationAllowed: true, tunnelMode });
    const store = getStore();
    security = new AccessService(store);
    if (s[0] === "auth") {
      const endpoint = s.slice(1).join("/");
      const auth = await getAuth();
      const session = await auth.api.getSession({ headers: request.headers });
      if (session) access = security.resolve(session.user.id, session.session.id, endpoint === "sign-out");
      if (access?.delegationId && !["sign-out", "get-session"].includes(endpoint)) {
        security.record(access, "account.security", null, "denied", "acting_security_change", true);
        throw new AppError(403, "Return to your own workspace before changing authentication.");
      }
      if (!((method === "POST" && ["sign-up/email", "sign-in/email", "sign-out"].includes(endpoint)) ||
          (method === "GET" && endpoint === "get-session"))) throw new AppError(404, "Endpoint not found.");
      if (method === "POST") {
        const body = endpoint === "sign-up/email"
          ? JSON.stringify(await readJson(request, signupSchema, 16 * 1024))
          : (await readBytes(request, 16 * 1024)).toString("utf8");
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        request = new Request(request.url, { method, headers, body });
      }
      const response = await auth.handler(request);
      if (response.ok && session && endpoint === "sign-out") {
        if (access?.delegationId) security.record(access, "acting.stop", access.subject.id, "allowed", "logout", true);
        security.logout(session.user.id, session.session.id);
        stopSessionReplies(session.session.id);
      }
      return response;
    }
    access = await requireAccess(request, s.length === 1 && s[0] === "account");
    const ctx = access;
    const guard = security;
    const user = ctx.subject;
    const run = <T,>(action: string, id: string | null, operation: () => T, created?: (result: T) => string | null) => guard.run(ctx, action, id, operation, created);
    const saveDraft = (input: z.infer<typeof draftSchema>) => run("draft.save", input.chatId ?? null, () => {
      if (!input.chatId && !input.draft) return null;
      const chat = input.chatId ? store.chat(user.id, input.chatId) : store.createChat(user.id);
      store.saveDraft(user.id, chat.id, input.draft, input.model);
      return store.chat(user.id, chat.id);
    }, chat => chat?.id ?? null);
    if (s.length === 1 && s[0] === "account" && method === "GET") {
      return Response.json(run("workspace.account", user.id, () => guard.account(ctx)));
    }
    if (s.length === 1 && s[0] === "media-status" && method === "GET") {
      return Response.json(run("media.status", null, () => mediaStatus()));
    }
    if (s[0] === "admin") {
      if (s.length === 2 && s[1] === "acting" && method === "POST") {
        guard.requireAdmin(ctx);
        if (hasSessionReply(ctx.sessionId)) throw new AppError(409, "Stop the current reply before switching users.");
        const input = await readJson(request, z.object({ userId: accountId, chatId: z.uuid().optional(), previous: draftSchema.optional() }).strict());
        return Response.json(store.db.transaction(() => {
          guard.check(ctx);
          if (input.previous) saveDraft(input.previous);
          const next = guard.start(ctx, input.userId);
          if (input.chatId) store.chat(next.subject.id, input.chatId);
          return { ...guard.account(next), chatId: input.chatId ?? store.listChats(next.subject.id)[0]?.id ?? null };
        })());
      }
      if (s.length === 2 && s[1] === "stop" && method === "POST") {
        guard.requireAdmin(ctx, true);
        if (hasSessionReply(ctx.sessionId)) throw new AppError(409, "Stop the current reply before returning to your workspace.");
        const input = await readJson(request, z.object({ previous: draftSchema.optional() }).strict());
        return Response.json(store.db.transaction(() => {
          if (input.previous) saveDraft(input.previous);
          const next = guard.stop(ctx);
          return { ...guard.account(next), chatId: store.listChats(next.subject.id)[0]?.id ?? null };
        })());
      }
      guard.requireAdmin(ctx);
      const params = new URL(request.url).searchParams;
      const search = z.string().max(100).parse(params.get("q") || "");
      const offset = pagination.parse(params.get("offset") || 0);
      if (s.length === 2 && s[1] === "users" && method === "GET") return Response.json(guard.users(ctx, search, offset));
      if (s.length === 4 && s[1] === "users" && s[3] === "chats" && method === "GET") return Response.json(guard.userChats(ctx, accountId.parse(s[2]), search, offset));
      if (s.length === 2 && s[1] === "audit" && method === "GET") {
        const before = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(params.get("before") || Number.MAX_SAFE_INTEGER);
        return Response.json(guard.audit(ctx, before));
      }
      throw new AppError(404, "Admin endpoint not found.");
    }
    if (s.length === 1 && s[0] === "drafts" && method === "POST") return Response.json({ chat: saveDraft(await readJson(request, draftSchema)) });
    if (s.length === 1 && s[0] === "demos" && method === "POST") {
      const input = await readJson(request, z.object({
        demoId: z.enum(DEMO_IDS),
        previous: z.object({ chatId: z.uuid().optional(), draft: z.string().max(LIMITS.inputCharacters) }).strict().optional(),
      }).strict());
      return Response.json(run("demo.create", null, () => createDemoChat(store, user.id, input.demoId, input.previous), result => result.detail.chat.id), { status: 201 });
    }
    if (s.length === 1 && s[0] === "models" && method === "GET") {
      const models = await listModels(new URL(request.url).searchParams.get("refresh") === "1");
      return Response.json(run("models.list", null, () => ({ models: models.map(m => ({ id: m.id, name: m.name, multiplier: m.billing?.multiplier, vision: Boolean(m.capabilities.supports.vision && m.capabilities.limits.vision) })), authenticated: true })));
    }
    if (s[0] !== "chats") throw new AppError(404, "Endpoint not found.");
    if (s.length === 1) {
      if (method === "GET") return Response.json({ chats: run("chat.list", user.id, () => store.listChats(user.id)) });
      if (method === "POST") return Response.json({ chat: run("chat.create", null, () => store.createChat(user.id), chat => chat.id) }, { status: 201 });
    }
    const chatId = s[1];
    if (!chatId || !z.uuid().safeParse(chatId).success) throw new AppError(404, "Chat not found.");
    const chat = store.chat(user.id, chatId);
    if (s.length === 2) {
      if (method === "GET") return Response.json(run("chat.read", chatId, () => ({ chat, messages: store.messages(user.id, chatId), attachments: store.attachments(user.id, chatId) })));
      if (method === "PATCH") {
        const { title } = await readJson(request, z.object({ title: z.string().trim().min(1).max(80) }).strict());
        return Response.json({ chat: run("chat.rename", chatId, () => store.renameChat(user.id, chatId, title)) });
      }
      if (method === "DELETE") {
        run("chat.delete", chatId, () => store.deleteChat(user.id, chatId));
        return Response.json({ ok: true });
      }
    }
    if (s.length === 3 && s[2] === "stop" && method === "POST") {
      run("message.stop", chatId, () => stopReply(store, user.id, chatId));
      return Response.json({ ok: true });
    }
    if (s.length === 3 && s[2] === "messages" && method === "POST") {
      const body = await readJson(request, z.object({
        content: z.string().trim().min(1, "Write a message first.").max(LIMITS.inputCharacters),
        model: z.string().min(1).max(128),
        fileIds: z.array(z.uuid()).max(LIMITS.filesPerMessage).default([]),
      }).strict());
      if (new Set(body.fileIds).size !== body.fileIds.length) throw new AppError(400, "Repeated file IDs are not allowed.");
      store.assertIdle(user.id, chatId);
      const files = store.contextFiles(user.id, chatId, body.fileIds);
      const models = await listModels();
      guard.check(ctx);
      const model = models.find(m => m.id === body.model);
      if (!model) throw new AppError(400, "That model is no longer available. Refresh the model list and select another.");
      const images = nativeImages(store.contextImages(user.id, chatId, body.fileIds), model);
      const prompt = buildPrompt(store.messages(user.id, chatId), files, body.content,
        (model.capabilities.limits.max_prompt_tokens ?? model.capabilities.limits.max_context_window_tokens) - images.length * 4096);
      return createChatStream(store, user.id, chatId, body.content, body.model, body.fileIds, prompt, runCopilotReply, request.signal, {
        actorId: ctx.actor.id, sessionId: ctx.sessionId, check: () => { guard.check(ctx); },
        accepted: (userMessageId, assistantId) => {
          guard.record(ctx, "message.send", userMessageId, "allowed");
          guard.record(ctx, "message.begin", assistantId, "allowed");
        },
        finished: (messageId, status, lost) => guard.record(ctx, "message.finish", messageId, lost ? "denied" : status === "error" ? "error" : "allowed", lost ? "access_ended" : status),
      }, images);
    }
    if (s.length === 3 && s[2] === "files" && method === "POST") {
      store.assertIdle(user.id, chatId);
      if (parsing.size >= 2 || parsing.has(user.id)) throw new AppError(429, "Another file is being processed. Wait a moment and try again.");
      parsing.add(user.id);
      let media = false;
      let mediaSlot = false;
      try {
        let name: string;
        try { name = decodeURIComponent(request.headers.get("x-file-name") || ""); }
        catch { throw new AppError(400, "Invalid file name."); }
        const extension = validateFileName(name);
        media = isMediaExtension(extension);
        if (media && mediaState.modelChatMediaBusy) throw new AppError(429, "Another audio/video file is being processed. Wait for it to finish and try again.");
        if (media) { mediaState.modelChatMediaBusy = true; mediaSlot = true; }
        const bytes = await readBytes(request, uploadByteLimit(name));
        const result: { text: string; notes: string; mimeType?: string; frames?: MediaFrame[] } = media
          ? await processMedia(extension, bytes, request.signal, () => { guard.check(ctx); })
          : await extractFile(name, bytes);
        request.signal.throwIfAborted();
        const frames = result.frames ?? [];
        const attachment = run("file.upload", null, () => store.addFile(user.id, chatId, name, bytes, result.text, result.notes, result.mimeType, frames), file => file.id);
        return Response.json({ attachment }, { status: 201 });
      } finally { parsing.delete(user.id); if (mediaSlot) mediaState.modelChatMediaBusy = false; }
    }
    if (s.length === 4 && s[2] === "files") {
      const file = store.file(user.id, chatId, s[3]);
      if (method === "GET") return run("file.download", file.id, () => new Response(new Uint8Array(file.bytes), { headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}`,
        "Content-Length": String(file.size),
        "X-Content-Type-Options": "nosniff",
      } }));
      if (method === "DELETE") {
        run("file.delete", file.id, () => store.deleteFile(user.id, chatId, s[3]));
        return Response.json({ ok: true });
      }
    }
    if (s.length === 5 && s[2] === "files" && s[4] === "extracted" && method === "GET") {
      const file = store.fileText(user.id, chatId, s[3]);
      return Response.json(run("file.text.read", file.id, () => ({ name: file.name, text: file.text, notes: file.notes })));
    }
    throw new AppError(404, "Endpoint not found.");
  } catch (error) {
    if (security) {
      try { security.record(access, category, null, "denied", error instanceof AppError ? `http_${error.status}` : "invalid_request", category !== "workspace.request"); }
      catch (auditError) { return errorResponse(auditError); }
    }
    if (error instanceof z.ZodError) return errorResponse(new AppError(400, "Invalid request parameters."));
    return errorResponse(error);
  }
}
async function route(request: Request, context: RouteContext) {
  const response = await handle(request, context);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export { route as GET, route as POST, route as PATCH, route as DELETE };
