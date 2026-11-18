// Owner-only switch for coding mode over the shared link. Run on the computer hosting Model Chat:
//   npm run code:remote -- status | on --yes | off
// Remote coding also needs two-step verification on the superuser account and a sign-in that used it.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import env from "@next/env";

env.loadEnvConfig(process.cwd());
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const file = path.join(data, "coding-remote.json");
const [command, ...flags] = process.argv.slice(2);
const current = () => { try { return JSON.parse(readFileSync(file, "utf8")).enabled === true; } catch { return false; } };

function superusers() {
  const database = path.join(data, "model-chat.db");
  if (!existsSync(database)) return [];
  const db = new Database(database, { readonly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(user)").all().map(column => column.name);
    const twoFactor = columns.includes("twoFactorEnabled") ? "coalesce(twoFactorEnabled,0)" : "0";
    return db.prepare(`SELECT email, ${twoFactor} AS twoFactor FROM user WHERE appRole='superuser'`).all();
  } finally { db.close(); }
}
function audit(action) {
  const database = path.join(data, "model-chat.db");
  if (!existsSync(database)) return;
  const db = new Database(database);
  try { db.prepare("INSERT INTO app_audit(at,actorId,subjectId,action,objectId,outcome,reason,delegationId) VALUES (?,?,?,?,?,?,?,?)").run(Date.now(), null, null, action, null, "allowed", "owner command on the host", null); }
  catch { /* The audit table appears with the app's first start. */ }
  finally { db.close(); }
}
function save(enabled) {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ enabled, changedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  audit(enabled ? "code.remote.on" : "code.remote.off");
}

if (command === "status" || !command) {
  const owners = superusers();
  console.log(JSON.stringify({ remoteCoding: current() ? "on" : "off", superusers: owners.map(owner => ({ account: owner.email, twoStepVerification: owner.twoFactor ? "on" : "off" })) }, null, 2));
} else if (command === "off") {
  save(false);
  console.log("Remote coding is off. Coding mode works only in a browser on this computer.");
} else if (command === "on") {
  if (!flags.includes("--yes")) {
    console.error([
      "Remote coding lets the superuser run commands and change files on this computer from anywhere the shared link reaches.",
      "Use it only on a computer you own (for example your own Mac), never on a managed work PC.",
      "If that's what you want, run: npm run code:remote -- on --yes",
    ].join("\n"));
    process.exit(1);
  }
  const owners = superusers();
  if (!owners.length || !owners.every(owner => owner.twoFactor)) {
    console.error("Turn on two-step verification for the superuser account first: open Model Chat in this computer's browser, then Account & connection > Two-step verification.");
    process.exit(1);
  }
  save(true);
  console.log("Remote coding is on. Through the link it still needs the superuser to sign in with a two-step verification code. Turn it off with: npm run code:remote -- off");
} else {
  console.error("Usage: npm run code:remote -- status | on --yes | off");
  process.exit(1);
}
