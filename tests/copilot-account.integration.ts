// Opt-in, needs this machine's stored app sign-in (npm run copilot:login). Lists models only; makes no model request.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import env from "@next/env";
import { CopilotClient } from "@github/copilot-sdk";

env.loadEnvConfig(process.cwd());
const fakeToken = (digit: string) => `gho_${digit.repeat(36)}`;
const otherAccount = "model-chat-other-account";
// Simulates the GitHub CLI switching its active account: every gh config location now names another, unusable account.
const fake = mkdtempSync(path.join(os.tmpdir(), "model-chat-fake-gh-"));
const hosts = `github.com:\n    users:\n        ${otherAccount}:\n            oauth_token: ${fakeToken("0")}\n    git_protocol: https\n    oauth_token: ${fakeToken("0")}\n    user: ${otherAccount}\n`;
for (const dir of [path.join(fake, "AppData", "GitHub CLI"), path.join(fake, "gh")]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "hosts.yml"), hosts);
}
const saved = Object.fromEntries(["APPDATA", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "MODEL_CHAT_COPILOT_LOGIN"].map(key => [key, process.env[key]]));
process.env.APPDATA = path.join(fake, "AppData");
process.env.GH_CONFIG_DIR = path.join(fake, "gh");
process.env.GH_TOKEN = fakeToken("1");
process.env.GITHUB_TOKEN = fakeToken("2");
process.env.COPILOT_GITHUB_TOKEN = fakeToken("3");
const { listModels, copilotAccount, forgetCopilotCredential } = await import("../lib/copilot");
const { ACCOUNT_UNAVAILABLE, expectedCopilotLogin } = await import("../lib/copilot-account");
const { runtimeEnvironment } = await import("../lib/runtime-env.mjs");
const { dataDirectory } = await import("../lib/config");
const expected = expectedCopilotLogin(path.join(dataDirectory, "copilot")).login;

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fake, { recursive: true, force: true });
});

test("control: the previous configuration follows the GitHub CLI's active account", async () => {
  const home = path.join(fake, "copilot-home");
  mkdirSync(home, { recursive: true });
  const client = new CopilotClient({ mode: "empty", baseDirectory: home, workingDirectory: home, env: runtimeEnvironment(), useLoggedInUser: true, logLevel: "error" });
  try {
    await client.start();
    const status = await client.getAuthStatus();
    console.log(`  previous configuration reports: ${status.isAuthenticated ? `${status.authType} ${status.login}` : status.statusMessage}`);
    assert.ok(!(status.isAuthenticated && status.login === expected), "the simulated gh switch must change what the previous configuration uses");
  } finally { await client.stop().catch(() => client.forceStop()); }
});

test("the app keeps its configured account when gh's active account and token variables change", async () => {
  forgetCopilotCredential();
  const models = await listModels(true);
  assert.ok(models.length > 0);
  assert.equal((await copilotAccount()).login.toLowerCase(), expected.toLowerCase());
  console.log(`  app uses ${expected} with ${models.length} models`);
});

test("a different configured account fails clearly instead of using another sign-in", async () => {
  process.env.MODEL_CHAT_COPILOT_LOGIN = "model-chat-test-nobody";
  try {
    await assert.rejects(listModels(true), (error: Error & { status?: number }) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, ACCOUNT_UNAVAILABLE);
      assert.ok(!error.message.includes(expected), "the public message names no account");
      assert.match((error.cause as Error).message, /not the configured account model-chat-test-nobody/);
      return true;
    });
  } finally {
    process.env.MODEL_CHAT_COPILOT_LOGIN = saved.MODEL_CHAT_COPILOT_LOGIN;
    if (saved.MODEL_CHAT_COPILOT_LOGIN === undefined) delete process.env.MODEL_CHAT_COPILOT_LOGIN;
    forgetCopilotCredential();
  }
});
