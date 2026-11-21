"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Activity, Ban, Check, ExternalLink, FileDiff, FolderOpen, FolderPlus, Globe, LoaderCircle, RefreshCw, ShieldAlert, Square, Terminal, X } from "lucide-react";
import type { CodeEvent } from "@/lib/contracts";

export interface CodingStatus { available: boolean; reason: string | null; via: string; remoteEnabled: boolean; twoFactorEnabled: boolean; secondFactorVerified: boolean; platform: string; projectsRoot: string | null; localUrl: string }
export type Decision = "once" | "session" | "deny";
export type PanelTab = "changes" | "terminal" | "preview" | "processes";
type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
type Approval = { id: string; kind: "command" | "write" | "read" | "url"; subject: string; intention?: string; outside?: boolean; warning?: string; sessionScope?: string; state: string };
type Process = { id: string; command: string; description: string; status: string; startedAt: string; completedAt: string | null; pid: number | null };

const LABELS: Record<string, string> = { running: "Running", "awaiting approval": "Needs approval", done: "Done", failed: "Failed", denied: "Denied", blocked: "Blocked", started: "Running in background", stopped: "Stopped" };
const text = (value: unknown) => typeof value === "string" ? value : "";
const problem = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
export const folderName = (value?: string | null) => (value || "").split(/[\\/]/).filter(Boolean).pop() || "project";

/** Merges a streamed card update into the chat's saved cards. */
export function mergeCodeEvent(list: CodeEvent[], event: CodeEvent) {
  const next = list.some(item => item.id === event.id) ? list.map(item => item.id === event.id ? event : item) : [...list, event];
  return next.sort((a, b) => a.seq - b.seq);
}
// Without a live coding session (for example after a restart) nothing can still be running or waiting.
function statusOf(event: CodeEvent, live: boolean) {
  const status = text(event.data.status) || "running";
  return !live && ["running", "started", "awaiting approval"].includes(status) ? "stopped" : status;
}
function Badge({ status }: { status: string }) {
  return <span className={`code-status ${status.replace(/\s+/g, "-")}`}>{(status === "running" || status === "started") && <LoaderCircle className="spin" size={12} />}{LABELS[status] || status}</span>;
}
export function Diff({ diff }: { diff: string }) {
  const lines = diff.split(/\r?\n/);
  return <pre className="code-diff">{lines.slice(0, 2000).map((line, index) => <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : undefined}>{line || " "}{"\n"}</span>)}{lines.length > 2000 && <span className="hunk">… {lines.length - 2000} more lines</span>}</pre>;
}
function ApprovalBox({ approval, deciding, onDecide }: { approval: Approval; deciding: boolean; onDecide: (id: string, decision: Decision) => void }) {
  const title = approval.kind === "command" ? "Run this command?" : approval.kind === "write" ? "Apply this file change?" : approval.kind === "url" ? "Fetch this address?" : "Read a file outside the project?";
  return <div className="approval" role="group" aria-label={title}>
    <strong><ShieldAlert size={16} /> {title}</strong>
    {approval.intention && <p>{approval.intention}</p>}
    {approval.kind !== "command" && approval.kind !== "write" && <code className="approval-subject">{approval.subject}</code>}
    {approval.outside && <p className="approval-warning">This is outside the project folder.</p>}
    {approval.warning && <p className="approval-warning">{approval.warning}</p>}
    <div className="approval-actions">
      <button type="button" className="allow" disabled={deciding} onClick={() => onDecide(approval.id, "once")}><Check size={16} /> Allow once</button>
      {approval.sessionScope && <button type="button" disabled={deciding} title={`Allow ${approval.sessionScope} until this coding session ends`} onClick={() => onDecide(approval.id, "session")}>Allow for this session</button>}
      <button type="button" className="deny" disabled={deciding} onClick={() => onDecide(approval.id, "deny")}><Ban size={16} /> Deny</button>
    </div>
    {approval.sessionScope && <small>“For this session” covers {approval.sessionScope}.</small>}
  </div>;
}

