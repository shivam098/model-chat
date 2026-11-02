import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import env from "@next/env";

env.loadEnvConfig(process.cwd());
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
const database = path.join(data, "model-chat.db");
const quote = name => `"${name.replaceAll('"', '""')}"`;
function fingerprint(db, table, columns) {
  const hash = createHash("sha256");
  let count = 0;
  for (const row of db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)} ORDER BY rowid`).raw().iterate()) {
    const serialized = JSON.stringify(row);
    hash.update(String(Buffer.byteLength(serialized))).update(":").update(serialized);
    count++;
  }
  return { count, sha256: hash.digest("hex") };
}
const verify = process.argv.indexOf("--verify");
if (verify >= 0) {
  const manifest = JSON.parse(readFileSync(process.argv[verify + 1], "utf8"));
  const db = new Database(database, { readonly: true });
  try {
    let matches = true;
    for (const table of manifest.tables) {
      const current = fingerprint(db, table.name, table.columns);
      const match = current.count === table.count && current.sha256 === table.sha256;
      matches &&= match;
      console.log(JSON.stringify({ table: table.name, rows: current.count, preserved: match }));
    }
    if (!matches) process.exitCode = 1;
  } finally { db.close(); }
} else {
  const directory = path.join(data, "backups", `superuser-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backupPath = path.join(directory, "model-chat.sqlite");
  const live = new Database(database, { readonly: true });
  try { await live.backup(backupPath); } finally { live.close(); }
  const snapshot = new Database(backupPath);
  try {
    snapshot.pragma("journal_mode = DELETE");
    const tables = snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => {
      const columns = snapshot.pragma(`table_info(${quote(name)})`).map(column => column.name);
      return { name, columns, ...fingerprint(snapshot, name, columns) };
    });
    const manifestPath = path.join(directory, "preservation.json");
    writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), backupPath, tables }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ backupPath, manifestPath, tables: tables.map(table => ({ name: table.name, rows: table.count })) }, null, 2));
  } finally { snapshot.close(); chmodSync(backupPath, 0o600); }
}
