// Shareable stable link: a GitHub Pages page that forwards visitors to the current Quick Tunnel.
// Publishing uses the owner's stored GitHub CLI login for the configured account. The token stays in
// memory for the duration of the API calls: never on the command line, in files, or in output.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { withoutCopilotToken } from "./secret-env.mjs";

export const TUNNEL_LINK = /^https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com$/;
const BRANCH = "gh-pages";
const PAGE_FILES = ["index.html", "forward.js"];

export function stableLinkConfig(env = process.env) {
  const repo = env.MODEL_CHAT_PAGES_REPO?.trim();
  if (!repo) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(repo);
  if (!match) throw new Error("MODEL_CHAT_PAGES_REPO must look like owner/repository.");
  const owner = match[1].toLowerCase();
  const origin = `https://${owner}.github.io`;
  const address = match[2].toLowerCase() === `${owner}.github.io` ? `${origin}/` : `${origin}/${match[2]}/`;
  return { repo: `${match[1]}/${match[2]}`, account: env.MODEL_CHAT_PAGES_ACCOUNT?.trim() || match[1], origin, address };
}
// For the server's status probe: a misconfigured value must never stop the app.
export function stableLinkOrigin(env = process.env) {
  try { return stableLinkConfig(env)?.origin ?? null; } catch { return null; }
}
export function linkDocument(url, now = new Date()) {
  if (url === null) return { online: false, url: null, updatedAt: now.toISOString() };
  if (typeof url !== "string" || !TUNNEL_LINK.test(url)) throw new Error("Only an https://<name>.trycloudflare.com link can be published.");
  return { online: true, url, updatedAt: now.toISOString() };
}

function storedToken(account) {
  const env = withoutCopilotToken(process.env);
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete env[name];
  // Reads the stored login without switching the active GitHub CLI account.
  const result = spawnSync("gh", ["auth", "token", "--hostname", "github.com", "--user", account], { encoding: "utf8", windowsHide: true, timeout: 30_000, env });
  const token = result.status === 0 ? result.stdout.trim() : "";
  if (!token) throw new Error(`The GitHub CLI has no stored login for ${account} on this PC.`);
  return token;
}
const blobSha = content => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

export async function publishStableLink(url, { root = process.cwd(), now = new Date(), env = process.env } = {}) {
  const config = stableLinkConfig(env);
  if (!config) return { skipped: true };
  const document = linkDocument(url, now);
  const files = { ".nojekyll": "\n", ...Object.fromEntries(PAGE_FILES.map(name => [name, readFileSync(path.join(root, "link-page", name), "utf8")])) };
  const token = storedToken(config.account);
  const redact = text => String(text).replaceAll(token, "[redacted]").replace(/\b(gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]");
  const github = async (method, route, body) => {
    const response = await fetch(`https://api.github.com${route}`, {
      method, signal: AbortSignal.timeout(30_000), body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "model-chat-link", ...(body ? { "Content-Type": "application/json" } : {}) },
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).message || ""; } catch { /* No JSON body. */ }
      throw Object.assign(new Error(`GitHub ${method} ${route.split("?")[0]} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`), { status: response.status });
    }
    return response.status === 204 ? null : response.json();
  };
  try {
    const user = await github("GET", "/user");
    if (user?.login?.toLowerCase() !== config.account.toLowerCase()) throw new Error(`The stored login is not ${config.account}.`);
    const repository = await github("GET", `/repos/${config.repo}`);
    if (!repository?.permissions?.push) throw new Error(`${config.account} cannot publish to ${config.repo}.`);
    const reference = await github("GET", `/repos/${config.repo}/git/ref/heads/${BRANCH}`);
    let parent = null;
    let changed = true;
    if (reference) {
      parent = await github("GET", `/repos/${config.repo}/git/commits/${reference.object.sha}`);
      const tree = await github("GET", `/repos/${config.repo}/git/trees/${parent.tree.sha}`);
      const entries = new Map(tree.tree.map(entry => [entry.path, entry.sha]));
      const pageCurrent = Object.entries(files).every(([name, content]) => entries.get(name) === blobSha(content));
      let published = null;
      if (entries.has("link.json")) {
        const blob = await github("GET", `/repos/${config.repo}/git/blobs/${entries.get("link.json")}`);
        try { published = JSON.parse(Buffer.from(blob.content, "base64").toString("utf8")); } catch { /* Replace an unreadable value. */ }
      }
      changed = !pageCurrent || published?.online !== document.online || published?.url !== document.url;
    }
    if (changed) {
      const tree = await github("POST", `/repos/${config.repo}/git/trees`, {
        base_tree: parent?.tree.sha,
        tree: Object.entries({ ...files, "link.json": `${JSON.stringify(document, null, 2)}\n` }).map(([name, content]) => ({ path: name, mode: "100644", type: "blob", content })),
      });
      // A noreply identity keeps personal email addresses out of the public branch.
      const identity = { name: "Model Chat link", email: `${user.id}+${user.login}@users.noreply.github.com`, date: now.toISOString() };
      const commit = await github("POST", `/repos/${config.repo}/git/commits`, {
        message: document.online ? "Point the Model Chat link to the current tunnel" : "Mark Model Chat offline",
        tree: tree.sha, parents: parent ? [parent.sha] : [], author: identity, committer: identity,
      });
      if (reference) await github("PATCH", `/repos/${config.repo}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
      else await github("POST", `/repos/${config.repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
    }
    let pages = await github("GET", `/repos/${config.repo}/pages`);
    if (!pages) {
      // GitHub may enable Pages by itself as soon as a gh-pages branch appears.
      try { pages = await github("POST", `/repos/${config.repo}/pages`, { source: { branch: BRANCH, path: "/" } }); }
      catch (error) { if (error.status !== 409) throw error; pages = await github("GET", `/repos/${config.repo}/pages`); }
    }
    if (pages?.source?.branch !== BRANCH || pages?.source?.path !== "/") {
      throw new Error(`GitHub Pages for ${config.repo} already publishes from ${pages.source?.branch}${pages.source?.path}; change it to ${BRANCH} / (root) in the repository's Pages settings.`);
    }
    if (pages.https_enforced === false) await github("PUT", `/repos/${config.repo}/pages`, { https_enforced: true });
    return { skipped: false, changed, address: config.address, document };
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : error));
  }
}

// Read-only check of the Pages settings (source branch and HTTPS), for verification.
export async function stableLinkSettings(env = process.env) {
  const config = stableLinkConfig(env);
  if (!config) return null;
  const token = storedToken(config.account);
  try {
    const response = await fetch(`https://api.github.com/repos/${config.repo}/pages`, {
      signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "model-chat-link" },
    });
    if (!response.ok) return { status: response.status };
    const pages = await response.json();
    return { url: pages.html_url, source: pages.source, httpsEnforced: pages.https_enforced, buildStatus: pages.status, visibility: pages.public === false ? "private" : "public" };
  } catch (error) { throw new Error(String(error instanceof Error ? error.message : error).replaceAll(token, "[redacted]")); }
}

// What visitors currently get, read through Pages itself with a cache-busting query.
export async function readStableLink(config) {
  const response = await fetch(`${config.address}link.json?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