export function CodeCard({ event, live, deciding, showImages = true, onDecide }: { event: CodeEvent; live: boolean; deciding: boolean; showImages?: boolean; onDecide: (id: string, decision: Decision) => void }) {
  const status = statusOf(event, live);
  const approval = event.data.approval as Approval | undefined;
  const asking = approval?.state === "pending" && status === "awaiting approval";
  const blocked = text(event.data.blockedReason);
  const error = text(event.data.error);
  if (event.kind === "command") {
    const output = text(event.data.output);
    const images = Array.isArray(event.data.images) ? (event.data.images as unknown[]).filter((item): item is string => typeof item === "string") : [];
    return <div className={`code-card ${asking ? "asking" : ""}`}>
      <div className="code-card-head"><Terminal size={16} aria-hidden="true" /><code className="code-command">{text(event.data.command) || "Command"}</code><Badge status={status} /></div>
      {blocked && <p className="code-blocked">{blocked}</p>}
      {asking && <ApprovalBox approval={approval!} deciding={deciding} onDecide={onDecide} />}
      {images.length > 0 && (showImages ? <div className="code-shots">{images.map(name => {
        const source = `/api/code/chats/${event.chatId}/screenshots/${encodeURIComponent(name)}`;
        return <a key={name} href={source} target="_blank" rel="noopener noreferrer" title={`Open ${name}`}><img src={source} alt={`Screenshot ${name}`} loading="lazy" /></a>;
      })}</div> : <p className="code-blocked muted">Screenshots ({images.length}) can be viewed where coding mode is available.</p>)}
      {output && <details className="code-output" open={status === "running" || status === "failed" || undefined}><summary>Output</summary><pre>{output.length > 8000 ? `…\n${output.slice(-8000)}` : output}</pre></details>}
    </div>;
  }
  if (event.kind === "file") {
    const diff = text(event.data.diff);
    return <div className={`code-card ${asking ? "asking" : ""}`}>
      <div className="code-card-head"><FileDiff size={16} aria-hidden="true" /><span className="code-path">{text(event.data.action) || (asking ? "Change" : "Changed")} <code>{text(event.data.path) || "a file"}</code></span><Badge status={status} /></div>
      {blocked && <p className="code-blocked">{blocked}</p>}
      {error && <p className="code-blocked">{error}</p>}
      {asking && <ApprovalBox approval={approval!} deciding={deciding} onDecide={onDecide} />}
      {diff && <details className="code-output" open={asking || undefined}><summary>Diff</summary><Diff diff={diff} /></details>}
    </div>;
  }
  return <div className={`code-card tool ${asking ? "asking" : ""}`}>
    <div className="code-card-head">{text(event.data.tool) === "web_fetch" ? <Globe size={16} aria-hidden="true" /> : <Activity size={16} aria-hidden="true" />}<span className="code-path">{text(event.data.summary) || text(event.data.tool) || "Tool"}</span><Badge status={status} /></div>
    {blocked && <p className="code-blocked">{blocked}</p>}
    {error && <p className="code-blocked">{error}</p>}
    {asking && <ApprovalBox approval={approval!} deciding={deciding} onDecide={onDecide} />}
  </div>;
}

