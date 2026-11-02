# Model Chat

A small, local web app for your GitHub Copilot models, text conversations, browser dictation, read-aloud, and document questions. Built with Next.js, React, Better Auth, SQLite, and the official Copilot SDK.

## Start

Use **Node.js 24 LTS** (24.13 or later) and npm. In PowerShell:

```powershell
Set-Location "$HOME\Downloads\model-chat"
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3210** in Edge or Chrome. Create an account with an email and a unique password of at least 12 characters. Gmail addresses work; no OTP, verification email, or display-name step is required. This creates a Model Chat account, **not** a Google or GitHub OAuth login. You do **not** need an OAuth application, API key, or external database.

- For development: `npm run dev`
- For another port: `npm start -- --port 3215` (then use exactly `http://127.0.0.1:3215`)
- Stop a foreground server with **Ctrl+C**. Only one server may use a data directory at a time.
- Optional settings are documented in `.env.example`; copy it to `.env.local` only if needed.
- Do not run `next start` directly: `npm start` includes the loopback and origin checks.

### Temporary Cloudflare link

For temporary remote access without a domain or Cloudflare account, install the official `cloudflared` CLI and stop the local app server. Then:

```powershell
npm run build
npm run tunnel
```

This starts both the app and a Cloudflare Quick Tunnel, verifies its remote access policy, and prints an `https://....trycloudflare.com` link. Anyone who opens the link can sign up with an email and password or sign in to an existing account. **Public signup is intentionally open, without OTP. Every account's model requests use the host owner's Copilot entitlement and quota.** HTTPS redirects, Secure cookies, HSTS, and exact public Host/Origin checks remain enabled; the backend still binds only to loopback.

This is an internet-facing signup/login page protected by **app passwords**, not Cloudflare Access. Use a strong unique password, not your Gmail password. Sharing the link permits others to create accounts and consume the owner's Copilot quota. Existing signup/login rate limits, account storage limits, and generation concurrency limits remain in place, but they do not guarantee a billing cap or prevent a determined person from making multiple accounts. Cloudflare relays and terminates HTTPS traffic. No password recovery is configured.

Keep the computer awake and the command running. **Ctrl+C** stops both the app and link. Run `npm start` afterwards to return to local-only mode. Each tunnel launch creates a different URL; Quick Tunnels have no uptime guarantee and are for temporary use, not production hosting. The app uses NDJSON rather than SSE for reply streaming; buffering can still depend on the connection.

The launcher uses an app-owned minimal Cloudflare config instead of modifying any existing global tunnel configuration, and disables auto-updates. `.local/tunnel.json` records the active URL; the launcher removes it on normal shutdown. A forced shutdown can leave stale status, so use the live process/output as the source of truth.

### Copilot sign-in

The backend uses the official SDK's **stored CLI / supported GitHub CLI credential fallback**. It never reads, exports, or copies credentials itself. SDK/runtime configuration and sessions are isolated under this app's data directory. Authentication can reuse this machine's existing sign-in; it is not guaranteed that a desktop-app sign-in alone is sufficient.

Check the connection without a model call:

```powershell
npm run check:copilot
```

If sign-in is unavailable:

```powershell
npm run copilot:login
```

This launches the installed `copilot login` command with an app-specific `COPILOT_HOME`. Follow its official browser/device sign-in flow, then use **Refresh connection** in the app. If `copilot` is not installed, install the official [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) first. The SDK itself bundles the matching runtime for generation. Corporate policy, subscription entitlements, network access, and usage limits still apply.

`npm run check:copilot -- --chat` additionally makes **one small, real, billable model request**. The UI and scripts never produce pretend model answers. Model choices come from `client.listModels()`, filtered by policy; they can differ from those in the desktop app. A failed connection, model restriction, empty answer, or exhausted allowance is shown explicitly.

## Using it

Choose a model, type a message, and press Enter (Shift+Enter inserts a line break). Replies stream into the chat; **Stop reply** keeps any received text as an explicitly partial answer. Disconnecting or signing out also cancels the active reply. If the server restarts, unfinished replies are marked interrupted on the next startup.

