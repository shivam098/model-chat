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

While the tunnel runs, a browser on this computer can still open **http://127.0.0.1:3210** directly. That local console is the same app and database with its own sign-in cookie (a session from the link doesn't work there, and vice versa). Owner-only features such as coding mode work only there. Requests that arrive through Cloudflare are never treated as local.

**Keeping the same link across app updates.** After changing code, rebuild and restart only the app; the tunnel keeps running, so the link stays the same:

```powershell
npm run app:update      # waits for streaming replies, stops the app, builds, and starts it behind the same link
npm run app:restart     # the same without rebuilding
```

Both wait for streaming replies to finish (up to 10 minutes); add `-- --force` to interrupt them (partial text is kept). The site is unavailable while the app restarts or builds (typically 1–2 minutes for a build), but the link does not change. Do not run `npm run build` by itself while the app is running: it replaces the files the running server uses. To check a build first without touching the running app, build a candidate (see Verification). If an update's build fails, the app stays stopped and the tunnel keeps the same link; fix the error and run `npm run app:update` again.

`npm run tunnel` also never replaces a running tunnel: it creates a new one only when none is alive. **The link still changes if the tunnel process stops**, for example after a PC restart, sign-out, a cloudflared crash, or Cloudflare dropping the Quick Tunnel; auto-restart (below) then starts a new one, or run `npm run tunnel` again. Quick Tunnels have no uptime guarantee and are for temporary use, not production hosting. Keep the computer awake. The app uses NDJSON rather than SSE for reply streaming; buffering can still depend on the connection.

`npm run tunnel:stop` stops the app and the tunnel (the link becomes invalid) and turns auto-restart off until the next `npm run tunnel`. Run `npm start` afterwards to return to local-only mode. Logs are in `.local/cloudflared.log`, `.local/app.log` and `.local/watchdog.log`.

The launcher uses an app-owned minimal Cloudflare config instead of modifying any existing global tunnel configuration, and disables auto-updates. `.local/tunnel.json` records the active link and its cloudflared process; the app trusts it only while that process is still running, and adopts the link at startup as its exact public origin (`scripts/serve.mjs --tunnel`). Restarts use a graceful stop request (`.local/app-stop.json`) so file processing and streams are checkpointed; a server that does not stop within 45 seconds is ended, and interrupted work is recovered on the next start.

On Windows, cloudflared and the app are started through WMI, so they don't belong to the terminal or app that ran the command. On a Mac they start in their own background session for the same reason. Closing, updating or restarting that terminal or app (for example the Copilot desktop app, which ends every process it started) no longer stops the link. They still stop at sign-out, restart or shutdown. Owner commands and auto-restart take turns using `.local/manager.lock`; a second command waits for the first.

### Auto-restart

```powershell
npm run autorestart:on    # turn on (once); add -- --minutes 10 for a different interval (2-60)
npm run autorestart:off   # turn off; the app and tunnel keep running
```

This registers a per-user Windows scheduled task, **Model Chat auto-restart**. No admin rights are needed. It runs `scripts/tunnel.mjs ensure` hidden (through `wscript` and `scripts/run-hidden.vbs`) when you sign in and every 5 minutes while you're signed in. On a Mac the same command installs a per-user launchd agent, `~/Library/LaunchAgents/com.modelchat.autorestart.plist`, which runs the same check at login and on the same interval. Each check:

- starts the app again if it stopped or stops answering, behind the **same link**;
- starts a new tunnel if cloudflared stopped, moves the app to it, and **publishes the new address to the shareable link**;
- replaces a tunnel whose process is alive but whose link stops answering from the internet, but only after it fails on two checks in a row while this PC can reach the internet. A short blip or an offline PC never changes the link; cloudflared reconnects by itself;
- republishes the shareable link if an earlier publish failed;
- does nothing after `npm run tunnel:stop`, while an owner command such as `app:update` is running, or while a local-only server (`npm start`) uses the data directory.

It logs only changes, to `.local/watchdog.log`. `npm run tunnel:status` shows whether it is on, its last result and next run, and the last event. Measured recovery: an app crash took 22 s after a check; a tunnel crash took 33 s for the new link to answer and 59 s for the shareable page to follow. **Worst case is the check interval plus about a minute.** It runs only while you are signed in to Windows, not before sign-in after a restart. After a PC restart the link comes back after you sign in, with a new address that the shareable page follows. Replies that were streaming when the app stopped are marked interrupted, as after any restart.

### One shareable link (GitHub Pages)

Share **https://shivam098.github.io/model-chat/** instead of the `trycloudflare.com` link. It is a small static page served by GitHub Pages from the `gh-pages` branch of this repository (`main` is not used for it). Each time someone opens it, the page reads the current tunnel link (`link.json`, fetched fresh), checks that Model Chat answers, and forwards them. A plain "open Model Chat" link is shown in case forwarding doesn't happen. If the app can't be reached, the page says so instead of opening a Cloudflare error. It shows the last published link as a fallback and checks again every 15 seconds. After `npm run tunnel:stop` it shows "offline".

- `npm run tunnel` publishes the new link automatically whenever it creates a new tunnel.
- `npm run tunnel:stop` marks the page offline.
- `npm run link:publish` publishes the current state by hand, for example after an automatic publish failed.
- `npm run tunnel:status` shows the shareable address, what it currently opens, and `pointsToCurrent`.

Setup: set `MODEL_CHAT_PAGES_REPO=owner/repository` in `.env.local`; this PC uses `shivam098/model-chat`. Without it, nothing is published.