export function CodePanel({ chatId, project, events, live, tab, appPort, remote, api, onTab, onClose, onChanged, onError }: {
  chatId: string; project: string; events: CodeEvent[]; live: boolean; tab: PanelTab; appPort: string; remote: boolean; api: Api;
  onTab: (tab: PanelTab) => void; onClose: () => void; onChanged: () => void; onError: (error: unknown) => void;
}) {
  const [processes, setProcesses] = useState<Process[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [preview, setPreview] = useState<{ url: string; port: number } | null>(null);
  const [opening, setOpening] = useState(false);
  const [frame, setFrame] = useState(0);
  const files = events.filter(event => event.kind === "file" && (text(event.data.diff) || text(event.data.path)));
  const commands = events.filter(event => event.kind === "command");
  const ports = useMemo(() => {
    const found = new Set<number>();
    for (const command of events) for (const match of text(command.data.output).matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d{4,5})/g)) {
      const value = Number(match[1]);
      if (value !== Number(appPort)) found.add(value);
    }
    return [...found].slice(-6);
  }, [events, appPort]);
  async function loadProcesses() {
    setLoading(true);
    try { setProcesses((await api<{ processes: Process[] }>(`/api/code/chats/${chatId}/processes`)).processes); }
    catch (error) { onError(error); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    if (tab !== "processes") return;
    void loadProcesses();
    const timer = setInterval(() => void loadProcesses(), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, chatId]);
  async function stop(id: string) {
    setStopping(id);
    try { await api(`/api/code/chats/${chatId}/processes/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }); await loadProcesses(); onChanged(); }
    catch (error) { onError(error); }
    finally { setStopping(null); }
  }
  async function open(value: number) {
    setOpening(true);
    try { setPreview(await api<{ url: string; port: number }>(`/api/code/chats/${chatId}/previews`, { method: "POST", body: JSON.stringify({ port: value }) })); setFrame(key => key + 1); }
    catch (error) { onError(error); }
    finally { setOpening(false); }
  }
  const submitPort = (event: FormEvent) => { event.preventDefault(); const value = Number(port); if (value) void open(value); };
  const tabs: [PanelTab, string, number | null][] = [["changes", "Changes", files.length], ["terminal", "Terminal", commands.length], ["preview", "Preview", null], ["processes", "Processes", null]];
  return <aside className="code-panel" aria-label="Project workspace">
    <div className="code-panel-head">
      <span className="code-panel-title" title={project}><FolderOpen size={16} aria-hidden="true" /><span>{folderName(project)}</span></span>
      <button type="button" className="icon-button" aria-label="Close workspace panel" title="Close workspace panel" onClick={onClose}><X size={18} /></button>
    </div>
    <div className="code-tabs" role="tablist" aria-label="Workspace">
      {tabs.map(([id, label, count]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => onTab(id)}>{label}{count ? <small>{count}</small> : null}</button>)}
    </div>
    <div className="code-panel-body" role="tabpanel">
      {tab === "changes" && (files.length ? files.slice().reverse().map(event => <section className="panel-item" key={event.id}>
        <header><FileDiff size={16} aria-hidden="true" /><code>{text(event.data.path) || "a file"}</code><Badge status={statusOf(event, live)} /></header>
        {text(event.data.diff) ? <Diff diff={text(event.data.diff)} /> : <p className="panel-empty">No diff was reported for this change.</p>}
      </section>) : <p className="panel-empty">File changes in this chat appear here as diffs.</p>)}
      {tab === "terminal" && (commands.length ? commands.map(event => <section className="panel-item" key={event.id}>
        <header><Terminal size={16} aria-hidden="true" /><code>{text(event.data.command)}</code><Badge status={statusOf(event, live)} /></header>
        {text(event.data.output) && <pre className="terminal-output">{text(event.data.output)}</pre>}
      </section>) : <p className="panel-empty">Commands and their output appear here.</p>)}
      {tab === "preview" && (remote ? <p className="panel-empty">Previews open only in a browser on the computer running Model Chat, so they aren&apos;t available over the shared link. Ask the model for test output or screenshots instead.</p> : <div className="preview-pane">
        {ports.length > 0 && <div className="preview-ports">{ports.map(value => <button key={value} type="button" className="secondary-button" disabled={opening} onClick={() => void open(value)}><Globe size={16} /> Port {value}</button>)}</div>}
        <form className="preview-form" onSubmit={submitPort}>
          <label htmlFor="preview-port">Dev server port</label>
          <input id="preview-port" inputMode="numeric" pattern="[0-9]*" placeholder="5173" value={port} onChange={event => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))} />
          <button type="submit" className="secondary-button" disabled={!port || opening}>{opening ? <LoaderCircle className="spin" size={16} /> : <Globe size={16} />} Open preview</button>
        </form>
        {preview ? <>
          <div className="preview-bar"><span>Port {preview.port}</span>
            <button type="button" className="icon-button" aria-label="Reload preview" title="Reload preview" onClick={() => setFrame(key => key + 1)}><RefreshCw size={16} /></button>
            <a className="icon-button" aria-label="Open preview in a new tab" title="Open in a new tab" href={preview.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /></a>
          </div>
          <iframe key={frame} className="preview-frame" title={`Preview of port ${preview.port}`} src={preview.url} sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals" />
        </> : <p className="panel-empty">Previews show a dev server running on this computer, through a private address only this browser can open. Ask the model to start one, then pick its port.</p>}
      </div>)}
      {tab === "processes" && <div>
        <div className="preview-bar"><span>Background commands</span><button type="button" className="icon-button" aria-label="Refresh processes" title="Refresh" disabled={loading} onClick={() => void loadProcesses()}><RefreshCw size={16} /></button></div>
        {!live && <p className="panel-empty">No coding session is running for this chat, so nothing is running in the background.</p>}
        {live && processes && !processes.length && <p className="panel-empty">Nothing is running in the background.</p>}
        {live && processes?.map(item => <section className="panel-item" key={item.id}>
          <header><Terminal size={16} aria-hidden="true" /><code>{item.command}</code><Badge status={item.status === "running" ? "started" : item.status === "completed" ? "done" : item.status} /></header>
          {item.status === "running" && <button type="button" className="secondary-button" disabled={stopping === item.id} onClick={() => void stop(item.id)}><Square size={14} fill="currentColor" /> Stop</button>}
        </section>)}
      </div>}
    </div>
  </aside>;
}

export function ProjectPicker({ api, root, platform, onOpen }: { api: Api; root: string | null; platform?: string; onOpen: (chat: import("@/lib/contracts").Chat) => void }) {
  const [projects, setProjects] = useState<{ name: string; path: string }[] | null>(null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<"empty" | "ios">("empty");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ root: string; projects: { name: string; path: string }[] }>("/api/code/projects")
      .then(result => { if (alive) setProjects(result.projects); })
      .catch(cause => { if (alive) setError(problem(cause)); });
    return () => { alive = false; };
    // Load once per dialog; `api` changes identity on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function open(projectPath: string) {
    setWorking(true); setError("");
    try { onOpen((await api<{ chat: import("@/lib/contracts").Chat }>("/api/code/chats", { method: "POST", body: JSON.stringify({ projectPath }) })).chat); }
    catch (cause) { setError(problem(cause)); }
    finally { setWorking(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setWorking(true); setError("");
    try { const created = await api<{ path: string }>("/api/code/projects", { method: "POST", body: JSON.stringify({ name, template }) }); setWorking(false); await open(created.path); }
    catch (cause) { setError(problem(cause)); setWorking(false); }
  }
  return <div className="project-picker">
    <p>The model works in one folder on this computer. It can read files there; every command and file change waits for your approval. Model Chat&apos;s own data, .env files and credentials are always off limits.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <h3>Projects{root ? <small title={root}> in {root}</small> : null}</h3>
    {!projects ? <p className="panel-empty"><LoaderCircle className="spin" size={16} /> Loading projects…</p>
      : projects.length ? <div className="project-list">{projects.slice(0, 12).map(item => <button key={item.path} type="button" disabled={working} title={item.path} onClick={() => void open(item.path)}><FolderOpen size={16} /><span>{item.name}</span></button>)}</div>
        : <p className="panel-empty">No projects yet. Create one below.</p>}
    <form className="project-form" onSubmit={create}>
      <label htmlFor="project-name">New project</label>
      <div><input id="project-name" placeholder="my-app" value={name} maxLength={64} onChange={event => setName(event.target.value)} />
        {platform === "darwin" && <select aria-label="Project template" value={template} onChange={event => setTemplate(event.target.value as "empty" | "ios")}>
          <option value="empty">Empty folder</option>
          <option value="ios">iOS app (SwiftUI)</option>
        </select>}
        <button type="submit" className="secondary-button" disabled={working || !name.trim()}><FolderPlus size={16} /> Create</button></div>
      {template === "ios" && <small className="project-note">A SwiftUI app with tests, built with Xcode and XcodeGen. Run it in the iPhone Simulator from the chat; screenshots appear there.</small>}
    </form>
    <form className="project-form" onSubmit={event => { event.preventDefault(); void open(folder.trim()); }}>
      <label htmlFor="project-folder">Or open an existing folder</label>
      <div><input id="project-folder" placeholder="Full path of an existing folder" value={folder} maxLength={1024} onChange={event => setFolder(event.target.value)} />
        <button type="submit" className="secondary-button" disabled={working || !folder.trim()}><FolderOpen size={16} /> Open</button></div>
    </form>
  </div>;
}

/** Optional superuser two-step verification: authenticator-app codes plus one-time backup codes. */
export function TwoFactorSettings({ status, api, onChanged }: { status: CodingStatus; api: Api; onChanged: () => void }) {
  const [step, setStep] = useState<"idle" | "password-on" | "scan" | "codes" | "password-off">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setWorking(true); setError("");
    try { await action(); } catch (cause) { setError(problem(cause)); } finally { setWorking(false); }
  };
  const start = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    const result = await api<{ totpURI: string; backupCodes: string[] }>("/api/auth/two-factor/enable", { method: "POST", body: JSON.stringify({ password }) });
    setSetup({ uri: result.totpURI, secret: new URL(result.totpURI).searchParams.get("secret") || "", backupCodes: result.backupCodes });
    setPassword(""); setCode(""); setStep("scan");
  }); };
  const confirm = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    await api("/api/auth/two-factor/verify-totp", { method: "POST", body: JSON.stringify({ code: code.replace(/\s/g, "") }) });
    setCode(""); setStep("codes"); onChanged();
  }); };
  const turnOff = (event: FormEvent) => { event.preventDefault(); void run(async () => {
    await api("/api/auth/two-factor/disable", { method: "POST", body: JSON.stringify({ password }) });
    setPassword(""); setStep("idle"); onChanged();
  }); };
  const passwordForm = (label: string, onSubmit: (event: FormEvent) => void) => <form className="project-form" onSubmit={onSubmit}>
    <label htmlFor="two-factor-password">Your Model Chat password</label>
    <div><input id="two-factor-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={128} />
      <button type="submit" className="secondary-button" disabled={working || !password}>{working ? <LoaderCircle className="spin" size={16} /> : null}{label}</button></div>
  </form>;
  return <div className="two-factor">
    {error && <p className="auth-error" role="alert">{error}</p>}
    {step === "scan" && setup ? <>
      <p>In your authenticator app (for example Microsoft Authenticator: <strong>Add account → Other account → Enter code manually</strong>), add <strong>Model Chat</strong> with this key:</p>
      <code className="totp-key" aria-label="Setup key">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code>
      <p><a href={setup.uri}>Open in an authenticator app</a> (on a phone with one installed).</p>
      <form className="project-form" onSubmit={confirm}>
        <label htmlFor="two-factor-code">Then enter the 6-digit code it shows</label>
        <div><input id="two-factor-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} required maxLength={12} placeholder="123456" />
          <button type="submit" className="secondary-button" disabled={working || !code.trim()}>Turn on</button></div>
      </form>
    </> : step === "codes" && setup ? <>
      <p><strong>Two-step verification is on.</strong> Save these backup codes somewhere safe. Each one signs you in once if you lose your phone. They won&apos;t be shown again.</p>
      <ol className="backup-codes">{setup.backupCodes.map(item => <li key={item}><code>{item}</code></li>)}</ol>
      <div className="approval-actions">
        <button type="button" onClick={() => void navigator.clipboard?.writeText(setup.backupCodes.join("\n")).then(() => setCopied(true))}>{copied ? "Copied" : "Copy codes"}</button>
        <button type="button" onClick={() => { setSetup(null); setStep("idle"); }}>Done</button>
      </div>
    </> : status.twoFactorEnabled ? <>
      <p>Two-step verification is <strong>on</strong>: signing in to this account asks for a code from your authenticator app.</p>
      {step === "password-off" ? passwordForm("Turn off", turnOff) : <button type="button" className="secondary-button" onClick={() => { setStep("password-off"); setError(""); }}>Turn off two-step verification</button>}
    </> : <>
      <p>Two-step verification is <strong>off</strong>. Turn it on to require a code from an authenticator app each time this account signs in. It&apos;s optional.</p>
      {step === "password-on" ? passwordForm("Continue", start) : <button type="button" className="secondary-button" onClick={() => { setStep("password-on"); setError(""); }}>Turn on two-step verification</button>}
    </>}
  </div>;
}
