import { test } from "node:test";
import assert from "node:assert/strict";
import { linkDocument, publishStableLink, stableLinkConfig, stableLinkOrigin } from "../lib/stable-link.mjs";

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

test("the shareable link is configured from owner/repository and is off by default", () => {
  assert.equal(stableLinkConfig(env({})), null);
  assert.deepEqual(stableLinkConfig(env({ MODEL_CHAT_PAGES_REPO: "Some-Owner/model-chat" })), {
    repo: "Some-Owner/model-chat", account: "Some-Owner", origin: "https://some-owner.github.io", address: "https://some-owner.github.io/model-chat/",
  });
  assert.equal(stableLinkConfig(env({ MODEL_CHAT_PAGES_REPO: "owner/owner.github.io" }))!.address, "https://owner.github.io/");
  for (const invalid of ["owner", "owner/repo/extra", "../repo", "owner/re po", "https://github.com/owner/repo"]) {
    assert.throws(() => stableLinkConfig(env({ MODEL_CHAT_PAGES_REPO: invalid })), /owner\/repository/);
    assert.equal(stableLinkOrigin(env({ MODEL_CHAT_PAGES_REPO: invalid })), null, "A bad setting never breaks the server");
  }
});

test("only exact HTTPS Quick Tunnel origins can be published", async () => {
  const now = new Date("2026-11-11T00:00:00Z");
  assert.deepEqual(linkDocument("https://good-name-1.trycloudflare.com", now), { online: true, url: "https://good-name-1.trycloudflare.com", updatedAt: "2026-11-11T00:00:00.000Z" });
  assert.deepEqual(linkDocument(null, now), { online: false, url: null, updatedAt: "2026-11-11T00:00:00.000Z" });
  for (const invalid of [
    "https://evil.test", "http://name.trycloudflare.com", "https://api.trycloudflare.com", "https://name.trycloudflare.com/",
    "https://name.trycloudflare.com.evil.test", "https://a.b.trycloudflare.com", "https://user@name.trycloudflare.com",
    "https://name.trycloudflare.com:444", "javascript:alert(1)", "", undefined,
  ]) assert.throws(() => linkDocument(invalid as string), /trycloudflare\.com link/, String(invalid));
  // Rejected before any GitHub login or network request is attempted.
  await assert.rejects(publishStableLink("https://evil.test", { env: env({ MODEL_CHAT_PAGES_REPO: "owner/repo" }) }), /trycloudflare\.com link/);
  assert.deepEqual(await publishStableLink("https://good.trycloudflare.com", { env: env({}) }), { skipped: true });
});
