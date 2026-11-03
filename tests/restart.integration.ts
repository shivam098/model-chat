import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store";
import { AccessService } from "../lib/access";
import { UploadStore } from "../lib/upload-store";

test("full server restart retains auth sessions, isolated histories, files and interrupted reply", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.resolve(".local", "restart-test-"));
  const origin = "http://127.0.0.1:3212";
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn(process.execPath, ["scripts/serve.mjs", "--port", "3212"], {
      env: { ...process.env, MODEL_CHAT_DATA_DIR: directory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout?.on("data", chunk => { logs += chunk.toString(); });
    child.stderr?.on("data", chunk => { logs += chunk.toString(); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Test server failed: " + logs);
      try { if ((await fetch(origin + "/api/health")).ok) return; } catch { /* Server is still starting. */ }
      await delay(200);
    }
    throw new Error("Test server was not ready: " + logs);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const processToStop = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Test server did not stop.")), 10_000);
      processToStop.once("exit", () => { clearTimeout(timer); resolve(); });
      processToStop.kill("SIGTERM");
    });
  };
  const request = (resource: string, cookie: string, method = "GET", body?: unknown) =>
    fetch(origin + resource, {
      method, headers: { origin, cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    await start();
    const email = `restart-${randomUUID()}@example.test`;
    const password = "Unique test-only pass! 34543";
    const signup = await request("/api/auth/sign-up/email", "", "POST", { name: "Restart test", email, password });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const account = await (await request("/api/account", cookie)).json();
    const chat = (await (await request("/api/chats", cookie, "POST")).json()).chat;
    const file = await fetch(origin + `/api/chats/${chat.id}/files`, {
      method: "POST", headers: { origin, cookie, "X-File-Name": "persist.txt" }, body: "Persistent file content.",
    });
    assert.equal(file.status, 202);
    const attachment = (await file.json()).attachment;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await (await request(`/api/chats/${chat.id}/files`, cookie)).json();
      if (result.attachments[0].processingStatus === "ready") break;
      await delay(100);
    }
    await stop();
    const db = new Database(path.join(directory, "model-chat.db"));
    const store = new Store(db);
    const turn = store.beginTurn(account.user.id, chat.id, "Saved user question", "test-model", [attachment.id]);
    store.saveReply(account.user.id, chat.id, turn.assistant.id, "Interrupted partial answer", "streaming");
    const hash = (db.prepare("SELECT password FROM account WHERE userId=?").get(account.user.id) as { password: string }).password;
    assert.ok(hash && hash !== password && !hash.includes(password));
    const session = db.prepare("SELECT id FROM session WHERE userId=?").get(account.user.id) as { id: string };
    const uploads = new UploadStore(store);
    const context = new AccessService(store).resolve(account.user.id, session.id);
    const pending = uploads.create(context, chat.id, "interrupted.txt", "txt", 32);
    uploads.append(pending, 0, Buffer.from("Process this file after restart."));
    uploads.enqueue(pending);
    assert.equal(uploads.claim(false)?.fileId, pending);
    db.close();
    await start();
    const observer = new Database(path.join(directory, "model-chat.db"), { readonly: true });
    try {
      const jobStatus = () => (observer.prepare("SELECT status FROM app_file_job WHERE fileId=?").get(pending) as { status: string }).status;
      for (let attempt = 0; attempt < 100 && jobStatus() !== "ready"; attempt++) await delay(100);
      assert.equal(jobStatus(), "ready", "Restarted processing must finish without a browser or authenticated request");
      const chunks = observer.prepare("SELECT content FROM app_text_chunk WHERE fileId=? ORDER BY position").all(pending) as { content: string }[];
      assert.equal(chunks.map(chunk => chunk.content).join(""), "Process this file after restart.");
    } finally { observer.close(); }
    assert.equal((await request("/api/account", cookie)).status, 200, "Server-side session survives restart");
    const restored = await (await request(`/api/chats/${chat.id}`, cookie)).json();
    assert.equal(restored.messages[0].content, "Saved user question");
    assert.equal(restored.messages[1].status, "error");
    assert.equal(restored.messages[1].content, "Interrupted partial answer");
    assert.equal(restored.attachments[0].id, attachment.id);
    assert.equal(await (await request(`/api/chats/${chat.id}/files/${attachment.id}`, cookie)).text(), "Persistent file content.");
    assert.equal((await request("/api/auth/sign-out", cookie, "POST", {})).status, 200);
    assert.equal((await request("/api/account", cookie)).status, 401, "Logout revokes the old session");
    const login = await request("/api/auth/sign-in/email", "", "POST", { email, password });
    assert.equal(login.status, 200, "Password authentication survives restart");
    const nextCookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.equal((await request(`/api/chats/${chat.id}`, nextCookie)).status, 200);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