Use the sidebar to start, reopen, rename, or delete conversations. Refreshing, signing out/in, and restarting keep histories in SQLite. Switching models creates a fresh tool-free SDK session and sends the same chat's saved context and previously sent file text. No old messages are silently dropped: if the bounded context will not fit, the app asks you to start another chat or choose a larger-context model.

Use the paperclip to upload documents; ask a question and send to include them. Unsent files remain as draft chips across reloads and can be removed. Sent files remain part of that chat's context and can be downloaded from their message chips. To remove sent files, delete the chat.

**Dictation** is browser speech recognition, not a realtime audio conversation. Click Dictate, acknowledge the privacy notice, allow microphone access, then review the transcript before sending. Browser support varies. Permission denial, missing microphones, and unsupported browsers leave text input usable. **Read aloud** uses browser speech synthesis and can be stopped. Actual microphone accuracy and available voices depend on your browser and device; browser services may process audio online.

### How Model Chat works & Demos

Open **Menu → How Model Chat works & Demos** from the hamburger button on desktop or mobile. The guide is also available before signing in; launching a sample requires an account.

Three examples are provided: **Explore a sample budget** (small synthetic CSV), **Draft a friendly update**, and **Make a concept click**. A single **Load example draft** action creates a new, independent chat, saves a ready-to-edit prompt, and attaches the sample CSV when applicable. It preserves the current conversation and saves its unsent draft before switching, including a draft that did not yet have a chat. The operation is transactional; limits or ownership failures do not partially replace an old chat.

**Loading is not generation.** No model request or canned assistant answer is produced by opening a demo. Review the prompt and press Send to use the real selected model. Example drafts survive reopening/refresh and are cleared once their prompt is accepted into message history. Ordinary manually typed drafts are saved on demo launch, not continuously autosaved. Samples contain no personal data, and each account gets its own chats and file records.

## Boundaries and limits

| Item | Supported scope |
|---|---|
| Text | `.txt`, `.md`, `.csv`, `.json`; UTF-8 only; JSON must be valid |
| Additional text | `.log`, `.yaml`, `.yml`, `.xml`; treated as UTF-8 data, never executed |
| Native images | PNG, JPEG, WebP, static GIF; up to 5 MB / 16 megapixels / 8192 pixels per dimension; requires an advertised vision-capable model |
| PDF | Selectable text, at most 100 pages; page markers included |
| Word | `.docx` document text; no formatting, images, comments, macros, or embedded objects |
| Excel | `.xlsx`, up to 20 sheets / 10,000 nonempty cells; sheet and cell markers; cached formula values only |
| Files | 5 MB and 30,000 extracted characters per file; 4 per message; 8 and 60,000 extracted characters per chat |
| Storage | 50 MB of original files per local account; at most 100 chats / 100 turns per chat |
| Messages | 8,000 input characters; 32,000 output characters; full context capped at 100,000 UTF-8 bytes and a conservative model-specific budget |
| Processing | 20-second file parser timeout; 256 MB worker heap; ZIP preflight: 2,000 entries / 20 MB expanded / bounded compression ratio |
| Generation | One reply per account, two per app; four-minute overall timeout |

Images use the official SDK's native base64 blob attachments. Original bytes remain in owned SQLite storage and are resent on later turns/reopened chats. Model-specific image MIME, count and byte limits are checked; changing to an incompatible model fails explicitly rather than silently omitting images.

Scanned PDFs need OCR, which is **not** included. Password-protected documents, executable/ZIP uploads, legacy `.doc`/`.xls`, charts, animated images, audio uploads, and video are **not** supported. The installed Copilot SDK documents native image input, not native audio/video understanding. No separate transcription model or paid provider has been added; use transcripts or representative still images for those formats. Spreadsheet formulas are not executed; missing cached formula results are omitted. Extraction may lose layout, and AI answers should be checked against the original file.

## Superuser administration

Public signup always creates an ordinary user. An account role is persisted in the database and revalidated on the server; a signup body, email domain, client header, or future signup cannot grant a role.

A trusted local operator can explicitly change the role of an **existing** account:

```powershell
npm run admin:role -- --email existing@example.com --role superuser
# Revoke that role:
npm run admin:role -- --email existing@example.com --role user
```

The command first makes a consistent SQLite backup under private, ignored `.local\backups`. It changes only the role, records a local-operator audit event, and invalidates affected acting-as sessions. It does not create an account, change a password, reserve an email address, or expose a web bootstrap endpoint.

