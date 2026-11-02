import { spawnSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import env from "@next/env";
import { z } from "zod";

env.loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--email" || args[2] !== "--role") {
  throw new Error("Usage: npm run admin:role -- --email existing@example.com --role superuser|user");
}
const email = z.string().trim().email().parse(args[1]).toLowerCase();
const role = z.enum(["user", "superuser"]).parse(args[3]);
const directory = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const db = new Database(path.join(directory, "model-chat.db"), { readonly: true });
try {
  const count = db.prepare("SELECT count(*) AS count FROM user WHERE lower(trim(email))=?").get(email) as { count: number };
  if (count.count !== 1) throw new Error("Exactly one existing account must match. No account or reserved email was created.");
} finally { db.close(); }
const backup = spawnSync(process.execPath, ["scripts/backup-db.mjs"], { stdio: "inherit" });
if (backup.error || backup.status !== 0) throw new Error("The consistent backup failed; no role change was attempted.");
const { getAuth } = await import("../lib/auth");
const { getStore } = await import("../lib/store");
const { AccessService } = await import("../lib/access");
await getAuth();
const result = new AccessService(getStore()).setRoleLocally(email, role);
console.log(JSON.stringify({ account: result.email, role: result.appRole, passwordAndHistoryUnchanged: true }));
getStore().db.close();
