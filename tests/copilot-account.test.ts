import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACCOUNT_UNAVAILABLE, checkTokenWithGitHub, credentialPlan, expectedCopilotLogin, expiryNotice, isolatedRuntimeEnvironment, parseTokenExpiry, selectStoredSignIn, tokenLogin, tokenProblem, verifyRuntimeIdentity } from "../lib/copilot-account";
import { COPILOT_TOKEN_VARIABLE, redactSecrets, takeCopilotToken, withoutCopilotToken } from "../lib/secret-env.mjs";

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

// A made-up value in the shape of a fine-grained token; never a real credential.
const fakeToken = "github_pat_" + "11AAAAAAA0exampleONLY_" + "x".repeat(59);

test("MODEL_CHAT_COPILOT_TOKEN wins over the stored sign-in; without it the stored sign-in rules are unchanged", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "model-chat-account-"));
  try {
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ lastLoggedInUser: { host, login: "stored_user" } }));
    assert.deepEqual(credentialPlan(home, undefined, {}), { kind: "stored", login: "stored_user", source: "this app's npm run copilot:login" });
    assert.deepEqual(credentialPlan(home, undefined, { MODEL_CHAT_COPILOT_LOGIN: "pinned" }), { kind: "stored", login: "pinned", source: "MODEL_CHAT_COPILOT_LOGIN" });
    assert.deepEqual(credentialPlan(home, fakeToken, {}), { kind: "token", token: fakeToken, login: undefined, source: "MODEL_CHAT_COPILOT_TOKEN in .env.local" });
    assert.equal(credentialPlan(home, fakeToken, { MODEL_CHAT_COPILOT_LOGIN: " kumarshiv_microsoft " }).login, "kumarshiv_microsoft");
    // A token needs no stored sign-in at all, on a computer that never ran npm run copilot:login.
    const empty = mkdtempSync(path.join(os.tmpdir(), "model-chat-account-"));
    try { assert.equal(credentialPlan(empty, fakeToken, {}).kind, "token"); } finally { rmSync(empty, { recursive: true, force: true }); }
    rejectsWith(() => credentialPlan(home, "ghp_" + "a".repeat(36), {}), /classic personal access token.*Copilot Requests/);
    rejectsWith(() => credentialPlan(home, "github_pat_ partial", {}), /isn't a complete token.*Copilot Requests/);
    rejectsWith(() => credentialPlan(home, fakeToken, { MODEL_CHAT_COPILOT_LOGIN: "bad login" }), /not a valid GitHub login/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the token must resolve to MODEL_CHAT_COPILOT_LOGIN; a mismatch fails closed with the generic message", () => {
  const work = { authInfo: { type: "token", copilotUser: { login: "kumarshiv_microsoft" } } };
  assert.equal(tokenLogin(work, "KumarShiv_Microsoft"), "kumarshiv_microsoft");
  assert.equal(tokenLogin(work), "kumarshiv_microsoft", "Without a configured login the resolved one is reported");
  rejectsWith(() => tokenLogin({ authInfo: { type: "token", copilotUser: { login: "someone-else" } } }, "kumarshiv_microsoft"), /belongs to someone-else, not the configured account kumarshiv_microsoft/);
  assert.equal(tokenLogin({ authErrors: ["Failed to validate SDK token (401): GitHub returned: Bad credentials"] }, "kumarshiv_microsoft"), null);
  assert.equal(tokenLogin({ authInfo: { type: "gh-cli", copilotUser: { login: "kumarshiv_microsoft" } } }), null, "Only the token itself counts");
  rejectsWith(() => verifyRuntimeIdentity({}, "work", true), /did not accept MODEL_CHAT_COPILOT_TOKEN.*Copilot Requests/);
});