After signing in as a superuser, open **Menu → Users & audit**. Search users, view their **app chat sessions** (not authentication sessions or unrelated Copilot CLI sessions), and choose **Act as user** or **Open as user**. A persistent banner identifies the effective user and the real signed-in actor. **Return to my workspace** stops impersonation. Stop a running reply before switching. Other superusers and nested impersonation are blocked.

The acting target is scoped to the real browser authentication session. Role revocation, expiry/logout, target deletion/promotion, or a changed acting session invalidates delegated access. Generation captures its actor and owner when accepted, rechecks access before model submission and while streaming, and retains accepted partial text in the original chat when access ends. Account-security actions are blocked while acting.

Drafts are autosaved to their owned chat and flushed before chat/user switches. A previously unsaved draft gets a chat rather than being discarded. Existing prompts/replies are appended to, not cleared. Pending files remain attached to their original chat. Refresh/reopen restores saved drafts; network loss or a forced browser/process termination can still interrupt a save, so observe the draft status before leaving.

The audit view records real actor ID, subject ID, action, object ID, time, outcome and a bounded outcome reason. It does not store prompt text, filenames/file contents, authentication tokens or password hashes. Audit records survive account deletion. Ordinary users cannot read the audit or administration endpoints.

## Privacy and security model

**This app is local-only by default, with an optional public shared preview; it is not production hosting.** The explicit temporary-tunnel mode above is the supported remote-access mode. All accounts use the **same host owner's Copilot entitlement and billing allowance**, with separate histories and files. Email addresses are account labels, not verified identities. Email/password signup, login, and logout work locally and through the public link without OTP. There is no Google OAuth, email verification, password reset, recovery service, or GitHub OAuth flow.

- The server binds only to `127.0.0.1`, verifies the exact Host/Origin, rejects cross-site API requests, and requires a same-origin header for mutations. Normal top-level links to the app's homepage are allowed. **Do not expose it through other tunnels, reverse proxies, or the LAN.** Use the explicit tunnel launcher so the remote-access protections are applied. Browser preview surfaces that proxy requests using a different origin can be refused.
- Better Auth hashes passwords, stores sessions server-side, and issues HttpOnly, SameSite=Strict cookies. Cookies are Secure in HTTPS tunnel mode and not Secure only for local loopback HTTP. No auth tokens go in localStorage. The launcher supplies a fixed, unspoofable loopback identity for auth rate limiting, shared by remote sign-in attempts too.
- Every chat, message, draft, demo, attachment, download, rename, delete, and stop operation checks ownership on the server. Ordinary users are isolated; a superuser may explicitly act as a user with auditing. The administrator can therefore access users' chats/files and operate in their workspaces. Files live as BLOBs in SQLite, not under a public web root. Client MIME and paths are never trusted.
- Document parsers run in bounded worker threads. Office archives are inspected before parsing; external file access, macros, and executable payloads are rejected. This is resource isolation, **not** an OS sandbox or a substitute for patched parser dependencies.
- Copilot uses `mode: "empty"`, `availableTools: []`, explicit tool exclusions, and a rejecting permission handler. MCP servers, custom agents/skills/hooks/instructions, host git context, cross-session memory/store, and embedding retrieval are disabled. The app checks the runtime's initialized tool metadata is **empty before sending any prompt**; otherwise it fails closed.
- The model sees only the authorized conversation and extracted files as a JSON data payload. A separate system instruction treats file content as untrusted, not permission grants. No model tools, shell execution, browsing, or arbitrary filesystem access are exposed.
- Prompts, conversation context, extracted file text, and native image attachments are sent to **GitHub Copilot** when you send a message, subject to your plan's policies. Local storage is **not encrypted at rest**. Windows account or backup access can expose it; store only data you are allowed to send and retain.

### Data, backup, and removal

By default `.local/` contains:

- `model-chat.db` (and SQLite WAL/SHM files): accounts, sessions, chats, messages, originals, extracted text.
- `auth-secret`: generated once with cryptographic randomness; keep it with the database when backing up.
- `copilot/`: app-scoped runtime configuration and temporary SDK sessions. Normal completed/cancelled sessions are deleted; a forced OS/process shutdown may leave diagnostic/session remnants here.
- `server.lock`: prevents two app servers from using the same store.

