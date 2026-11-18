import { randomBytes } from "node:crypto";
import net from "node:net";
import { AppError } from "../errors";

export interface PreviewEntry { port: number; host: string; chatId: string; ownerId: string; expires: number }
const registry = globalThis as typeof globalThis & { modelChatPreviews?: Map<string, PreviewEntry> };
const previews: Map<string, PreviewEntry> = registry.modelChatPreviews ||= new Map();

function listening(host: string, port: number) {
  return new Promise<boolean>(resolve => {
    const socket = net.connect({ host, port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
/** Registers an owner-only preview of a dev server on this computer and returns its isolated preview origin. */
export async function createPreview(chatId: string, ownerId: string, port: number, appPort: number) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === appPort) throw new AppError(400, "Choose the dev server's port (1024–65535), not Model Chat's own port.");
  const host = (await listening("127.0.0.1", port)) ? "127.0.0.1" : (await listening("::1", port)) ? "::1" : null;
  if (!host) throw new AppError(409, `Nothing is listening on port ${port} yet. Start the app's dev server, then open the preview.`);
  for (const [token, entry] of previews) if (entry.chatId === chatId && entry.port === port) previews.delete(token);
  const token = randomBytes(24).toString("hex");
  previews.set(token, { port, host, chatId, ownerId, expires: Date.now() + 12 * 60 * 60_000 });
  return { url: `http://p-${token}.localhost:${appPort}/`, port };
}
export function revokePreviews(chatId: string) {
  for (const [token, entry] of previews) if (entry.chatId === chatId) previews.delete(token);
}