test("plain owner-facing errors for expired, revoked or under-permitted tokens; users only see the generic message", () => {
  rejectsWith(() => { throw tokenProblem({ status: "rejected" }); }, /expired, been revoked or wasn't copied completely\. Create a new fine-grained personal access token with the Copilot Requests permission/);
  rejectsWith(() => { throw tokenProblem({ status: "accepted", login: "kumarshiv_microsoft" }); }, /accepts MODEL_CHAT_COPILOT_TOKEN for kumarshiv_microsoft, but Copilot refused it: it's probably missing the Copilot Requests permission/);
  rejectsWith(() => { throw tokenProblem({ status: "unknown" }, ["Failed to validate SDK token (401): GitHub returned: Bad credentials"]); }, /expired, been revoked/);
  rejectsWith(() => { throw tokenProblem({ status: "unknown" }); }, /couldn't be asked why.*Copilot Requests/);
});

test("GitHub's own answer tells rejected from accepted tokens and reports the expiry date", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  assert.deepEqual(await checkTokenWithGitHub(fakeToken, reply(401, { message: "Bad credentials" })), { status: "rejected" });
  const accepted = await checkTokenWithGitHub(fakeToken, reply(200, { login: "kumarshiv_microsoft" }, { "github-authentication-token-expiration": "2026-12-21 08:09:11 UTC" }));
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.login, "kumarshiv_microsoft");
  assert.equal(accepted.expiresAt?.toISOString(), "2026-12-21T08:09:11.000Z");
  assert.equal((await checkTokenWithGitHub(fakeToken, reply(200, { login: "x" }))).expiresAt, undefined, "No header: no expiry claimed");
  assert.deepEqual(await checkTokenWithGitHub(fakeToken, reply(503, {})), { status: "unknown" });
  assert.deepEqual(await checkTokenWithGitHub(fakeToken, (async () => { throw new Error("offline"); }) as typeof fetch), { status: "unknown" });
  assert.ok(calls.every(call => call.url === "https://api.github.com/user" && call.init?.redirect === "error"), "Only GitHub's API, no redirects");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), `Bearer ${fakeToken}`);
});

test("expiry warnings start 3 days before the token expires; odd header formats are ignored", () => {
  const now = new Date("2026-12-18T09:00:00Z");
  assert.equal(parseTokenExpiry("2026-12-21 08:09:11 +0000"), undefined);
  assert.equal(parseTokenExpiry("soon"), undefined);
  assert.deepEqual(expiryNotice(undefined, now), { text: "GitHub reports no expiry date for MODEL_CHAT_COPILOT_TOKEN.", warn: false });
  assert.equal(expiryNotice(new Date("2026-12-28T09:00:00Z"), now).warn, false);
  assert.match(expiryNotice(new Date("2026-12-28T09:00:00Z"), now).text, /expires on 2026-12-28 09:00 UTC \(in 10 days\)/);
  const soon = expiryNotice(new Date("2026-12-21T08:09:11Z"), now);
  assert.equal(soon.warn, true);
  assert.match(soon.text, /in 2 days\. Create a new fine-grained personal access token with the Copilot Requests permission/);
  assert.match(expiryNotice(new Date("2026-12-18T20:00:00Z"), now).text, /less than a day/);
  assert.match(expiryNotice(new Date("2026-12-17T09:00:00Z"), now).text, /expired on 2026-12-17/);
});

test("the token leaves process.env once read, never reaches child environments and is redacted from diagnostics", () => {
  const saved = process.env[COPILOT_TOKEN_VARIABLE];
  const state = globalThis as { modelChatCopilotToken?: string };
  try {
    process.env[COPILOT_TOKEN_VARIABLE] = `  ${fakeToken}  `;
    assert.equal(takeCopilotToken(), fakeToken);
    assert.equal(COPILOT_TOKEN_VARIABLE in process.env, false, "Removed from process.env, so spawned programs can't inherit it");
    assert.equal(takeCopilotToken(), fakeToken, "Still available to the Copilot runtime from memory");
    assert.deepEqual(withoutCopilotToken({ PATH: "p", [COPILOT_TOKEN_VARIABLE]: fakeToken }), { PATH: "p" });
    assert.equal(withoutCopilotToken({ model_chat_copilot_token: fakeToken }).model_chat_copilot_token, undefined);
    const text = redactSecrets(`token ${fakeToken}, oauth gho_${"b".repeat(36)}, app ghu_${"c".repeat(36)}, classic ghp_${"d".repeat(36)}.`);
    assert.equal(text, "token [redacted], oauth [redacted], app [redacted], classic [redacted].");
    state.modelChatCopilotToken = "an-unusual-token-value-without-a-prefix";
    assert.equal(redactSecrets("x an-unusual-token-value-without-a-prefix y"), "x [redacted] y");
    // Owner diagnostics never repeat the token.
    for (const check of [{ status: "rejected" as const }, { status: "accepted" as const, login: "a" }, { status: "unknown" as const }]) {
      assert.equal(((tokenProblem(check).cause as Error).message).includes("github_pat_"), false);
    }
  } finally {
    state.modelChatCopilotToken = undefined;
    if (saved === undefined) delete process.env[COPILOT_TOKEN_VARIABLE];
    else process.env[COPILOT_TOKEN_VARIABLE] = saved;
  }
});
