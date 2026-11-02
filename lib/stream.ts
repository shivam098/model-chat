import type { Store } from "./store";
import { AppError } from "./errors";
import { copilotError, type ReplyRunner } from "./copilot";
import { LIMITS, type StreamEvent, type MessageStatus, type NativeImage } from "./contracts";

type ActiveReply = { userId: string; actorId: string; sessionId?: string; controller: AbortController };
export interface StreamSecurity {
  actorId: string;
  sessionId: string;
  check: () => void;
  accepted: (userMessageId: string, assistantMessageId: string) => void;
  finished: (messageId: string, status: MessageStatus, accessLost: boolean) => void;
}
const state = globalThis as typeof globalThis & { modelChatActive?: Map<string, ActiveReply> };
const active = state.modelChatActive ||= new Map();

export function stopReply(store: Store, userId: string, chatId: string) {
  store.chat(userId, chatId);
  const job = active.get(chatId);
  if (job?.userId === userId) job.controller.abort();
}
export function stopUserReplies(userId: string) {
  for (const job of active.values()) if (job.userId === userId) job.controller.abort();
}
export function hasSessionReply(sessionId: string) {
  return [...active.values()].some(job => job.sessionId === sessionId);
}
export function stopSessionReplies(sessionId: string) {
  for (const job of active.values()) if (job.sessionId === sessionId) job.controller.abort();
}
export function createChatStream(store: Store, userId: string, chatId: string, content: string, model: string, fileIds: string[], prompt: string, runner: ReplyRunner, requestSignal: AbortSignal, security?: StreamSecurity, images?: NativeImage[]) {
  if (active.has(chatId)) throw new AppError(409, "A reply is already running in this chat.");
  if (active.size >= 2 || [...active.values()].some(j => j.userId === userId || j.actorId === (security?.actorId ?? userId))) throw new AppError(429, "One reply per account or actor and two per app can run at once. Wait or stop the current reply.");
  const controller = new AbortController();
  const turn = store.db.transaction(() => {
    security?.check();
    const turn = store.beginTurn(userId, chatId, content, model, fileIds);
    security?.accepted(turn.user.id, turn.assistant.id);
    return turn;
  })();
  active.set(chatId, { userId, actorId: security?.actorId ?? userId, sessionId: security?.sessionId, controller });
  const requestAbort = () => controller.abort();
  requestSignal.addEventListener("abort", requestAbort, { once: true });
  if (requestSignal.aborted) controller.abort();
  const encoder = new TextEncoder();
  let connected = true;
  let accessLost = false;
  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      const send = (event: StreamEvent) => {
        if (!connected) return;
        try { sink.enqueue(encoder.encode(JSON.stringify(event) + "\n")); }
        catch { connected = false; controller.abort(); }
      };
      const checkAccess = () => {
        if (accessLost) return false;
        try { security?.check(); return true; }
        catch {
          accessLost = true;
          controller.abort();
          send({ type: "error", error: "Access to this workspace ended. The reply was stopped and any accepted partial text stays in its original chat." });
          return false;
        }
      };
      send({ type: "start", ...turn });
      void (async () => {
        let text = "";
        let lastSave = 0;
        let outputExceeded = false;
        let status: MessageStatus = "complete";
        let error: string | null = null;
        const accept = (value: string, replace: boolean) => {
          if (controller.signal.aborted || !checkAccess()) return;
          const next = replace ? value : text + value;
          if (next.length > LIMITS.outputCharacters) {
            outputExceeded = true;
            text = next.slice(0, LIMITS.outputCharacters);
            send({ type: "replace", text });
            controller.abort();
          } else {
            text = next;
            send(replace ? { type: "replace", text } : { type: "delta", text: value });
          }
          if (Date.now() - lastSave > 250) {
            store.saveReply(userId, chatId, turn.assistant.id, text, "streaming");
            lastSave = Date.now();
          }
        };
        const timeout = setTimeout(() => controller.abort(new Error("timeout")), 240_000);
        const authorizationTimer = security ? setInterval(checkAccess, 500) : undefined;
        try {
          await runner({ model, prompt, images, authorize: security?.check, signal: controller.signal, onDelta: text => accept(text, false), onReplace: text => accept(text, true) });
          if (controller.signal.aborted) throw new DOMException("Reply cancelled", "AbortError");
          if (!text.trim()) throw new AppError(503, "Copilot returned no text. The request was saved, but no answer was generated.");
        } catch (cause) {
          status = controller.signal.aborted ? "cancelled" : "error";
          if (outputExceeded) error = "Reply stopped at the 32,000-character output limit.";
          else if (controller.signal.reason instanceof Error && controller.signal.reason.message === "timeout") error = "The reply exceeded four minutes and was stopped.";
          else if (controller.signal.aborted) error = "Reply stopped. Any partial text is saved.";
          else error = copilotError(cause).message;
        } finally {
          clearTimeout(timeout);
          clearInterval(authorizationTimer);
          requestSignal.removeEventListener("abort", requestAbort);
          checkAccess();
          if (accessLost) { status = "cancelled"; error = "Reply stopped because the actor's access ended. Partial text remains in this chat."; }
          try {
            const message = store.saveReply(userId, chatId, turn.assistant.id, text, status, error);
            security?.finished(message.id, status, accessLost);
            if (!accessLost) send({ type: "done", message });
          } catch (saveError) {
            try { security?.finished(turn.assistant.id, "error", accessLost); }
            catch (auditError) { console.error("[model-chat] Reply audit failed:", auditError instanceof Error ? auditError.name : "Unknown"); }
            console.error("[model-chat] Could not save final reply:", saveError instanceof Error ? saveError.name : "Unknown");
            send({ type: "error", error: "The reply could not be saved. Reload this chat before continuing." });
          } finally {
            active.delete(chatId);
            if (connected) sink.close();
          }
        }
      })();
    },
    cancel() { connected = false; controller.abort(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  } });
}
