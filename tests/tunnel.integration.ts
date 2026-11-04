import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { networkPolicy } from "../lib/network-policy.mjs";
import { readTunnelState, sameProcess } from "../lib/process-tools.mjs";
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
test("the app adopts only a live app-owned tunnel and refuses a stale or forged status file", async () => {
  const directory = await mkdtemp(path.resolve(".local", "tunnel-state-test-"));
  const file = path.join(directory, "tunnel.json");
  try {
    const now = new Date().toISOString();
    for (const state of [
      { version: 2, url: "https://stale-link.trycloudflare.com", pid: process.pid, port: 3214, createdAt: now },
      { version: 2, url: "https://api.trycloudflare.com", pid: process.pid, port: 3214, createdAt: now },
      { version: 2, url: "https://evil.test", pid: process.pid, port: 3214, createdAt: now },
      { url: "https://old-format.trycloudflare.com", pid: process.pid },
      { version: 2, url: "https://other-port.trycloudflare.com", pid: process.pid, port: 3999, createdAt: now },
    ]) {
      writeFileSync(file, JSON.stringify(state));
      assert.equal(readTunnelState(file, 3214), null, JSON.stringify(state));
    }
    // A live process of another kind, or one created after the record (a reused PID), is never adopted.
    assert.equal(sameProcess(process.pid, now, ["cloudflared.exe", "cloudflared"]), false);
    assert.equal(sameProcess(process.pid, Date.now() - 3_600_000, ["node.exe", "node"]), false);
    assert.equal(sameProcess(process.pid, now, ["node.exe", "node"]), true);
    writeFileSync(file, JSON.stringify({ version: 2, url: "https://stale-link.trycloudflare.com", pid: process.pid, port: 3214 }));
    const result = spawnSync(process.execPath, ["scripts/serve.mjs", "--port", "3214", "--tunnel"], { env: { ...process.env, MODEL_CHAT_DATA_DIR: directory }, encoding: "utf8", timeout: 60_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No running app-owned Cloudflare tunnel/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("a detached server stops gracefully only for a stop request naming this exact instance", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.resolve(".local", "app-stop-test-"));
  const child = spawn(process.execPath, ["scripts/serve.mjs", "--port", "3214"], { env: { ...process.env, MODEL_CHAT_DATA_DIR: directory }, stdio: "ignore" });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const statePath = path.join(directory, "app-state.json");
  const stopPath = path.join(directory, "app-stop.json");
  try {
    let state: { pid: number; startedAt: string; tunnel: boolean; origin: string } | undefined;
    for (let attempt = 0; attempt < 60 && !state; attempt++) {
      try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { await delay(1000); }
    }
    assert.ok(state, "The server records its instance after listening");
    assert.equal(state.pid, child.pid);
    assert.equal(state.tunnel, false);
    assert.equal(state.origin, "http://127.0.0.1:3214");
    writeFileSync(stopPath, JSON.stringify({ pid: child.pid, startedAt: "2000-01-01T00:00:00.000Z" }));
    await delay(3000);
    assert.equal(child.exitCode, null, "A stop request for an earlier instance with the same PID is ignored");
    writeFileSync(stopPath, JSON.stringify({ pid: child.pid, startedAt: state.startedAt }));
    assert.equal(await Promise.race([exited, delay(30_000).then(() => "timeout")]), 0);
    assert.equal(existsSync(statePath), false, "The instance record is removed on a graceful stop");
    assert.equal(existsSync(path.join(directory, "server.lock")), false, "The data-directory lock is released");
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
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
    for (const injected of [{ appRole: "superuser" }, { role: "superuser" }]) {
      assert.equal((await directRequest(local + "/api/auth/sign-up/email", {
        method: "POST", headers, body: JSON.stringify({ email: "forged-role@example.test", password, ...injected }),
      })).status, 400, "Public signup must not assign a role.");
    }
    const newSignup = await directRequest(local + "/api/auth/sign-up/email", {
      method: "POST", headers, body: JSON.stringify({ email: "new@example.test", password }),
    });
    assert.equal(newSignup.status, 200);
    const newCookies = newSignup.headers.getSetCookie();
    assert.ok(newCookies.some(value => /session_token/.test(value) && /;\s*Secure/i.test(value)));
    const newCookie = newCookies.map(value => value.split(";")[0]).join("; ");
    assert.equal((await directRequest(local + "/api/account", { headers: { ...headers, cookie: newCookie } })).status, 200, "Signup creates a session immediately, without OTP");
    const ordinary = await (await directRequest(local + "/api/account", { headers: { ...headers, cookie: newCookie } })).json();
    assert.equal(ordinary.user.appRole, "user");
    assert.equal(ordinary.actor.id, ordinary.user.id);
    assert.equal((await directRequest(local + "/api/admin/users", { headers: { ...headers, cookie: newCookie } })).status, 403);
    assert.equal((await directRequest(local + "/api/admin/audit", { headers: { ...headers, cookie: newCookie } })).status, 403);
    assert.equal((await directRequest(local + "/api/admin/acting", {
      method: "POST", headers: { ...headers, cookie: newCookie }, body: JSON.stringify({ userId: ordinary.user.id }),
    })).status, 403);
    const forgedCookie = `${newCookie}; model-chat-acting=forged-other-user`;
    const unmodified = await (await directRequest(local + "/api/account", { headers: { ...headers, cookie: forgedCookie } })).json();
    assert.equal(unmodified.user.id, ordinary.user.id, "An invented acting cookie is not an authorization source.");
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