The app now lives in **Downloads**, outside the former OneDrive folder. Private `.local/` data, backups, `.env` files, uploads, runtime state, `node_modules`, build outputs and test artifacts are ignored and must never be pushed to GitHub. The former OneDrive location may retain cloud version-history copies; moving local files cannot erase those.

You may set `MODEL_CHAT_DATA_DIR` to another private nonsynced absolute directory in `.env.local`. Changing that setting selects a different database; it does not itself migrate data. The directory must be outside `public/` and `.next/`.

For a consistent backup, stop the server and copy the complete data directory to a private location. Restore the database **and** its secret together. Deleting a chat removes its app records but not backups or data already processed by Copilot. SQLite `secure_delete` is enabled; WAL, filesystem snapshots, and synced copies can still retain older data. If a crash leaves `server.lock`, the launcher automatically recovers a lock whose recorded process no longer exists; do not remove a live server's lock.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run test:restart
npm run test:tunnel
npm run test:browser
npm audit --omit=dev
```

Focused tests cover ownership on guessed IDs, persistence/reopen/model context, restart-interrupted state, file formats and rejection limits, stream success/cancel/error/output caps, origin checks, and voice feature detection. The restart integration test launches and stops a real production server on port 3212, checks server-side cookies and password login across a restart, checks stored passwords are not plaintext, and verifies file/history recovery. It requires a prior build and cleans up its own temporary data directory.

The tunnel integration test uses port 3213 and synthetic accounts to verify new signup without OTP, existing-account login/logout, invalid credentials, two-account demo isolation, Secure cookies, origin rejection, and local-to-HTTPS redirects. It does not create a real external tunnel or send credentials to Cloudflare.

Browser tests use installed **Microsoft Edge**, create only test accounts in `.local/browser-test-data`, and launch their own loopback server on port 3211. They exercise the two-field signup form, real Better Auth, server ownership, uploads/downloads, chat CRUD, logout/login, desktop/mobile demo menus, draft preservation, separate demo chats, no hidden demo generation, and simulated unsupported/denied microphone behavior. Tests do not make model calls by default.

To include **two small real Copilot requests** (file-grounded streaming, reload, and switching models):

```powershell
$env:MODEL_CHAT_LIVE_TEST = '1'
npm run test:browser
Remove-Item Env:\MODEL_CHAT_LIVE_TEST
```

Browser artifacts are written to `test-results/`. Tests of stream failures use injected runners only in test code; there is no production mock-model switch. The SDK's pinned Zod dependency is overridden to the patched compatible 4.x version in `package.json`; run these checks when upgrading.

For an explicit end-to-end check of the **currently running public tunnel**, `npm run test:public` reads the app-owned `.local/tunnel.json`, creates two uniquely named synthetic accounts, checks signup/login/isolation and desktop/mobile demos, and makes **one real Copilot request** using the sample CSV. It deletes only the accounts it created and their data afterwards. It requires the local database and tunnel to belong to this app; it is not a generic test against third-party URLs. This check is opt-in because it uses the owner's Copilot quota.

## Source map

`components/chat-app.tsx` and `app/globals.css` implement the interface. `app/api/[...segments]/route.ts` handles the API. `lib/auth.ts` owns Better Auth; `lib/signup.ts` validates the short signup payload. `lib/demos.ts` contains synthetic samples and `lib/demo-storage.ts` creates owned, transactional demo chats. `lib/store.ts` owns SQLite and ownership, `lib/context.ts` builds bounded context, `lib/copilot.ts` owns runtime isolation, and `lib/stream.ts` handles durable streaming. `scripts/extract-file.mjs` is the bounded parser worker. `scripts/serve.mjs` is the loopback-bound launcher.

Official references used for this implementation:

- [Copilot authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)
- [Copilot empty mode and isolation](https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md)
- [Copilot bundled runtime](https://github.com/github/copilot-sdk/blob/main/docs/setup/bundled-cli.md)
- [Better Auth installation and SQLite](https://www.better-auth.com/docs/installation)

The implementation is checked against the installed SDK **1.0.28 / runtime 1.0.105** types rather than assuming evolving examples match the installed package.
