// Owner-only setting for web search in ordinary chats. Run on the computer hosting Model Chat:
//   npm run web:search -- status | owner | everyone --yes | off
// "owner" (the default) gives web search only to the superuser's own chats; "everyone" gives it to every account.
// It is never offered while the superuser acts as another user. Changes take effect on the next message.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import env from "@next/env";

env.loadEnvConfig(process.cwd());
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const file = path.join(data, "web-search.json");
const [command, ...flags] = process.argv.slice(2);
const current = () => {
  if (!existsSync(file)) return "owner";
  try { const scope = JSON.parse(readFileSync(file, "utf8")).scope; return ["everyone", "off"].includes(scope) ? scope : "owner"; } catch { return "off"; }
};
const describe = scope => ({
  owner: "only the superuser's own chats (default)",
  everyone: "every account's chats",
  off: "off for everyone",
})[scope];

function audit(scope) {
  const database = path.join(data, "model-chat.db");
  if (!existsSync(database)) return;
  const db = new Database(database);
  try { db.prepare("INSERT INTO app_audit(at,actorId,subjectId,action,objectId,outcome,reason,delegationId) VALUES (?,?,?,?,?,?,?,?)").run(Date.now(), null, null, "web.search.scope", null, "allowed", `${scope} (owner command on the host)`, null); }
  catch { /* The audit table appears with the app's first start. */ }
  finally { db.close(); }
}
function save(scope) {
  mkdirSync(data, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ scope, changedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  audit(scope);
  console.log(`Web search: ${describe(scope)}. It applies from the next message; it is never offered while acting as another user.`);
}

if (command === "status" || !command) {
  console.log(JSON.stringify({ webSearch: current(), meaning: describe(current()) }, null, 2));
} else if (command === "owner" || command === "off") {
  save(command);
} else if (command === "everyone") {
  if (!flags.includes("--yes")) {
    console.error([
      "This lets every account (signup is open) search the web. Searches run on GitHub's servers through the host owner's Copilot account and count toward its usage.",
      "If that's what you want, run: npm run web:search -- everyone --yes",
    ].join("\n"));
    process.exit(1);
  }
  save("everyone");
} else {
  console.error("Usage: npm run web:search -- status | owner | everyone --yes | off");
  process.exit(1);
}
