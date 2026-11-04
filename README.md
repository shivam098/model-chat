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

For temporary remote access without a domain or Cloudflare account, install the official `cloudflared` CLI and stop any local-only app server (`npm start`). Then:

```powershell
npm run build
npm run tunnel          # start the link (or reuse the running one) and the app behind it
npm run tunnel:status   # show the current link, process IDs and whether the public site responds
```

`npm run tunnel` starts a Cloudflare Quick Tunnel and the app as **two separate background processes**, verifies the remote access policy, and prints an `https://....trycloudflare.com` link. You can close the terminal afterwards. Anyone who opens the link can sign up with an email and password or sign in to an existing account. **Public signup is intentionally open, without OTP. Every account's model requests use the host owner's Copilot entitlement and quota.** HTTPS redirects, Secure cookies, HSTS, and exact public Host/Origin checks remain enabled; the backend still binds only to loopback.

This is an internet-facing signup/login page protected by **app passwords**, not Cloudflare Access. Use a strong unique password, not your Gmail password. Sharing the link permits others to create accounts and consume the owner's Copilot quota and local disk space. Signup/login rate limits, transfer/processing concurrency guards, and generation concurrency limits remain, but there is no per-account file-storage quota or guaranteed billing cap. Cloudflare relays and terminates HTTPS traffic. No password recovery service is configured.

**Keeping the same link across app updates.** After changing code, rebuild and restart only the app; the tunnel keeps running, so the link stays the same:

```powershell
npm run app:update      # waits for streaming replies, stops the app, builds, and starts it behind the same link
npm run app:restart     # the same without rebuilding
```

Both wait for streaming replies to finish (up to 10 minutes); add `-- --force` to interrupt them (partial text is kept). The site is unavailable while the app restarts or builds (typically 1–2 minutes for a build), but the link does not change. Do not run `npm run build` by itself while the app is running: it replaces the files the running server uses. To check a build first without touching the running app, build a candidate (see Verification). If an update's build fails, the app stays stopped and the tunnel keeps the same link; fix the error and run `npm run app:update` again.

`npm run tunnel` also never replaces a running tunnel: it creates a new one only when none is alive. **The link still changes if the tunnel process stops**, for example after a PC restart, sign-out, a cloudflared crash, or Cloudflare dropping the Quick Tunnel; run `npm run tunnel` again to get a new link. Quick Tunnels have no uptime guarantee and are for temporary use, not production hosting. Keep the computer awake. The app uses NDJSON rather than SSE for reply streaming; buffering can still depend on the connection.

`npm run tunnel:stop` stops the app and the tunnel (the link becomes invalid). Run `npm start` afterwards to return to local-only mode. Logs are in `.local/cloudflared.log` and `.local/app.log`.

The launcher uses an app-owned minimal Cloudflare config instead of modifying any existing global tunnel configuration, and disables auto-updates. `.local/tunnel.json` records the active link and its cloudflared process; the app trusts it only while that process is still running, and adopts the link at startup as its exact public origin (`scripts/serve.mjs --tunnel`). Restarts use a graceful stop request (`.local/app-stop.json`) so file processing and streams are checkpointed; a server that does not stop within 45 seconds is ended, and interrupted work is recovered on the next start.

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

`npm run check:copilot -- --chat` additionally makes **one small, real, billable model request**. The UI and scripts never produce pretend model answers. Model choices come from `client.listModels()`, filtered by policy and a usable advertised context limit; entries reporting only zero/unknown capacity (including the current Auto routing entry) are omitted rather than inventing a context size. Choices can differ from those in the desktop app. A failed connection, model restriction, empty answer, or exhausted allowance is shown explicitly.

## Using it

Choose a model, type a message, and press Enter (Shift+Enter inserts a line break). Replies stream into the chat; **Stop reply** keeps any received text as an explicitly partial answer. Disconnecting or signing out also cancels the active reply. If the server restarts, unfinished replies are marked interrupted on the next startup.

While a reply streams you can keep writing the **next** message: type, attach, drop or paste files, dictate, and change the model. Send (and Enter) stays unavailable in that chat until the reply finishes or you press **Stop reply**; the new draft and files are saved and never join the reply in progress. They are sent together with your next message.

