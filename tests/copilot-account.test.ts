import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACCOUNT_UNAVAILABLE, expectedCopilotLogin, isolatedRuntimeEnvironment, selectStoredSignIn, verifyRuntimeIdentity } from "../lib/copilot-account";

const host = "https://github.com";
function rejectsWith(fn: () => unknown, detail: RegExp) {
  assert.throws(fn, (error: Error & { status?: number }) => {
    assert.equal(error.status, 503);
    assert.equal(error.message, ACCOUNT_UNAVAILABLE);
    assert.match((error.cause as Error).message, detail);
    return true;
  });
}

test("only the app's stored sign-in for the configured login is selected, never gh or environment credentials", () => {
  const accounts = [
    { authInfo: { type: "gh-cli", host, login: "work" }, token: "gh-token" },
    { authInfo: { type: "env", host, login: "work" }, token: "env-token" },
    { authInfo: { type: "user", host, login: "other" }, token: "other-token" },
    { authInfo: { type: "user", host, login: "Work" }, token: "stored-token" },
  ];
  assert.deepEqual(selectStoredSignIn(accounts, "work"), { login: "Work", token: "stored-token" });
  rejectsWith(() => selectStoredSignIn(accounts.slice(0, 3), "work"), /stored Copilot sign-in is for other, not the configured account work/);
  rejectsWith(() => selectStoredSignIn([{ authInfo: { type: "user", host, login: "work" } }], "work"), /no stored Copilot sign-in for work/);
});

test("the runtime must confirm the configured account before use", () => {
  assert.equal(verifyRuntimeIdentity({ authInfo: { type: "token", copilotUser: { login: "work" } } }, "WORK"), "work");
  rejectsWith(() => verifyRuntimeIdentity({ authInfo: { type: "gh-cli", copilotUser: { login: "work" } } }, "work"), /runtime reported gh-cli/);
  rejectsWith(() => verifyRuntimeIdentity({ authInfo: { type: "token", copilotUser: { login: "other" } } }, "work"), /belongs to other, not the configured account work/);
  rejectsWith(() => verifyRuntimeIdentity({}, "work"), /runtime reported no authentication/);
});

test("the configured login comes from MODEL_CHAT_COPILOT_LOGIN, else the app's own sign-in, never gh", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "model-chat-account-"));
  try {
    rejectsWith(() => expectedCopilotLogin(home, {}), /No Copilot account is set up/);
    writeFileSync(path.join(home, "config.json"), `// comment written by the CLI\n${JSON.stringify({ lastLoggedInUser: { host, login: "stored_user" } })}`);
    assert.equal(expectedCopilotLogin(home, {}).login, "stored_user");
    assert.deepEqual(expectedCopilotLogin(home, { MODEL_CHAT_COPILOT_LOGIN: " pinned " }), { login: "pinned", source: "MODEL_CHAT_COPILOT_LOGIN" });
    rejectsWith(() => expectedCopilotLogin(home, { MODEL_CHAT_COPILOT_LOGIN: "bad login" }), /not a valid GitHub login/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the runtime gets an empty app-owned GitHub CLI config and no ambient tokens", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "model-chat-account-"));
  const saved = { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, GH_TOKEN: process.env.GH_TOKEN };
  try {
    process.env.GH_CONFIG_DIR = path.join(home, "real-gh");
    process.env.GH_TOKEN = "ambient";
    const environment = isolatedRuntimeEnvironment(home);
    assert.equal(environment.GH_CONFIG_DIR, path.join(home, "gh-config-isolated"));
    assert.equal(Object.keys(environment).some(key => /token/i.test(key)), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
