import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { networkPolicy } from "../lib/network-policy.mjs";
import http from "node:http";

function directRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method || "GET", headers: init.headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: response.statusCode!, headers }));
      });
    });
    request.on("error", reject);
    request.end(init.body);
  });
}

test("tunnel origins must be explicit, exact HTTPS Quick Tunnel origins", () => {
  assert.equal(networkPolicy(3210, undefined).tunnelMode, false);
  assert.equal(networkPolicy(3210, "https://example-name.trycloudflare.com").tunnelMode, true);
  for (const invalid of ["http://example.trycloudflare.com", "https://evil.test", "https://foo.trycloudflare.com.evil.test", "https://foo.trycloudflare.com/path", "https://user@foo.trycloudflare.com", "https://foo.trycloudflare.com:444"]) {
    assert.throws(() => networkPolicy(3210, invalid));
  }
});
test("tunnel mode allows email/password signup without OTP and preserves secure login and origin protections", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.resolve(".local", "tunnel-test-"));
  const local = "http://127.0.0.1:3213";
  const remote = "https://validation-only.trycloudflare.com";
  let child: ChildProcess | undefined;
  const start = async (tunnelMode: boolean) => {
    child = spawn(process.execPath, ["scripts/serve.mjs", "--port", "3213"], {
      env: { ...process.env, MODEL_CHAT_DATA_DIR: directory, MODEL_CHAT_TUNNEL_ORIGIN: tunnelMode ? remote : "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout?.on("data", chunk => { logs += chunk; });
    child.stderr?.on("data", chunk => { logs += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Test server failed: " + logs);
      try { if ((await fetch(local + "/api/health")).ok) return; } catch { /* Wait for server readiness. */ }
      await delay(200);
    }
    throw new Error("Test server did not become ready.");
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const running = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test server did not stop.")), 10_000);
      running.once("exit", () => { clearTimeout(timer); resolve(); });
      running.kill("SIGTERM");
    });
  };
  const password = "Private test-only password 347!";
  try {
    await start(false);
    const signup = await fetch(local + "/api/auth/sign-up/email", {
      method: "POST", headers: { origin: local, "content-type": "application/json" },
      body: JSON.stringify({ name: "Tunnel test", email: "tunnel-test@example.test", password }),
    });
    assert.equal(signup.status, 200);
    await stop();
    await start(true);
    const headers = { host: new URL(remote).host, origin: remote, "content-type": "application/json", "x-forwarded-proto": "https" };
    const access = await (await directRequest(local + "/api/access", { headers })).json();
    assert.deepEqual(access, { tunnelMode: true, registrationAllowed: true });
    assert.equal((await directRequest(local + "/api/auth/sign-up/email", { method: "POST", headers, body: "{}" })).status, 400);
    for (const invalid of [{ email: "not-email", password }, { email: "new@example.test", password: "short" }]) {
      assert.equal((await directRequest(local + "/api/auth/sign-up/email", { method: "POST", headers, body: JSON.stringify(invalid) })).status, 400);
    }
    const newSignup = await directRequest(local + "/api/auth/sign-up/email", {
      method: "POST", headers, body: JSON.stringify({ email: "new@example.test", password }),
    });
    assert.equal(newSignup.status, 200);
    const newCookies = newSignup.headers.getSetCookie();
    assert.ok(newCookies.some(value => /session_token/.test(value) && /;\s*Secure/i.test(value)));
    const newCookie = newCookies.map(value => value.split(";")[0]).join("; ");
    assert.equal((await directRequest(local + "/api/account", { headers: { ...headers, cookie: newCookie } })).status, 200, "Signup creates a session immediately, without OTP");
    assert.equal((await directRequest(local + "/api/chats", { headers })).status, 401);
    assert.equal((await directRequest(local + "/api/chats", { method: "POST", headers: { ...headers, origin: "https://evil.test" } })).status, 403);
    const insecure = await directRequest(local + "/", { headers: { ...headers, "x-forwarded-proto": "http" } });
    assert.equal(insecure.status, 308);
    assert.equal(insecure.headers.get("location"), remote + "/");
    assert.equal((await directRequest(local + "/api/auth/sign-in/email", { method: "POST", headers: { ...headers, "x-forwarded-proto": "http" }, body: "{}" })).status, 403);
    const login = await directRequest(local + "/api/auth/sign-in/email", {
      method: "POST", headers, body: JSON.stringify({ email: "tunnel-test@example.test", password }),
    });
    assert.equal(login.status, 200, await login.text());
    assert.equal(login.headers.get("strict-transport-security"), "max-age=86400");
    const cookies = login.headers.getSetCookie();
    assert.ok(cookies.some(value => /session_token/.test(value) && /;\s*Secure/i.test(value) && /;\s*HttpOnly/i.test(value) && /SameSite=Strict/i.test(value)));
    const cookie = cookies.map(value => value.split(";")[0]).join("; ");
    const created = await directRequest(local + "/api/chats", { method: "POST", headers: { ...headers, cookie } });
    assert.equal(created.status, 201);
    const original = (await created.json()).chat;
    assert.equal((await directRequest(local + `/api/chats/${original.id}`, { headers: { ...headers, cookie: newCookie } })).status, 404);
    const demo = await directRequest(local + "/api/demos", { method: "POST", headers: { ...headers, cookie: newCookie }, body: '{"demoId":"budget"}' });
    assert.equal(demo.status, 201);
    const sample = await demo.json();
    assert.equal(sample.detail.messages.length, 0);
    assert.match(sample.detail.chat.draft, /sample-budget.csv/);
    assert.equal((await directRequest(local + `/api/chats/${sample.detail.chat.id}`, { headers: { ...headers, cookie } })).status, 404);
    assert.equal((await directRequest(local + "/api/auth/sign-out", { method: "POST", headers: { ...headers, cookie: newCookie }, body: "{}" })).status, 200);
    assert.equal((await directRequest(local + "/api/account", { headers: { ...headers, cookie: newCookie } })).status, 401);
    assert.equal((await directRequest(local + "/api/auth/sign-in/email", { method: "POST", headers, body: JSON.stringify({ email: "new@example.test", password: "wrong-password" }) })).status, 401);
    assert.equal((await directRequest(local + "/api/auth/sign-in/email", { method: "POST", headers, body: JSON.stringify({ email: "new@example.test", password }) })).status, 200);
    assert.equal((await fetch(local + "/api/chats", { method: "POST", headers: { origin: local } })).status, 403);
    const redirect = await fetch(local, { redirect: "manual" });
    assert.equal(redirect.status, 307);
    assert.equal(redirect.headers.get("location"), remote + "/");
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
