import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionRequest } from "@github/copilot-sdk";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { dataDirectory } from "../lib/config";
import { applyDecision, emptyAllowances, gate } from "../lib/coding/policy";
import { classifyPath, mentionsBlocked, validateProjectPath } from "../lib/coding/paths";
import { codingStatus, requireCoding } from "../lib/coding/access";
import { codingEnvironment, verifyCodingTools } from "../lib/coding/agent";

// macOS temp folders resolve under /private, which projects may not use.
const scratch = () => mkdtempSync(path.join(process.platform === "darwin" ? os.homedir() : os.tmpdir(), "model-chat-coding-test-"));
const shell = (command: string, extra: Partial<Record<string, unknown>> = {}) => ({
  kind: "shell", fullCommandText: command, intention: "test", commands: [{ identifier: command.split(" ")[0], readOnly: false }],
  possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true, ...extra,
}) as unknown as PermissionRequest;

test("coding approvals: commands ask first, session approvals stay in the app and blocked locations are refused", () => {
  const project = scratch();
  try {
    const allowances = emptyAllowances();
    const first = gate(shell("npm test"), project, allowances);
    assert.equal(first.action, "ask");
    if (first.action !== "ask") return;
    assert.equal(first.card.sessionScope, "npm commands in this project");
    // The runtime only ever gets one-time approvals, so every later request still reaches this policy.
    assert.equal(applyDecision(first.card, "session", allowances).kind, "approve-once");
    assert.equal(gate(shell("npm run build"), project, allowances).action, "approve");
    assert.equal(gate(shell("node server.js"), project, allowances).action, "ask", "A different command still asks");
    assert.equal(gate(shell("npm run x", { possiblePaths: [path.join(os.homedir(), "elsewhere")] }), project, allowances).action, "ask", "Paths outside the project always ask");
    assert.equal(gate(shell("npm run x", { requestSandboxBypass: true }), project, allowances).action, "ask");
    assert.deepEqual(applyDecision(first.card, "deny", allowances).kind, "reject");

    for (const command of ["type .env", "Get-Content $env:USERPROFILE\\.ssh\\id_ed25519", "echo $env:COPILOT_SDK_AUTH_TOKEN", "gh auth token", `type "${path.join(dataDirectory, "model-chat.db")}"`, "cat ~/.git-credentials"]) {
      assert.equal(mentionsBlocked(command), true, command);
      assert.equal(gate(shell(command), project, allowances).action, "reject", command);
    }
    assert.equal(mentionsBlocked("node -e \"console.log(1)\" && copy .env.example .env.sample"), false);
    for (const command of ["Start-Process node server.js", "start node server.js", "nohup npm run dev &", "npm run dev &", "$job = Start-Job { node x }", "setsid node x"]) {
      assert.equal(gate(shell(command), project, allowances).action, "reject", command);
    }
    for (const command of ["npm start", "npm run start", "Start-Sleep -Seconds 2; node test.js", "npm install && npm test", "node server.js"]) {
      assert.notEqual(gate(shell(command), project, allowances).action, "reject", command);
    }

    const write = (fileName: string) => ({ kind: "write", fileName, diff: "+x", intention: "edit", canOfferSessionApproval: true }) as unknown as PermissionRequest;
    const edit = gate(write(path.join(project, "src", "app.ts")), project, allowances);
    assert.equal(edit.action, "ask");
    if (edit.action === "ask") applyDecision(edit.card, "session", allowances);
    assert.equal(gate(write(path.join(project, "src", "other.ts")), project, allowances).action, "approve");
    assert.equal(gate(write(path.join(project, ".env")), project, allowances).action, "reject");
    assert.equal(gate(write(path.join(project, "..", "outside.txt")), project, allowances).action, "ask", "Writes outside the project still ask after a session approval");
    assert.equal(gate(write(path.join(dataDirectory, "x.txt")), project, allowances).action, "reject");

    const read = (file: string) => ({ kind: "read", path: file, intention: "read" }) as unknown as PermissionRequest;
    assert.equal(gate(read(path.join(project, "README.md")), project, allowances).action, "approve");
    assert.equal(gate(read(path.join(os.homedir(), "notes.txt")), project, allowances).action, "ask");
    assert.equal(gate(read(path.join(os.homedir(), ".ssh", "id_rsa")), project, allowances).action, "reject");
    assert.equal(gate({ kind: "mcp", toolName: "x" } as unknown as PermissionRequest, project, allowances).action, "reject");
    assert.equal(classifyPath("..\\..\\x", project), "outside");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("project folders exclude the app, its data, credentials and whole drives", () => {
  const project = scratch();
  try {
    assert.ok(validateProjectPath(project));
    mkdirSync(path.join(project, "inner"));
    assert.ok(validateProjectPath(path.join(project, "inner")));
    for (const bad of [process.cwd(), path.join(process.cwd(), "components"), dataDirectory, os.homedir(), path.parse(process.cwd()).root, path.join(os.homedir(), ".ssh"), "relative\\folder", path.join(project, "missing")]) {
      assert.throws(() => validateProjectPath(bad), Error, bad);
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("coding access: superuser only, never while acting, and local-only without remote coding turned on", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT,email TEXT,appRole TEXT DEFAULT 'user');
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT REFERENCES user(id) ON DELETE CASCADE,expiresAt TEXT);
    INSERT INTO user VALUES ('admin','Admin','admin@example.test','superuser'),('alice','Alice','alice@example.test','user');`);
  for (const [id, user] of [["admin-session", "admin"], ["alice-session", "alice"]]) db.prepare("INSERT INTO session VALUES (?,?,?)").run(id, user, new Date(Date.now() + 3600_000).toISOString());
  const access = new AccessService(new Store(db));
  const local = new Request("http://127.0.0.1:3210/api/code/status", { headers: { "x-model-chat-via": "local" } });
  try {
    const owner = access.resolve("admin", "admin-session");
    assert.equal(codingStatus(local, owner, access).available, true);
    const alice = access.resolve("alice", "alice-session");
    assert.equal(codingStatus(local, alice, access).available, false);
    assert.throws(() => requireCoding(local, alice, access, "code.projects"), /only to the superuser/);
    const acting = access.start(owner, "alice");
    assert.equal(codingStatus(local, acting, access).available, false);
    assert.throws(() => requireCoding(local, acting, access, "code.projects"), /never runs as another user/);
    const denied = db.prepare("SELECT action, outcome, reason FROM app_audit WHERE action='code.projects' ORDER BY id").all() as { outcome: string; reason: string }[];
    assert.deepEqual(denied.map(row => [row.outcome, row.reason]), [["denied", "not_superuser"], ["denied", "acting"]]);
  } finally { db.close(); }
});

test("coding shells never inherit tokens or the app's own settings, and the tool set is verified", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GH_TOKEN: "gho_example", COPILOT_SDK_AUTH_TOKEN: "x", BETTER_AUTH_SECRET: "s", MODEL_CHAT_COPILOT_LOGIN: "owner", OPENAI_API_KEY: "k", MY_SECRET: "v" });
    const environment = codingEnvironment();
    for (const name of ["GH_TOKEN", "COPILOT_SDK_AUTH_TOKEN", "BETTER_AUTH_SECRET", "MODEL_CHAT_COPILOT_LOGIN", "OPENAI_API_KEY", "MY_SECRET"]) assert.equal(environment[name], undefined, name);
    assert.ok(environment.PATH || environment.Path, "Normal tools stay on PATH");
    assert.ok(environment.GH_CONFIG_DIR && !environment.GH_CONFIG_DIR.includes(path.join("AppData", "Roaming", "GitHub CLI")), "gh can't reach the owner's stored login");
    assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  } finally { process.env = saved; }
  const shellName = process.platform === "win32" ? "powershell" : "bash";
  assert.doesNotThrow(() => verifyCodingTools([{ name: shellName }, { name: "apply_patch" }, { name: "view" }]));
  assert.throws(() => verifyCodingTools([{ name: shellName }, { name: "apply_patch" }, { name: "task" }]), /coding tool set/);
  assert.throws(() => verifyCodingTools([{ name: shellName }, { name: "apply_patch" }, { name: "search", mcpServerName: "x" } as { name: string }]), /coding tool set/);
  assert.throws(() => verifyCodingTools([{ name: "view" }]), /coding tool set/);
});