Use the sidebar to start, reopen, rename, or delete conversations. Refreshing, signing out/in, and restarting keep histories in SQLite. Switching models creates a fresh, isolated SDK session (with no tools other than the optional sandboxed code runner below) and sends the same chat's saved context and previously sent file text. No old messages are silently dropped: if the bounded context will not fit, the app asks you to start another chat or choose a larger-context model.

Use the paperclip to upload files. Original bytes are saved in 4 MiB transport parts; after the upload is complete, the server acknowledges it with **202 Accepted** and processes it in a durable background queue. The transport part size is not a total-file limit. Keep chatting, switch conversations/users, or close the browser while accepted files process. File cards show progress, errors, **Cancel processing**, and **Retry processing**. A server restart requeues interrupted processing from the original, not from a partially generated transcript.

Select several mixed supported files at once, add more before sending, drag files onto the composer, or paste images. Up to three files transfer concurrently per account (six app-wide); individual progress and removal controls are shown. **Send includes every attached file**, with no four-file holdback. Unfinished/failed files must finish or be retried/removed; the separate **Send text only** action explicitly leaves all pending files for later. Upload/extraction itself makes no Copilot requests. Unsent files and drafts survive reloads. Original downloads are streamed; extracted text is paged through the eye icon. Large files are indexed in full, but model requests use **labeled relevant or representative excerpts**, with space allocated after conversation/history overhead. Full text and originals are not truncated.

