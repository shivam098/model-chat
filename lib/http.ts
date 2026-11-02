import { z } from "zod";
import { getAuth } from "./auth";
import { origin } from "./config";
import { AppError } from "./errors";
import { AccessService } from "./access";
import { getStore } from "./store";

export function assertLocalRequest(request: Request) {
  const expected = new URL(origin);
  if (request.headers.get("host") !== expected.host) throw new AppError(403, "Use the app's exact configured URL.");
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && requestOrigin !== origin) throw new AppError(403, "Cross-origin requests are not allowed.");
  if (!["GET", "HEAD"].includes(request.method) && requestOrigin !== origin) throw new AppError(403, "A same-origin request is required.");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError(403, "Cross-site requests are not allowed.");
}
export async function requireUser(request: Request) {
  return (await requireAccess(request)).subject;
}
export async function requireAccess(request: Request, recover = false) {
  assertLocalRequest(request);
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!session) throw new AppError(401, "Please sign in again.");
  const service = new AccessService(getStore());
  const access = service.resolve(session.user.id, session.session.id, recover);
  service.assertExpectedSubject(access, recover ? null : request.headers.get("x-model-chat-subject"));
  return access;
}
export async function readBytes(request: Request, maximum: number) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maximum) throw new AppError(413, `Request exceeds the ${Math.round(maximum / 1024)} KB limit.`);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maximum) {
        await reader.cancel();
        throw new AppError(413, `Request exceeds the ${Math.round(maximum / 1024)} KB limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function readJson<T>(request: Request, schema: z.ZodType<T>, maximum = 64 * 1024): Promise<T> {
  const bytes = await readBytes(request, maximum);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new AppError(400, "Send valid JSON."); }
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, result.error.issues[0]?.message || "Invalid request.");
  return result.data;
}