Publishing uses the GitHub CLI's **stored login of the repository owner** (`gh auth token --user <owner>`, or `MODEL_CHAT_PAGES_ACCOUNT`). The token is held in memory only for the GitHub API calls; it is never passed on a command line or written to disk or output. The active GitHub CLI account is not switched. Commits use the account's noreply address. The first publish creates the `gh-pages` branch and turns on GitHub Pages with HTTPS enforced. A failed automatic publish only prints a warning; the app and tunnel are not affected.

Limitations:

- **A new link takes effect about 20–35 seconds after it is published** (measured 22–33 s), which is how long GitHub Pages takes to deploy. Browser caching does not delay it, because the page fetches `link.json` fresh on every visit.
- **Users must sign in again after the tunnel link changes.** Sign-in cookies belong to each `trycloudflare.com` address.
- **The page doesn't work while the PC, tunnel or app is down.** It only forwards; it can't start anything. If the tunnel stops without `tunnel:stop` (PC restart, sign-out, crash), the page reports "not reachable" until auto-restart publishes a new link (within the check interval plus about a minute while you're signed in), or until someone runs `npm run tunnel`.
- The page and the current tunnel address are public: the `gh-pages` branch of a public repository. The page asks search engines not to index it. Anyone who has it can reach the signup page, the same as with the tunnel link.
- GitHub Pages allows about 10 builds per hour; each new tunnel or stop is one build. The page needs JavaScript.
- For the reachability check, the app answers one constant, read-only request (`/api/link-status`) that only the Pages site may read from another origin. It reads no cookies; every other route keeps its existing Host/Origin checks.

### Copilot sign-in

The backend uses **only this app's own Copilot sign-in**, created with `npm run copilot:login`. It never uses the GitHub CLI's active account, `gh` tokens, or `GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN` variables, so switching or signing out accounts in `gh` does not affect the app. SDK/runtime configuration and sessions are isolated under this app's data directory.

How it works, with the official SDK:

- `copilot login` stores the sign-in in the Windows credential store (Credential Manager). Generation runs in the SDK's `empty` mode, which cannot read that store. A short-lived SDK client in `copilot-cli` mode therefore reads the app's stored sign-in for the configured account through the SDK account API. It never creates a session.
- Its token is passed to generation clients through the SDK's `gitHubToken` option, with logged-in-user fallback off. The runtime also gets an empty, app-owned GitHub CLI config. The token is held in memory only and re-read every 10 minutes or on **Refresh connection**; the app never logs, prints, or writes it.
- Before each model list or reply, the app checks that the runtime resolved the credential to the configured account. Any mismatch blocks the request.

Choose the account in `.env.local`. Otherwise it is the account last signed in with `npm run copilot:login`:

```dotenv
MODEL_CHAT_COPILOT_LOGIN=your-github-login
```

Check the connection and the account in use, without a model call:

```powershell
npm run check:copilot
```

If sign-in is unavailable, or `check:copilot` reports a missing or different account:

```powershell
npm run copilot:login
```

This launches the installed `copilot login` command with an app-specific `COPILOT_HOME`. Sign in as the configured account through its official browser/device flow, then use **Refresh connection** in the app. If `copilot` is not installed, install the official [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) first. The SDK itself bundles the matching runtime for generation. Corporate policy, subscription entitlements, network access, and usage limits still apply.

App users see only a generic "missing or does not match its configured account" message; account names appear only in the owner's `check:copilot` output.

Limitations:
- The credential store entry is per Windows user and per account. Signing that account out with `copilot logout`, in any Copilot CLI on this PC, removes it for the app too. Run `npm run copilot:login` again afterwards.
- The account roster API is marked experimental in SDK 1.0.28 and may change with SDK updates.
- `MODEL_CHAT_COPILOT_HOME` moves the app's Copilot runtime folder; the browser tests use it to share this sign-in.

`npm run test:copilot-account` proves the isolation without changing your real `gh` state. It points the GitHub CLI config at a fake one with a different active account and fake tokens, then checks that the app still lists models as the configured account and that a mismatched account fails. It lists models only and makes no model request.

`npm run check:copilot -- --chat` additionally makes **one small, real, billable model request**. The UI and scripts never produce pretend model answers. Model choices come from `client.listModels()`, filtered by policy and a usable advertised context limit; entries reporting only zero/unknown capacity (including the current Auto routing entry) are omitted rather than inventing a context size. Choices can differ from those in the desktop app. A failed connection, model restriction, empty answer, or exhausted allowance is shown explicitly.

## Running on a Mac

Model Chat runs on macOS too (Apple silicon or Intel), with the same app, data layout and commands. Differences: auto-restart uses a per-user **launchd** agent instead of Task Scheduler; the WSL **code runner** isn't available (the superuser's coding mode runs code instead, with approvals); and coding mode adds **iOS apps** built with Xcode and the iPhone Simulator. The macOS workflow in `.github/workflows/macos.yml` runs the unit tests, the production build, the restart and tunnel tests, the launchd agent and an iOS template app (Simulator build, screenshot and tests) on GitHub's Mac machines for every push.

**Set up (once):**

