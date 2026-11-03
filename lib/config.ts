import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { networkPolicy } from "./network-policy.mjs";

export const dataDirectory = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
for (const name of ["public", ".next", ".next-candidate"]) {
  const webDirectory = path.resolve(name);
  if (dataDirectory === webDirectory || dataDirectory.startsWith(webDirectory + path.sep)) {
    throw new Error("MODEL_CHAT_DATA_DIR must be outside public/ and build directories.");
  }
}
export const { origin, tunnelMode } = networkPolicy(process.env.PORT || 3210, process.env.MODEL_CHAT_TUNNEL_ORIGIN);
export function ensureDataDirectory() {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
}
export function authSecret() {
  if (process.env.BETTER_AUTH_SECRET) {
    if (process.env.BETTER_AUTH_SECRET.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
    return process.env.BETTER_AUTH_SECRET;
  }
  ensureDataDirectory();
  const file = path.join(dataDirectory, "auth-secret");
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(48).toString("base64url"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const secret = readFileSync(file, "utf8").trim();
  if (secret.length < 32) throw new Error("The saved auth secret is invalid. Restore it from your local backup.");
  return secret;
}