**Multiple images and extra usage:** the selected model's image limit applies to each request, not the chat's lifetime. Current-message images take priority. If they exceed that limit, overflow images are analyzed in additional real, sequential Copilot requests (batched within the model's allowance), without collages or further thumbnailing. One final reply combines the supplied pixels, saved analyses and all file excerpts. The UI shows the additional-request count and processing stage. Turns within the limit make no extra analysis requests. Each completed overflow image/frame analysis is retained privately with its source ID and model, and reused after reload or model changes. Earlier images are represented honestly by saved AI analyses or prior conversation, not silently resent or claimed to be re-viewed. Reattach an original for a fresh pixel inspection. AI descriptions can omit or misread details; they are not lossless substitutes for originals. Video samples count as images. Non-vision models still reject newly attached images.

**Dictation** is browser speech recognition, not a realtime audio conversation. Click Dictate, acknowledge the privacy notice, allow microphone access, then review the transcript before sending. Browser support varies. Permission denial, missing microphones, and unsupported browsers leave text input usable. **Read aloud** uses browser speech synthesis and can be stopped. Actual microphone accuracy and available voices depend on your browser and device; browser services may process audio online.

### Code runner: PDFs, charts, animations and Office files

When the host owner has set it up, any signed-in user (and a superuser acting as a user) can ask for things such as "make a PDF report", "chart this CSV", "animate this as a GIF/MP4", or a Word/Excel/PowerPoint file. The model writes a Python program and calls the app's single custom tool, `run_python`. The program runs in a **disposable Linux sandbox on this computer**, and its output files are attached to the reply as owned downloads. PNG/JPEG/GIF/WebP images and MP4/WebM videos preview inline; PDFs open in the browser's PDF viewer. Every other type, including HTML and SVG, is download-only. The model can pass this chat's own sent or generated files as inputs, read errors and retry (up to 8 runs per reply).

**What the sandbox cannot do:** it has **no internet or network access** (no sockets or DNS beyond an isolated loopback). It cannot install packages during a chat, see Windows drives or programs, launch `cmd.exe`/`powershell.exe`, reach this app, its database, other chats, other users or earlier runs. Generated code can still be wrong, so check important results. Tool use counts against the host owner's Copilot quota like any message.

Preinstalled: Python 3.12, numpy, pandas, matplotlib, seaborn, scipy, Pillow, reportlab, fpdf2, python-docx, openpyxl, XlsxWriter, python-pptx, pypdf, imageio, lxml and the `ffmpeg` command for GIF/MP4. Limits per run: about 180 seconds of wall time and 300 seconds of CPU time, 2 CPUs, 2 GB memory, 256 processes/threads, 1 GB scratch space, 32 input files/384 MB in, 20 output files/256 MB out (200 MB per file). One run per account/actor and two app-wide can run at once.

How it works: a dedicated WSL distribution, `ModelChatSandbox` (Ubuntu 24.04), stored in `.local\wsl-sandbox`. Its `/etc/wsl.conf` disables Windows drive automount, Windows interop and Windows PATH. A root-owned runner creates a fresh size-limited, `noexec` tmpfs workspace and a cgroup (memory, CPU, process limits) for each run. The runner hides WSL host/GPU mounts in a private mount namespace and starts the program as an unprivileged per-slot user inside bubblewrap. Bubblewrap provides new user, PID, IPC, UTS and **network** namespaces, a read-only system and root, dropped capabilities and a cleared environment. Only the chat files the model selects are copied in, read-only. Only regular files with one link are copied out; symlinks, hard links, FIFOs and devices are rejected, and types, counts and sizes are checked. Stored types are derived by the app from file contents, and Windows executables/scripts are rejected. Timeout, cancellation, logout or permission revocation kills the whole process tree, and the workspace is deleted. Outputs count toward the disk reserve. Audit entries record run start/finish/outcome and generated file IDs with actor and subject, never code or file contents.

Owner-only setup (installs or repairs the distro, libraries and runner; uses the network only during setup). It needs WSL 2 but no admin rights when WSL is already enabled:

```powershell
npm run setup:sandbox
npm run setup:sandbox -- --status
# Add libraries later (local command only; never available from the web UI):
npm run setup:sandbox -- --add-apt python3-sympy
npm run setup:sandbox -- --add-pip "tabulate==0.9.0"
```

Setup does not change `.wslconfig` or other distributions. It restarts only `ModelChatSandbox`, and only when its isolation settings change; replacing the runner or adding libraries while the app is running does not interrupt the distro. Because it was the first WSL distribution on this PC, `ModelChatSandbox` became the default for a bare `wsl` command; its default login is the unprivileged `modelchat` user. Install your own distribution and run `wsl --set-default <name>` if you want a different default. To remove the code runner, stop the app, then run `wsl --unregister ModelChatSandbox` and delete `.local\sandbox-config.json`. Without that file the app offers no tool at all. Set `MODEL_CHAT_DISABLE_SANDBOX=1` to switch it off temporarily.

### Local audio/video uploads

Uploaded recordings use a separate **local** processing path: faster-whisper transcribes speech on the host CPU, and PyAV decodes media using its bundled FFmpeg libraries. Video also produces up to four timestamped JPEG samples. Copilot receives the transcript and sampled images when you press Send, not raw native audio/video. Use a vision-capable model for videos. Transcription and frame extraction do not themselves make Copilot model requests.

This machine already has Python 3.12, faster-whisper 1.2.1, PyAV 18, and a complete cached `large-v3-turbo` model. Configure the app to reuse them:

```powershell
npm run setup:media
# Alternatively, select an already-cached smaller model or a particular Python:
npm run setup:media -- --model small
npm run setup:media -- --python "C:\path\to\python.exe" --model large-v3-turbo
```

Setup performs an **offline-only** model lookup and writes private `.local\media-config.json`. It does not download models or modify the global Python installation. If the required packages are absent on another machine, install `requirements-media.txt` into an app-local virtual environment using your approved package index, obtain model weights through an approved source, and pass that interpreter/model to setup. No speech API key, extra cloud provider, Torch, or standalone FFmpeg executable is needed.

Use the eye icon on an attachment to inspect its extracted transcript before sending. One media worker and one document worker run at a time; other files wait in the durable queue. **There is no preset total upload-size limit, media-duration limit, or overall processing deadline.** Speech is decoded/transcribed in approximately 30-second windows with a small overlap to keep memory bounded. Long recordings can take a long time, but do not block the chat UI. Actual disk capacity is checked with a 1 GiB safety reserve and write-overhead allowance; codecs, parser memory, and model context are still finite.

Accepted owner uploads may finish after logout. Administrator-created delegated jobs retain their original subject even when the admin returns to their own workspace; they stop if the admin's session/role ends or the subject is deleted/promoted. Cancelled or failed complete uploads retain their original bytes for download/retry. Incomplete transfers cannot be processed: remove the entry and upload again. Normal worker completion/cancellation cleans its private scratch directory. A forced OS/process termination can leave private scratch remnants. Whisper uses cached local weights, several GB of RAM, and substantial CPU.

Machine transcripts can mishear or miss speech. Audio without speech is reported as such, not analyzed for arbitrary sound effects. Video frames are sparse samples, not continuous motion understanding; important events between frames may be missed. Public-link uploads still pass through Cloudflare even though transcription runs locally. Original files, transcripts and frames remain private app data, subject to administrator access and the same ownership/audit rules as other attachments.

### How Model Chat works & Demos

Open **Menu → How Model Chat works & Demos** from the hamburger button on desktop or mobile. The guide is also available before signing in; launching a sample requires an account.

Three examples are provided: **Explore a sample budget** (small synthetic CSV), **Draft a friendly update**, and **Make a concept click**. A single **Load example draft** action creates a new, independent chat, saves a ready-to-edit prompt, and attaches the sample CSV when applicable. It preserves the current conversation and saves its unsent draft before switching, including a draft that did not yet have a chat. The operation is transactional; limits or ownership failures do not partially replace an old chat.

**Loading is not generation.** No model request or canned assistant answer is produced by opening a demo. Review the prompt and press Send to use the real selected model. Drafts are autosaved and flushed before switching. They survive reopening/refresh and are cleared once their prompt is accepted into message history. Samples contain no personal data, and each account gets its own chats and file records.

## Boundaries and limits

| Item | Supported scope |
|---|---|
| Text | `.txt`, `.md`, `.csv`, `.json`; UTF-8 only; syntax is treated as text |
| Additional text | `.log`, `.yaml`, `.yml`, `.xml`; treated as UTF-8 data, never executed |
| Native images | PNG, JPEG, WebP, static GIF; decoded-image safety limit 16 megapixels / 8192 pixels per dimension; normalized JPEG for model input; requires a vision model |
| Audio | MP3, WAV, M4A, AAC, FLAC, OGG and OPUS; local machine transcript with approximate timestamps |
| Video | MP4, MOV, WEBM, MKV and AVI with decodable streams; speech transcript plus up to 4 sampled JPEG frames; requires a vision model |
| PDF | Selectable text; page markers included; isolated parser memory budget applies |
| Word | `.docx` document text; no formatting, images, comments, macros, or embedded objects |
| Excel | `.xlsx`; sheet/cell markers and cached formula values; isolated archive/parser memory budget applies |
| Files | No preset total byte, duration, extracted-text, or per-message file-count cap; all selected files included via labeled excerpts within a shared 60,000-byte file/analysis budget and remaining model context |
| Storage | Actual host disk capacity, with a 1 GiB reserve/write-overhead allowance; at most 100 chats / 100 turns per chat |
| Messages | 8,000 input characters; 32,000 output characters; full context capped at 100,000 UTF-8 bytes and a conservative model-specific budget |
| Processing | One document lane, 512 MB JS worker heap; archive preflight: 2,000 entries, bounded compression ratio, expanded size within available-memory/128 MiB safety budget; no overall deadline |
| Media processing | One local worker; bounded-memory audio windows, no duration/deadline cutoff; video dimensions at most 4096 / 16 MP; up to 4 sampled frames, each at most 512 KB |
| Generation | One reply per account/actor, two per app; sequential overflow-analysis requests stay inside that reply slot; four-minute deadline per model request, cancellable as one turn |

Images use the official SDK's native base64 blob attachments. Original bytes remain in owned SQLite storage; current images use the existing normalized model-input representation. Legacy images remain unchanged. Model-specific MIME, per-request count and byte limits are checked. Prior images use retained evidence instead of consuming the new turn's image allowance. Cancelling or losing delegated access stops all remaining analysis/synthesis requests, keeps accepted chat history, and preserves only completed authorized analyses.

Scanned PDFs need OCR, which is **not** included. Password-protected documents, executable/ZIP uploads, network playlists, legacy `.doc`/`.xls`, charts and animated images are **not** supported. Media containers/codecs must be decodable by the installed PyAV. Files are never executed, and decoding disallows network protocols and external media references. The installed Copilot SDK's native input is still images; the app now supplies local transcripts and sampled video frames for audio/video files. Spreadsheet formulas are not executed; missing cached formula results are omitted. Extraction may lose information, so check answers against the original.

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

`npm run backup` creates a consistent SQLite snapshot and a content-free row-count/hash manifest in `.local\backups`. To verify that an additive migration preserved all original columns, run `node scripts/backup-db.mjs --verify "<path-to-preservation.json>"` before resuming user traffic. Role changes intentionally affect the added role column, not existing password/history fields.

## Privacy and security model

**This app is local-only by default, with an optional public shared preview; it is not production hosting.** The explicit temporary-tunnel mode above is the supported remote-access mode. All accounts use the **same host owner's Copilot entitlement and billing allowance**, with separate histories and files. Email addresses are account labels, not verified identities. Email/password signup, login, and logout work locally and through the public link without OTP. There is no Google OAuth, email verification, password reset, recovery service, or GitHub OAuth flow.

- The server binds only to `127.0.0.1`, verifies the exact Host/Origin, rejects cross-site API requests, and requires a same-origin header for mutations. Normal top-level links to the app's homepage are allowed. **Do not expose it through other tunnels, reverse proxies, or the LAN.** Use the explicit tunnel launcher so the remote-access protections are applied. Browser preview surfaces that proxy requests using a different origin can be refused.
- Better Auth hashes passwords, stores sessions server-side, and issues HttpOnly, SameSite=Strict cookies. Cookies are Secure in HTTPS tunnel mode and not Secure only for local loopback HTTP. No auth tokens go in localStorage. The launcher supplies a fixed, unspoofable loopback identity for auth rate limiting, shared by remote sign-in attempts too.
- Every chat, message, draft, demo, attachment, download, rename, delete, and stop operation checks ownership on the server. Ordinary users are isolated; a superuser may explicitly act as a user with auditing. The administrator can therefore access users' chats/files and operate in their workspaces. Files live as BLOBs in SQLite, not under a public web root. Client MIME and paths are never trusted.
- Document parsers run in bounded-memory worker threads. Office archives are inspected before parsing; external file access, macros, and executable payloads are rejected. Media runs in a cancellable Python child process with offline model loading, fixed decoder formats, bounded audio windows/frame dimensions and periodic authorization checks. Neither mechanism is an OS sandbox or a substitute for patched parser dependencies.
- Copilot uses `mode: "empty"`, explicit `builtin:*`/`mcp:*` exclusions and no MCP servers, custom agents, skills, hooks, instructions, host git context, cross-session memory/store or embedding retrieval. Without the code runner, `availableTools` is empty and `custom:*` is excluded too. With it, the allow-list is exactly `custom:run_python`. The permission handler approves only that tool and rejects every shell, read, write, URL, MCP and unknown request; `approveAll` is never used. Before sending any prompt, the app checks the runtime's initialized tool list is exactly that set (or empty), and fails closed otherwise.
- The model sees only the authorized conversation and extracted files as a JSON data payload. A separate system instruction treats file content as untrusted, not permission grants. It cannot run a shell, browse, or access the host filesystem. The optional `run_python` tool executes only inside the offline WSL sandbox described above; code induced by uploaded content is contained by that sandbox.
- Prompts, conversation context, extracted file text, and native image attachments are sent to **GitHub Copilot** when you send a message, subject to your plan's policies. Local storage is **not encrypted at rest**. Windows account or backup access can expose it; store only data you are allowed to send and retain.

### Data, backup, and removal

By default `.local/` contains:

- `model-chat.db` (and SQLite WAL/SHM files): accounts, sessions, chats, messages, original upload chunks, durable jobs, indexed full extracted text, images/frames and audit records. Legacy BLOBs/tables are preserved by additive migrations.
- `auth-secret`: generated once with cryptographic randomness; keep it with the database when backing up.
- `copilot/`: app-scoped runtime configuration and temporary SDK sessions. Normal completed/cancelled sessions are deleted; a forced OS/process shutdown may leave diagnostic/session remnants here.
- `server.lock`: prevents two app servers from using the same store.
- `media-config.json`: local Python/model paths and detected versions; never committed.
- `processing/`: per-job private temporary media directories, removed on normal completion/cancellation.

The app now lives in **Downloads**, outside the former OneDrive folder. Private `.local/` data, backups, `.env` files, uploads, runtime state, `node_modules`, build outputs and test artifacts are ignored and must never be pushed to GitHub. The former OneDrive location may retain cloud version-history copies; moving local files cannot erase those.

You may set `MODEL_CHAT_DATA_DIR` to another private nonsynced absolute directory in `.env.local`. Changing that setting selects a different database; it does not itself migrate data. The directory must be outside `public/`, `.next/`, and `.next-candidate/`.

For a consistent backup, stop the server and copy the complete data directory to a private location. Restore the database **and** its secret together. Deleting a chat removes its app records but not backups or data already processed by Copilot. SQLite `secure_delete` is enabled; WAL, filesystem snapshots, and synced copies can still retain older data. If a crash leaves `server.lock`, the launcher automatically recovers a lock whose recorded process no longer exists; do not remove a live server's lock.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run test:restart
npm run test:tunnel
npm run test:browser
npm run test:media
npm run test:sandbox
```

To build and validate without replacing an active server's bundles, set `$env:MODEL_CHAT_CANDIDATE_BUILD='1'` before build/test commands. This uses ignored `.next-candidate`; normal startup uses `.next`. Only promote a validated build after stopping the server and making a consistent backup. Use an organization-approved package registry for any dependency/audit network access.

Focused tests cover ownership on guessed IDs, persistence/reopen/model context, restart-interrupted state, file formats and rejection limits, stream success/cancel/error/output caps, origin checks, and voice feature detection. The restart integration test launches and stops a real production server on port 3212, checks server-side cookies and password login across a restart, checks stored passwords are not plaintext, and verifies file/history recovery. It requires a prior build and cleans up its own temporary data directory.

The tunnel integration test uses port 3213 and synthetic accounts to verify new signup without OTP, existing-account login/logout, invalid credentials, two-account demo isolation, Secure cookies, origin rejection, and local-to-HTTPS redirects. It also checks that the app refuses a stale, forged, old-format or other-port tunnel status file. It does not create a real external tunnel or send credentials to Cloudflare.

`npm run test:media` uses the configured local Whisper runtime and Windows' installed speech synthesizer to generate and transcribe synthetic WAV/MP3/video fixtures. It checks real words, silent video sampling, limits, cancellation, revoked access, owned storage and reopen behavior. It does not call Copilot or use user uploads. To add real media upload/preview/cancellation checks to the browser flow:

```powershell
$env:MODEL_CHAT_MEDIA_TEST = '1'
npm run test:browser -- --grep "accounts, ownership"
Remove-Item Env:\MODEL_CHAT_MEDIA_TEST
```

Additionally setting `MODEL_CHAT_MEDIA_LIVE_TEST=1` makes one explicit Copilot request in that browser check to verify a response is grounded in both the machine transcript and sampled frames. It consumes the host owner's Copilot quota.

Browser tests use installed **Microsoft Edge**, create test accounts in a unique `.local/browser-test-<id>` directory, and launch their own loopback server on port 3211. They exercise the two-field signup form, real Better Auth, server ownership, uploads/downloads, chat CRUD, logout/login, desktop/mobile demo menus, draft preservation, separate demo chats, no hidden demo generation, and simulated unsupported/denied microphone behavior. Tests do not make model calls by default.

The same browser flow also checks superuser search, acting/return, original-history preservation, per-user drafts, auditing, native image uploads, and role revocation. A separate browser test seeds a streaming reply in the isolated test database (no model call) and checks, on desktop and mobile and while a superuser acts as the user, that typing, picker/paste/drop uploads, removal, dictation and model choice keep working, Enter and Send do not send mid-reply, the draft and files survive a reload, and the next Send contains only the new files. Set `MODEL_CHAT_ADMIN_LIVE_TEST=1` and run `npm run test:browser -- --grep "accounts, ownership"` to additionally make **one real native-image request while acting as a user** and verify the reply stays in that user's chat. Synthetic roles exist only in the isolated test database.

To include **two small real Copilot requests** (file-grounded streaming, reload, and switching models):

```powershell
$env:MODEL_CHAT_LIVE_TEST = '1'
npm run test:browser
Remove-Item Env:\MODEL_CHAT_LIVE_TEST
```

Browser artifacts are written to `test-results/`. Tests of stream failures use injected runners only in test code; there is no production mock-model switch. The SDK's pinned Zod dependency is overridden to the patched compatible 4.x version in `package.json`; run these checks when upgrading.

For an explicit end-to-end check of the **currently running public tunnel**, `npm run test:public` reads the app-owned `.local/tunnel.json`, creates two uniquely named synthetic accounts, checks signup/login/isolation and desktop/mobile demos, and makes **one real Copilot request** using the sample CSV. It deletes only the accounts it created and their data afterwards. It requires the local database and tunnel to belong to this app; it is not a generic test against third-party URLs. This check is opt-in because it uses the owner's Copilot quota.

`npm run test:multifile:public` is a separate opt-in check making **two real model requests**: one overflow-image analysis plus one combined answer using six mixed files and a discovered one-image vision model. It verifies image/text evidence, owned saved analyses, reload/mobile layout and account isolation, then removes its exact synthetic accounts. The ordinary browser suite makes no model calls and covers concurrent transfers, removing queued/pending files, multi-selection, drag/drop, pasted images, explicit text-only sending and the complete file-ID submission. Unit tests cover subsequent image turns/model changes without reanalysis, video-frame batching, cancellation/revocation and additive migration.

`npm run test:sandbox` runs real jobs in the WSL sandbox and makes no model calls. It runs these escape and abuse tests: TCP/UDP/DNS/curl network access, `/mnt/c` and WSL host mounts, executing `cmd.exe`/`powershell.exe` (inside and outside the jail), other runs' files and processes, symlink/hardlink/FIFO/device outputs, fork bombs, memory exhaustion, CPU and wall-clock loops, oversized files, full scratch space, too many outputs, and pip/apt installs. It also checks cancellation process-tree cleanup and real PDF/PNG/GIF/MP4/DOCX/XLSX/PPTX generation. The browser suite renders real sandbox outputs as previews on desktop/mobile and checks headers, the PDF viewer, HTML/SVG download-only handling, Range requests and privacy. `npm run test:runner:public` is opt-in and makes **two real Copilot turns** through the running HTTPS link. The owner turn generates all seven formats; the second turn is made by a superuser acting as that owner. Set `MODEL_CHAT_RUNNER_PART=acting` to run only the superuser-acting turn (one Copilot turn). It checks previews, cross-account denial and content-free actor/subject audit entries, then deletes only its synthetic accounts.

`npm run test:composer:public` is opt-in and makes **two real Copilot replies** through the running HTTPS link with the lowest-cost listed models. It starts a long reply; while it streams (on a mobile-sized window) it types, presses Enter, attaches a file, changes the model and tries dictation, checks Send is unavailable, then presses **Stop reply**. It then sends the queued draft and checks the reply uses the mid-reply file, which belongs only to the new turn, and that another account cannot read it. It deletes only its synthetic accounts.

## Source map

`components/chat-app.tsx` and `app/globals.css` implement the interface. `app/api/[...segments]/route.ts` handles the API. `lib/auth.ts` owns Better Auth; `lib/signup.ts` validates the short signup payload. `lib/demos.ts` contains synthetic samples and `lib/demo-storage.ts` creates owned, transactional demo chats. `lib/store.ts` owns SQLite and ownership, `lib/context.ts` builds bounded context, `lib/copilot.ts` owns runtime isolation, and `lib/stream.ts` handles durable streaming. `scripts/extract-file.mjs` is the document/image worker; `lib/media.ts` and `scripts/media-worker.py` handle local recordings. `sandbox/run-job.py` is the root-owned WSL runner, `scripts/setup-sandbox.mjs` the owner-only setup, `lib/sandbox.ts` the framed bridge and `lib/code-tool.ts` the `run_python` tool. `scripts/serve.mjs` is the loopback-bound launcher; `scripts/tunnel.mjs` manages the separate Quick Tunnel and app processes.

Official references used for this implementation:

- [Copilot authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)
- [Copilot empty mode and isolation](https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md)
- [Copilot bundled runtime](https://github.com/github/copilot-sdk/blob/main/docs/setup/bundled-cli.md)
- [Copilot native image input and model limits](https://github.com/github/copilot-sdk/blob/main/docs/features/image-input.md)
- [Better Auth installation and SQLite](https://www.better-auth.com/docs/installation)

The implementation is checked against the installed SDK **1.0.28 / runtime 1.0.105** types rather than assuming evolving examples match the installed package.