1. Install **Xcode** from the App Store (free, but a large download). Open it once to accept the licence, then add an iOS Simulator in *Xcode → Settings → Components*.
2. Install [Homebrew](https://brew.sh), then: `brew install node@24 cloudflared xcodegen gh`.
3. `git clone https://github.com/shivam098/model-chat.git && cd model-chat && npm ci`
4. Copilot: `npm run copilot:login` (the sign-in is stored in the Mac's Keychain; allow access if macOS asks), add `MODEL_CHAT_COPILOT_LOGIN=<your login>` to `.env.local`, then `npm run check:copilot`, which must list models.
5. `npm run build`, then `npm start` (this Mac only) or `npm run tunnel` (with the shared link) and `npm run autorestart:on`. `npm run autorestart:off` removes the launchd agent `com.modelchat.autorestart`.
6. Make your account the superuser: sign up at http://127.0.0.1:3210, then `npm run admin:role -- --email you@example.com --role superuser`.
7. Optional media: `python3 -m venv .local/media-venv && .local/media-venv/bin/pip install -r requirements-media.txt`, download a Whisper model once (`.local/media-venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small')"`), then `npm run setup:media -- --python .local/media-venv/bin/python --model small`.

**Check it works:**

- [ ] `npm run check:copilot` lists models, and `npm test` passes.
- [ ] http://127.0.0.1:3210 opens, and you can sign in.
- [ ] Choose **Code → New project → iOS app (SwiftUI)**, then ask "Run it in the Simulator". Approve `./ios.sh run`: the Simulator opens on the Mac and a screenshot appears on the command's card in the chat.
- [ ] Ask "Run the tests". `./ios.sh test` shows `** TEST SUCCEEDED **`.
- [ ] Ask for a change (for example "make the count button green"), approve the diff, and run it again: the new screenshot shows the change.
- [ ] With the link: `npm run tunnel:status` shows the link and `autoRestart.installed: true`.
- [ ] Remote coding (optional): turn on two-step verification in *Account & connection*, run `npm run code:remote -- on --yes`, then sign in through the link with your code. Coding works there, and previews say they're host-only.

**iOS apps: how it works and the limits.** The iOS template is an XcodeGen project (`project.yml`, no hand-edited `.xcodeproj`) with a SwiftUI app, unit tests and `ios.sh` (`build`, `run`, `screenshot`, `test`). It picks an available iPhone simulator, and screenshots go to `.modelchat/screenshots/`, which Model Chat shows in the chat. That's how you see the app when you're away from the Mac; tapping the Simulator from the browser isn't supported. Every command still needs your approval.

- Xcode is a large free install, and the Simulator needs no Apple ID.
- Installing on your own iPhone needs an Apple ID signed in to Xcode (*Xcode → Settings → Accounts*), plus first-time setup at the Mac: connect and trust the iPhone, turn on Developer Mode, and choose your team under *Signing & Capabilities*. Model Chat never asks for, stores or handles Apple ID details. Signing and keychain prompts appear on the Mac's own screen.
- With a free Apple account, apps installed on a device expire after **7 days** (run it again to reinstall).
- Publishing to the App Store or TestFlight needs Apple's paid **Developer Program ($99 a year)**.

## Using it

The layout follows Gemini's: a sidebar of recent conversations (collapse it to an icon rail on desktop; it opens as a drawer from **☰** on phones), **Menu** and your account at its foot, and one large message box. For a new chat the box sits in the middle of the screen with a few starting suggestions; afterwards it stays at the bottom. **+** attaches files, the microphone dictates, and the model picker and Send/Stop sit at the right of the box. Your messages appear as bubbles on the right; replies are plain text with the model's name, and **Read aloud** is the speaker icon under each reply. Message times appear on hover.

Choose a model, type a message, and press Enter (Shift+Enter inserts a line break). Replies stream into the chat; **Stop reply** keeps any received text as an explicitly partial answer. Disconnecting or signing out also cancels the active reply. If the server restarts, unfinished replies are marked interrupted on the next startup.

**Show thinking:** models that support reasoning (24 of the 25 currently offered) are asked for it at **medium** effort with detailed summaries, because without an explicit level the runtime requests none. They think when a question needs it, so short or simple questions often have no thinking. When a reply has thinking, a collapsed **Show thinking** control appears above it. It can be opened while the reply streams, updates live, and is saved with the reply, so it remains after reload. Thinking is the model's own summary as returned by Copilot, capped at 32,000 characters, never invented, and never sent back to the model as conversation context. Image-overflow analysis requests don't show thinking. Reasoning adds some time to replies.

While a reply streams you can keep writing the **next** message: type, attach, drop or paste files, dictate, and change the model. Send (and Enter) stays unavailable in that chat until the reply finishes or you press **Stop reply**; the new draft and files are saved and never join the reply in progress. They are sent together with your next message.

Use the sidebar to start, reopen, rename, or delete conversations. Refreshing, signing out/in, and restarting keep histories in SQLite. Switching models creates a fresh, isolated SDK session (with no tools other than the optional sandboxed code runner below) and sends the same chat's saved context and previously sent file text. No old messages are silently dropped: if the bounded context will not fit, the app asks you to start another chat or choose a larger-context model.

Use the **+** button to upload files. Original bytes are saved in 4 MiB transport parts; after the upload is complete, the server acknowledges it with **202 Accepted** and processes it in a durable background queue. The transport part size is not a total-file limit. Keep chatting, switch conversations/users, or close the browser while accepted files process. File cards show progress, errors, **Cancel processing**, and **Retry processing**. A server restart requeues interrupted processing from the original, not from a partially generated transcript.

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

### Coding mode (superuser, on this computer)

Coding mode lets the model work on a project folder on the computer running Model Chat, like GitHub Copilot's agent: it reads and edits files, runs commands with the machine's own tools (PowerShell, node/npm, python, dotnet, git on Windows), fixes errors and starts apps. It is available only to the **superuser account**, never while acting as another user, and only in a **browser on this computer** at http://127.0.0.1:3210. Through the shared link every coding request is refused and the switch is hidden.

**Start:** choose **Code** in the message box, then create a project (new projects go in `%USERPROFILE%\ModelChatProjects`, or set `MODEL_CHAT_PROJECTS_DIR`) or open an existing folder by its full path. Model Chat's own folder, drive roots, your home folder, system folders and folders containing credential folders can't be opened. Each coding chat is tied to one folder and shows it in the sidebar with a code icon. **Chat** returns to an ordinary chat.

**Output:** each command appears as a card with its live output, each changed file as a card with its diff, and the **Workspace** panel (top right) collects **Changes** (diffs), **Terminal** (all commands and output), **Preview** and **Processes**. Cards, diffs (up to 64,000 characters each) and replies are saved with the chat.

**Approvals:** every command, file change, web fetch and read outside the project shows the exact command, diff or address with **Allow once**, **Allow for this session** (when offered: the same command in this project, file changes in this project, or pages on one site) and **Deny**. Reads inside the project need no approval. A denial is passed to the model, which is told not to retry. Session approvals are kept by Model Chat (the runtime only ever receives one-time approvals) and end with the coding session: after 3 idle hours, an app restart, or deleting the chat.

**Always refused, even if you would approve:** Model Chat's folder and data, `.env` files, `~/.ssh`, `.gnupg`, `.aws`, `.azure`, the GitHub CLI and Copilot configuration, git credentials, `.netrc`, `.npmrc`, `.pypirc`, `.kube`, keychains and Windows credential stores; commands that print tokens (`gh auth token`, `cmdkey`); and detached launches (`Start-Process`, `Start-Job`, `nohup`, `setsid`, a trailing `&`, or the shell tool's `detach`), because Model Chat couldn't list or stop them. These checks are a safety net. **Your approval is the real boundary: an approved command runs with your Windows account's full rights.**

**Secrets:** shells get this computer's normal environment minus secret-looking variables and Model Chat's own settings. The Copilot token goes to the runtime for each coding session over its private connection, not through environment variables, so commands can't read it. `gh` inside coding shells sees an empty, isolated configuration.

**Screenshots:** a command that saves an image in the project's `.modelchat/screenshots/` folder (for example a Simulator screenshot from `./ios.sh run`) shows it on its card. Only PNG, JPEG, GIF and WebP files from that folder are served, after checking their contents.

**Live preview and processes:** ask the model to start a dev server (it runs in the shell's attached background mode on 127.0.0.1). The Preview tab offers the ports it printed, or enter one. The preview opens at a private address such as `http://p-<random>.localhost:3210/`, which proxies the dev server for 12 hours, works only in this computer's browser and can't use Model Chat's sign-in. Hot-reload WebSockets are passed through. The Processes tab lists background commands with **Stop**. They also end when the coding session ends. **Stop reply** cancels the turn, including a command still running in it; background servers keep running until you stop them.

**Audit:** turns, commands, file changes, approvals, refusals, previews and stopped processes are recorded with the actor, with command text and file paths but never file contents.

**Limits:** one turn at a time per chat; a turn stops after 30 minutes without activity or 6 hours in total. Files can't be attached to coding chats (put them in the project). After an app restart a coding chat continues with a recap of its earlier messages, but earlier background processes have stopped. Coding uses the host owner's Copilot quota like any message.

**Remote coding (off by default; keep it off on a managed work PC).** For a computer you own, such as your Mac, the owner can allow coding over the shared link. Run this on the host:

```bash
npm run code:remote -- status
npm run code:remote -- on --yes   # refused until the superuser has two-step verification on
npm run code:remote -- off
```

Even when it's on, every coding request through the link needs the superuser's session to have been **signed in with a two-step verification code** (see "Two-step verification" below). Older sessions, password-only sessions, ordinary accounts and acting are refused. Live previews stay available only in the host's own browser. The switch takes effect immediately and is audited.

### Web search (superuser's own chats by default)

The model can search the web for current information (recent releases, news, prices, schedules) and cite its sources. It uses **GitHub-hosted web search**: the Copilot runtime's built-in GitHub MCP server, with only its `web_search` tool enabled. The search runs on GitHub's servers with the app's Copilot account, so nothing is fetched from this computer and no search API key is needed. It depends on your Copilot plan and policy allowing it.

- **Who:** by default only the superuser, in their own chats. It is never available while acting as another user, and it is decided on the server for every turn. A **Web** chip in the message box shows when it is on; *Account & connection* shows the status.
- **Change it** (local command only, audited):

```powershell
npm run web:search -- status
npm run web:search -- owner            # default: the superuser's own chats
npm run web:search -- everyone --yes   # every signed-in account (each search uses the owner's Copilot entitlement)
npm run web:search -- off
```

- **Sources:** while it searches, the reply shows "Searching the web". Up to 8 clickable sources appear under the reply, with the ones the model cited first. They are saved with the message and survive reload. Links open in a new tab without a referrer. Only plain public `http(s)` addresses are shown; IP addresses, local names and links with embedded credentials are dropped.
- **Cost:** each search adds one follow-up model call that the runtime marks as agent-initiated, and the search results (typically a few hundred to a few thousand tokens) count as input. GitHub documents premium requests as counted per user prompt; check your plan's usage page if this matters.
- **Pasted links:** the model can't open a page. It searches for the link and says it saw only search results, not the full page. A local page fetcher was deliberately not added: on a work computer it would fetch from inside the corporate network, which can't be reliably fenced off.
- **Safety:** every other built-in and GitHub tool stays excluded. If the runtime offers or runs any tool other than `web_search` (or `run_python` when the code runner is set up), the reply stops with a safety error. Web results are treated as untrusted data. Chats without web search keep the "cannot browse" instruction and say so.
- **Audit:** each reply that searched records `web.search` with the actor, subject, chat and the number of searches, never the query text.
- Provider-native search (the model vendor's own hosted search) isn't available with this SDK and account, so it isn't used.

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

Open **Menu → How Model Chat works & Demos** from the foot of the sidebar (on phones, open the sidebar with **☰** first). The guide is also available before signing in; launching a sample requires an account.

Three examples are provided: **Explore a sample budget** (small synthetic CSV), **Draft a friendly update**, and **Make a concept click**. A single **Load example draft** action creates a new, independent chat, saves a ready-to-edit prompt, and attaches the sample CSV when applicable. It preserves the current conversation and saves its unsent draft before switching, including a draft that did not yet have a chat. The operation is transactional; limits or ownership failures do not partially replace an old chat.

**Loading is not generation.** No model request or canned assistant answer is produced by opening a demo. Review the prompt and press Send to use the real selected model. Drafts are autosaved and flushed before switching. They survive reopening/refresh and are cleared once their prompt is accepted into message history. Samples contain no personal data, and each account gets its own chats and file records.

## Boundaries and limits

| Item | Supported scope |
|---|---|
| Text | `.txt`, `.md`, `.csv`, `.json`; UTF-8 only; syntax is treated as text |
| Additional text | `.log`, `.yaml`, `.yml`, `.xml`; treated as UTF-8 data, never executed |
| Native images | PNG, JPEG, WebP, static GIF up to 268 megapixels and 65,535 pixels per side (covers 200 MP phone photos and wide panoramas); EXIF orientation applied; the model gets a JPEG copy at most 2048 pixels on its longest side, the original is kept; requires a vision model. See "Large images" below |
| Audio | MP3, WAV, M4A, AAC, FLAC, OGG and OPUS; local machine transcript with approximate timestamps |
| Video | MP4, MOV, WEBM, MKV and AVI with decodable streams; speech transcript plus up to 4 sampled JPEG frames; requires a vision model |
| PDF | Selectable text; page markers included; isolated parser memory budget applies |
| Word | `.docx` document text; no formatting, images, comments, macros, or embedded objects |
| Excel | `.xlsx`; sheet/cell markers and cached formula values; isolated archive/parser memory budget applies |
| Files | No preset total byte, duration, extracted-text, or per-message file-count cap; all selected files included via labeled excerpts within a shared 60,000-byte file/analysis budget and remaining model context |
| Storage | Actual host disk capacity, with a 1 GiB reserve/write-overhead allowance; at most 100 chats / 100 turns per chat |
| Messages | 8,000 input characters; 32,000 output characters; full context capped at 100,000 UTF-8 bytes and a conservative model-specific budget |
| Processing | One document lane, 512 MB JS worker heap; archive preflight: 2,000 entries, bounded compression ratio, expanded size within available-memory/128 MiB safety budget; no overall deadline |
| Media processing | One local worker; bounded-memory audio windows, no duration/deadline cutoff; video up to 8K (8,192 pixels on the longest side, 36 megapixels), decoded one frame at a time; up to 4 sampled frames, each at most 512 KB |
| Generation | One reply per account/actor, two per app; sequential overflow-analysis requests stay inside that reply slot; four-minute deadline per model request, cancellable as one turn |

Images use the official SDK's native base64 blob attachments. Original bytes remain in owned SQLite storage; current images use the existing normalized model-input representation. Legacy images remain unchanged. Model-specific MIME, per-request count and byte limits are checked. Prior images use retained evidence instead of consuming the new turn's image allowance. Cancelling or losing delegated access stops all remaining analysis/synthesis requests, keeps accepted chat history, and preserves only completed authorized analyses.

### Large images

Uploads are decoded in the background in an isolated worker, one image at a time. The header is checked before any pixels are decoded:

- **Size:** at most 268 megapixels (16,383 x 16,383, libvips' own default) and 65,535 pixels per side, the most JPEG, PNG and GIF can store. Phones top out at about 200 MP, and panoramas such as 60,000 x 4,000 fit.
- **Memory:** baseline JPEG and ordinary PNG are decoded in strips, and JPEG shrinks while decoding. Progressive JPEG, interlaced PNG, WebP and GIF must be decoded all at once, so their estimated decode memory must stay under 1 GB, or a quarter of free memory if that is lower.
- **Decompression bombs:** above 16 MP, a file that would expand to more than 4,096 times its size is rejected. Photos expand tens of times and flat screenshots rarely reach 1,000 times; crafted files expand far more.
- **Time:** decoding stops after 2 minutes.

Measured on this PC (whole process, including about 125 MB for Node.js):

| Image | Time | Peak memory |
|---|---|---|
| 48 MP baseline JPEG | 1.5 s | 0.23 GB |
| 200 MP baseline JPEG | 1.6 s | 0.22 GB |
| 268 MP PNG | 5 s | 0.57 GB |
| 60,000 x 4,000 PNG panorama | 2.6 s | 0.84 GB |
| 268 MP progressive JPEG | 2.4 s | 1.0 GB |

Rejections say what is wrong and what to do, for example "export a smaller copy" or "export it again as JPEG". Library error text is never shown.

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

### Two-step verification (superuser)

The superuser can turn on two-step verification in **Account & connection → Two-step verification**. Enter your password, add the shown key to an authenticator app (for example Microsoft Authenticator: *Add account → Other account → Enter code manually*, or **Open in an authenticator app** on a phone), and enter the 6-digit code it shows. Ten one-time **backup codes** are shown once; save them somewhere safe. There is no QR code, to avoid adding a dependency.

From then on, signing in to that account asks for a code after the password (or **Use a backup code**). A password alone creates no session. Wrong codes are rate-limited, and the account locks for 15 minutes after 10 failed codes. Sessions created by a verified code are recorded, and only those count for remote coding. Turning it off needs the password and replaces the current session. Ordinary accounts can't turn it on (the server refuses), and the setting can't be changed while acting as a user. Changes are audited.

## Privacy and security model

**This app is local-only by default, with an optional public shared preview; it is not production hosting.** The explicit temporary-tunnel mode above is the supported remote-access mode. All accounts use the **same host owner's Copilot entitlement and billing allowance**, with separate histories and files. Email addresses are account labels, not verified identities. Email/password signup, login, and logout work locally and through the public link without OTP. The superuser can optionally add two-step verification with an authenticator app (required for remote coding). There is no Google OAuth, email verification, password reset, recovery service, or GitHub OAuth flow.

- The server binds only to `127.0.0.1`, verifies the exact Host/Origin, rejects cross-site API requests, and requires a same-origin header for mutations. Normal top-level links to the app's homepage are allowed. **Do not expose it through other tunnels, reverse proxies, or the LAN.** Use the explicit tunnel launcher so the remote-access protections are applied. Browser preview surfaces that proxy requests using a different origin can be refused.
- Better Auth hashes passwords, stores sessions server-side, and issues HttpOnly, SameSite=Strict cookies. Cookies are Secure in HTTPS tunnel mode and not Secure only for local loopback HTTP. No auth tokens go in localStorage. The launcher supplies a fixed, unspoofable loopback identity for auth rate limiting, shared by remote sign-in attempts too.
- Every chat, message, draft, demo, attachment, download, rename, delete, and stop operation checks ownership on the server. Ordinary users are isolated; a superuser may explicitly act as a user with auditing. The administrator can therefore access users' chats/files and operate in their workspaces. Files live as BLOBs in SQLite, not under a public web root. Client MIME and paths are never trusted.
- Document parsers run in bounded-memory worker threads. Office archives are inspected before parsing; external file access, macros, and executable payloads are rejected. Media runs in a cancellable Python child process with offline model loading, fixed decoder formats, bounded audio windows/frame dimensions and periodic authorization checks. Neither mechanism is an OS sandbox or a substitute for patched parser dependencies.
- Copilot uses `mode: "empty"`, explicit `builtin:*`/`mcp:*` exclusions and no MCP servers, custom agents, skills, hooks, instructions, host git context, cross-session memory/store or embedding retrieval. Without the code runner, `availableTools` is empty and `custom:*` is excluded too. With it, the allow-list is exactly `custom:run_python`. The permission handler approves only that tool and rejects every shell, read, write, URL, MCP and unknown request; `approveAll` is never used. Before sending any prompt, the app checks the runtime's initialized tool list is exactly that set (or empty), and fails closed otherwise. **Web search** is the one MCP exception: for chats where it is enabled, the runtime's built-in GitHub MCP server is started with only its `web_search` toolset, `availableTools` adds exactly `mcp:web_search`, `builtin:*` stays excluded, and the app re-checks the tool list when the server's tools load and stops the reply if any other tool appears or runs.
- The model sees only the authorized conversation and extracted files as a JSON data payload. A separate system instruction treats file content as untrusted, not permission grants. In ordinary chats it cannot run a shell, open web pages, or access the host filesystem; where web search is enabled it can only search through GitHub's hosted tool, and results are treated as untrusted data. The optional `run_python` tool executes only inside the offline WSL sandbox described above; code induced by uploaded content is contained by that sandbox. **Coding mode** is the one exception: a separate superuser-only session on this computer with the shell and file tools, where every action goes through the approvals described in "Coding mode". Ordinary chats never get those tools.
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

The tunnel integration test uses port 3213 and synthetic accounts to verify new signup without OTP, existing-account login/logout, invalid credentials, two-account demo isolation, Secure cookies, origin rejection, and HTTPS redirects for the public host. It checks that this computer's own browser gets a separate local console (non-Secure cookie on loopback; neither session works on the other origin), and that coding endpoints work there for the superuser but are refused through the tunnel (even with a forged local marker) and for ordinary accounts. With remote coding switched on it walks the two-step flow: ordinary accounts can't enable it, a password-only or older session is refused, a wrong code fails, a code-verified session can code through the link, and switching remote coding or two-step verification off refuses it again. `tests/browser/two-factor.spec.ts` covers the same setup, code sign-in, backup code and turn-off in the browser without model calls. It also checks that the app refuses a stale, forged, old-format or other-port tunnel status file, and that only the shareable-link page's origin can read the constant `/api/link-status` reply while every other route still rejects it. It does not create a real external tunnel or send credentials to Cloudflare. The browser suite also serves `link-page/` locally and checks that the shareable-link page forwards only to an exact `https://<name>.trycloudflare.com` origin, shows "offline" or "not reachable" instead of forwarding to an error, re-checks automatically, and never contacts any other address. `tests/stable-link.test.ts` checks that publishing rejects every other URL before using any GitHub login. `tests/watchdog.test.ts` checks the auto-restart decisions: what it restarts, that it leaves a stopped link or a local-only server alone, and that it replaces a live tunnel only after repeated failures while the internet works.

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

To capture every screen (sign-in, empty chat, conversation with thinking and sources, generated files, attachments, streaming, menu, demos, account with the light theme, users and audit, acting as a user, the shareable-link page and, when `MODEL_CHAT_PROJECTS_DIR` is set, a coding chat with an approval, a diff and terminal output) at desktop and mobile size for a design review, set a folder and run the opt-in harness. It seeds synthetic data in the isolated test database (the coding project is an empty folder it creates under `MODEL_CHAT_PROJECTS_DIR`), uses a fixed display list of model names, and makes no model calls:

```powershell
$env:UI_SCREENS_DIR = "$HOME\Downloads\model-chat-screens"
$env:MODEL_CHAT_PROJECTS_DIR = "$env:LOCALAPPDATA\model-chat-screens-projects"
npx playwright test tests/browser/ui-screens.spec.ts
Remove-Item Env:\UI_SCREENS_DIR, Env:\MODEL_CHAT_PROJECTS_DIR
```

For an explicit end-to-end check of the **currently running public tunnel**, `npm run test:public` reads the app-owned `.local/tunnel.json`, creates two uniquely named synthetic accounts, checks signup/login/isolation and desktop/mobile demos, and makes **one real Copilot request** using the sample CSV. It deletes only the accounts it created and their data afterwards. It requires the local database and tunnel to belong to this app; it is not a generic test against third-party URLs. This check is opt-in because it uses the owner's Copilot quota.

`npm run test:multifile:public` is a separate opt-in check making **two real model requests**: one overflow-image analysis plus one combined answer using six mixed files and a discovered one-image vision model. It verifies image/text evidence, owned saved analyses, reload/mobile layout and account isolation, then removes its exact synthetic accounts. The ordinary browser suite makes no model calls and covers concurrent transfers, removing queued/pending files, multi-selection, drag/drop, pasted images, explicit text-only sending and the complete file-ID submission. Unit tests cover subsequent image turns/model changes without reanalysis, video-frame batching, cancellation/revocation and additive migration.

`npm run test:sandbox` runs real jobs in the WSL sandbox and makes no model calls. It runs these escape and abuse tests: TCP/UDP/DNS/curl network access, `/mnt/c` and WSL host mounts, executing `cmd.exe`/`powershell.exe` (inside and outside the jail), other runs' files and processes, symlink/hardlink/FIFO/device outputs, fork bombs, memory exhaustion, CPU and wall-clock loops, oversized files, full scratch space, too many outputs, and pip/apt installs. It also checks cancellation process-tree cleanup and real PDF/PNG/GIF/MP4/DOCX/XLSX/PPTX generation. The browser suite renders real sandbox outputs as previews on desktop/mobile and checks headers, the PDF viewer, HTML/SVG download-only handling, Range requests and privacy. `npm run test:runner:public` is opt-in and makes **two real Copilot turns** through the running HTTPS link. The owner turn generates all seven formats; the second turn is made by a superuser acting as that owner. Set `MODEL_CHAT_RUNNER_PART=acting` to run only the superuser-acting turn (one Copilot turn). It checks previews, cross-account denial and content-free actor/subject audit entries, then deletes only its synthetic accounts.

`npm run test:composer:public` is opt-in and makes **two real Copilot replies** through the running HTTPS link with the lowest-cost listed models. It starts a long reply; while it streams (on a mobile-sized window) it types, presses Enter, attaches a file, changes the model and tries dictation, checks Send is unavailable, then presses **Stop reply**. It then sends the queued draft and checks the reply uses the mid-reply file, which belongs only to the new turn, and that another account cannot read it. It deletes only its synthetic accounts.

## Source map

`components/code-mode.tsx`, `lib/coding/` and `lib/preview-proxy.mjs` implement coding mode (UI cards and panel; access guard, approval policy, blocked paths, the coding session manager, routes and previews). `tests/coding-mode.test.ts` covers the policy, path rules, access guard and shell environment without model calls. `tests/browser/coding.spec.ts` is an opt-in real run from this computer's browser (one Copilot turn; it creates files, starts a server and stops it in a temporary projects folder):

```powershell
$env:MODEL_CHAT_CODING_E2E = '1'; $env:MODEL_CHAT_PROJECTS_DIR = "$env:TEMP\model-chat-e2e"; New-Item -ItemType Directory -Force $env:MODEL_CHAT_PROJECTS_DIR
npx playwright test tests/browser/coding.spec.ts
Remove-Item Env:\MODEL_CHAT_CODING_E2E, Env:\MODEL_CHAT_PROJECTS_DIR
```

`lib/web-search.ts` decides who gets web search, holds its instruction and turns results into safe, saved sources; `scripts/web-search.mjs` is the owner command. `tests/web-search.test.ts` covers the session config, access rules and sources without model calls. `tests/browser/web-search.spec.ts` is an opt-in real run (about four Copilot turns) against a candidate build:

```powershell
$env:MODEL_CHAT_CANDIDATE_BUILD = '1'; npm run build
$env:MODEL_CHAT_WEB_E2E = '1'; npx playwright test tests/browser/web-search.spec.ts
Remove-Item Env:\MODEL_CHAT_WEB_E2E, Env:\MODEL_CHAT_CANDIDATE_BUILD
```

`components/chat-app.tsx` and `app/globals.css` implement the interface; `components/lamp-light.tsx` is the lamp-light effect, `lib/theme.ts` the per-browser theme choice and `lib/render-tier.ts` the GPU check that slows effects on software rendering. `tests/browser/theme.spec.ts` covers the dark default, the remembered light choice and when the effect stays still. `app/api/[...segments]/route.ts` handles the API. `lib/auth.ts` owns Better Auth; `lib/signup.ts` validates the short signup payload. `lib/demos.ts` contains synthetic samples and `lib/demo-storage.ts` creates owned, transactional demo chats. `lib/store.ts` owns SQLite and ownership, `lib/context.ts` builds bounded context, `lib/copilot.ts` owns runtime isolation, and `lib/stream.ts` handles durable streaming. `scripts/extract-file.mjs` is the document/image worker; `lib/media.ts` and `scripts/media-worker.py` handle local recordings. `sandbox/run-job.py` is the root-owned WSL runner, `scripts/setup-sandbox.mjs` the owner-only setup, `lib/sandbox.ts` the framed bridge and `lib/code-tool.ts` the `run_python` tool. `scripts/serve.mjs` is the loopback-bound launcher; `scripts/tunnel.mjs` manages the separate Quick Tunnel and app processes and the auto-restart check (`lib/watchdog.mjs` decides what to repair). `link-page/` is the shareable-link page (not `pages/`, which Next.js would treat as routes) and `lib/stable-link.mjs` publishes it.

Official references used for this implementation:

- [Copilot authentication](https://github.com/github/copilot-sdk/blob/main/docs/auth/authenticate.md)
- [Copilot empty mode and isolation](https://github.com/github/copilot-sdk/blob/main/docs/setup/multi-tenancy.md)
- [Copilot bundled runtime](https://github.com/github/copilot-sdk/blob/main/docs/setup/bundled-cli.md)
- [Copilot native image input and model limits](https://github.com/github/copilot-sdk/blob/main/docs/features/image-input.md)
- [Better Auth installation and SQLite](https://www.better-auth.com/docs/installation)

The implementation is checked against the installed SDK **1.0.28 / runtime 1.0.105** types rather than assuming evolving examples match the installed package.

### Design and fonts

The interface was redesigned following the [unslop](https://github.com/heydamir/unslop) process by Damir Sokolovsky (CC BY 4.0); no files from it are included. It uses a near-grey palette with one green accent, a 4px spacing grid, and model names in monospace on each reply. The layout (sidebar rail, centred message box, right-aligned bubbles, plain replies, "Show thinking") takes its structure from Google's Gemini app while keeping these colours and typefaces. The typefaces are self-hosted in `app/fonts` and loaded with `next/font/local`, so pages make no requests to font services: [Instrument Sans](https://github.com/Instrument/instrument-sans) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), both under the SIL Open Font License (licence texts are next to the files). They are Latin subsets converted to WOFF2 (about 75 KB together).

**Dark by default.** The palette is a writing desk at night under a green banker's lamp. Text meets WCAG AA contrast on every surface (the lowest pair, secondary text on raised surfaces, is 5.0:1), and the browser's `color-scheme` is dark, so form controls and scrollbars match. *Account & connection → Appearance* switches to the original light palette; the choice is stored in that browser only (`localStorage`, not the account), and a small script in `<head>` applies it before the first paint. The shareable link page (`link-page/`) is dark too.

**Effects** (CSS and one canvas; no libraries, no remote assets):
- *Lamp light* on the sign-in and new-chat screens: a soft green light follows the pointer, with faint dust drifting through it. Text areas stay free of dust, and the light sits behind all content.
- While the model works, a thin light runs around the message box.
- Reply text fades in block by block as it streams, with a small lamp-green ember at the end; "Thinking" shimmers and its icon pulses until the answer starts.
- With *reduced motion* requested by the system, on phones and touch screens, and on low-power devices (2 cores or less, 2 GB or less, or Data Saver), the lamp is drawn once and stays still, and CSS animations stop. Nothing animates in a hidden tab.
- On computers that draw without a GPU (virtual machines, Remote Desktop, detected by WebGL refusing a hardware context), the lamp renders at half resolution, follows the pointer at about 20 frames a second, drifts at 8 and settles completely 8 seconds after the pointer stops; the caret stops pulsing and the ring steps 8 times a second.

Measured on the host PC (a 32-core Hyper-V VM without a GPU; Edge renders with SwiftShader), as browser CPU in % of one core, against about 1% for the same screens with reduced motion: lamp in the first seconds after loading 13 to 21%, idle once settled 0.3 to 1.1%, while the pointer moves 58 to 81%; a reply in progress 16% (2% with reduced motion). No long tasks were recorded. Machines with a GPU weren't measured here. To measure on a Windows computer: `$env:MODEL_CHAT_EFFECTS_PERF = '1'; $env:EFFECTS_HEADED = '1'; npx playwright test tests/browser/effects.spec.ts` (no model calls; set `MODEL_CHAT_CANDIDATE_BUILD=1` after a candidate build). It also saves frames of the lamp following a pointer.
