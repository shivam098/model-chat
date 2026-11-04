"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, Code2, Eye, FileText, Leaf, LoaderCircle, LogOut, Menu, MessageSquare, Mic, PanelLeft, Paperclip, Pencil, Plus, RefreshCw, Settings2, ShieldCheck, Square, Trash2, Volume2, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FILE_ACCEPT, LIMITS, type Attachment, type Chat, type ChatDetail, type Model, type StreamEvent } from "@/lib/contracts";
import { dictationConstructor, voiceError, type Dictation, type VoiceWindow } from "@/lib/voice";
import { DEMOS, type DemoId } from "@/lib/demos";
import type { AccountView, AppUser } from "@/lib/access";
import { AdminPanel } from "./admin-panel";

type User = AppUser;
type Transfer = { id: string; name: string; progress: number; fileId?: string; error?: string; active: boolean };
class RequestError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new RequestError(data.error?.message || data.error || data.message || "The request failed.", response.status, data.code);
  return data as T;
}
function message(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}
function Brand() { return <div className="brand"><span className="brand-icon"><Leaf size={22} /></span><span>model<span className="brand-light">chat</span></span></div>; }

export function ChatApp() {
  const [user, setUser] = useState<User | null>(null);
  const [actor, setActor] = useState<User | null>(null);
  const [admin, setAdmin] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [draftState, setDraftState] = useState<"saved" | "saving" | "error">("saved");
  const [booting, setBooting] = useState(true);
  const [access, setAccess] = useState({ registrationAllowed: false, tunnelMode: false });
  const [notice, setNotice] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelLoading, setModelLoading] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [loadingChat, setLoadingChat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [streamStage, setStreamStage] = useState("Thinking");
  const [mediaInfo, setMediaInfo] = useState<{ ready: boolean; model: string | null; message: string } | null>(null);
  const [sandboxInfo, setSandboxInfo] = useState<{ ready: boolean; message: string; libraries: string[]; limits: { wallSeconds: number; memoryBytes: number; workBytes: number; outputFiles: number; cpus: number } | null } | null>(null);
  const [filePreview, setFilePreview] = useState<{ name: string; text: string; notes: string; nextCursor: number | null; cursor: number; file: Attachment } | null>(null);
  const [draft, setDraft] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [settings, setSettings] = useState(false);
  const [menu, setMenu] = useState(false);
  const [how, setHow] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [rename, setRename] = useState<Chat | null>(null);
  const [deleteChat, setDeleteChat] = useState<Chat | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [dictationAvailable, setDictationAvailable] = useState(false);
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [voiceDialog, setVoiceDialog] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const recognition = useRef<Dictation | null>(null);
  const generation = useRef<AbortController | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const transferControllers = useRef(new Map<string, AbortController>());
  const speechEpoch = useRef(0);
  const draftRef = useRef(draft);
  const selection = useRef(0);
  const userRef = useRef<User | null>(null);
  const detailRef = useRef<ChatDetail | null>(null);
  const demoLaunch = useRef(false);
  const workspaceEpoch = useRef(0);
  const modelRef = useRef(selectedModel);
  const busyRef = useRef(busy);
  const draftWrite = useRef<Promise<void> | null>(null);
  const chatCreation = useRef<{ owner?: string; epoch: number; promise: Promise<Chat> } | null>(null);
  const draftSaved = useRef<{ userId: string; chatId?: string; draft: string; model: string } | null>(null);
  userRef.current = user;
  detailRef.current = detail;
  draftRef.current = draft;
  modelRef.current = selectedModel;
  busyRef.current = busy;
  const pending = detail?.attachments.filter(f => !f.messageId) || [];
  const readyPending = pending.filter(file => !file.processingStatus || file.processingStatus === "ready");
  const processing = detail?.attachments.some(file => ["uploading", "queued", "processing"].includes(file.processingStatus || "")) || false;
  const remoteBusy = Boolean(detail?.messages.some(m => m.status === "streaming"));
  const locked = busy || uploading || loadingChat || remoteBusy || demoLoading || switching;
  // The composer stays usable while a reply streams; only sending (and workspace switches) wait for it.
  const composeLocked = loadingChat || demoLoading || switching;
  const uploadLocked = uploading || composeLocked;
  const replyRunning = busy || remoteBusy;
  const acting = Boolean(actor && user && actor.id !== user.id);
  const modelAvailable = models.some(m => m.id === selectedModel);
  const newImageCount = readyPending.reduce((count, file) => count + (file.mimeType?.startsWith("image/") ? 1 : file.frameCount || 0), 0);
  const imageLimit = models.find(model => model.id === selectedModel)?.maxImages || 0;
  const extraImageRequests = imageLimit ? Math.ceil(Math.max(0, newImageCount - imageLimit) / imageLimit) : 0;
  function api<T>(url: string, init?: RequestInit) {
    const subject = userRef.current?.id;
    return requestJson<T>(url, { ...init, headers: { ...(subject ? { "x-model-chat-subject": subject } : {}), ...init?.headers } });
  }
  function applyAccount(account: AccountView, chatId?: string | null) {
    workspaceEpoch.current++;
    selection.current++;
    generation.current?.abort(); uploadController.current?.abort(); stopDictation(); stopSpeaking();
    userRef.current = account.user; detailRef.current = null; draftRef.current = ""; modelRef.current = "";
    draftSaved.current = null;
    setUser(account.user); setActor(account.actor); setDetail(null); setChats([]); setDraft(""); setSelectedModel("");
    setAdmin(false); setMenu(false); setSidebar(false); setSettings(false); setDraftState("saved");
    setFilePreview(null);
    setTransfers([]); setStreamStage("Thinking");
    if (chatId !== undefined) window.history.replaceState(null, "", chatId ? `?chat=${chatId}` : "/");
  }

  useEffect(() => {
    let alive = true;
    api<{ registrationAllowed: boolean; tunnelMode: boolean }>("/api/access")
      .then(result => { if (alive) setAccess(result); })
      .catch(error => { if (alive) setNotice(message(error)); });
    requestJson<AccountView>("/api/account").then(result => { if (alive) applyAccount(result); })
      .catch(error => { if (alive && !(error instanceof RequestError && error.status === 401)) setNotice(message(error)); })
      .finally(() => { if (alive) setBooting(false); });
    setDictationAvailable(Boolean(dictationConstructor(window as VoiceWindow)));
    setSpeechAvailable("speechSynthesis" in window);
    return () => { alive = false; recognition.current?.abort(); generation.current?.abort(); uploadController.current?.abort(); speechEpoch.current++; window.speechSynthesis?.cancel(); };
  }, []);

  useEffect(() => {
    if (!user || (actor?.appRole !== "superuser" && !acting)) return;
    let alive = true;
    const timer = setInterval(() => {
      requestJson<AccountView>("/api/account").then(account => {
        if (!alive) return;
        if (account.user.id !== userRef.current?.id) {
          applyAccount(account, null);
          setNotice("Your access or acting workspace changed. Returned to the authorized workspace.");
        } else if (account.actor.appRole !== actor?.appRole) {
          setActor(account.actor); setUser(account.user); setAdmin(false);
          setNotice("Your account permissions changed.");
        }
      }).catch(error => { if (alive) report(error); });
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, actor?.appRole, acting]);

  useEffect(() => {
    if (!user || composeLocked) return;
    const timer = setTimeout(() => { void flushDraft().catch(report); }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, selectedModel, user?.id, detail?.chat.id, composeLocked]);

  useEffect(() => {
    const saveOnLeave = () => {
      const owner = userRef.current;
      const current = detailRef.current;
      if (!owner || !current) return;
      void fetch("/api/drafts", {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", "x-model-chat-subject": owner.id },
        body: JSON.stringify({ chatId: current.chat.id, draft: draftRef.current, model: modelRef.current }),
      }).catch(error => console.error("Draft save on page exit failed:", error.name));
    };
    window.addEventListener("pagehide", saveOnLeave);
    return () => window.removeEventListener("pagehide", saveOnLeave);
  }, []);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    setModelLoading(true);
    api<{ chats: Chat[] }>("/api/chats").then(result => {
      if (!alive) return;
      setChats(result.chats);
      const requested = new URLSearchParams(window.location.search).get("chat");
      const selected = result.chats.find(c => c.id === requested);
      if (selected) void openChat(selected);
    }).catch(error => { if (alive) setNotice(message(error)); });
    api<{ models: Model[] }>("/api/models").then(result => {
      if (!alive) return;
      setModels(result.models);
      setSelectedModel(value => value || result.models[0]?.id || "");
      setConnectionError("");
    }).catch(error => { if (alive) setConnectionError(message(error)); })
      .finally(() => { if (alive) setModelLoading(false); });
    api<{ ready: boolean; model: string | null; message: string }>("/api/media-status")
      .then(result => { if (alive) setMediaInfo(result); })
      .catch(error => { if (alive) setMediaInfo({ ready: false, model: null, message: message(error) }); });
    api<NonNullable<typeof sandboxInfo>>("/api/sandbox-status")
      .then(result => { if (alive) setSandboxInfo(result); })
      .catch(error => { if (alive) setSandboxInfo({ ready: false, message: message(error), libraries: [], limits: null }); });
    return () => { alive = false; };
    // Account changes reset and reload this account's data only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!detail?.messages.length) { if (scroller.current) scroller.current.scrollTop = 0; return; }
    if (follow.current) bottom.current?.scrollIntoView({ behavior: busy ? "instant" : "smooth" });
  }, [detail?.messages, busy, interim]);

  useEffect(() => {
    if (!remoteBusy || busy || !detail) return;
    const id = detail.chat.id;
    const timer = setInterval(() => {
      api<ChatDetail>(`/api/chats/${id}`).then(result => {
        if (detailRef.current?.chat.id === id && userRef.current) setDetail(result);
      }).catch(error => setNotice(message(error)));
    }, 1500);
    return () => clearInterval(timer);
  }, [remoteBusy, busy, detail?.chat.id]);

  useEffect(() => {
    if (!processing || !detail) return;
    const id = detail.chat.id;
    const epoch = workspaceEpoch.current;
    let alive = true;
    const timer = setInterval(() => {
      api<{ attachments: Attachment[] }>(`/api/chats/${id}/files`).then(result => {
        if (!alive || epoch !== workspaceEpoch.current) return;
        setDetail(previous => previous?.chat.id === id ? { ...previous, attachments: result.attachments.map(file => {
          const prior = previous.attachments.find(item => item.id === file.id);
          return busyRef.current && prior?.messageId ? { ...file, messageId: prior.messageId } : file;
        }) } : previous);
      }).catch(error => { if (alive && epoch === workspaceEpoch.current) report(error); });
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, detail?.chat.id, user?.id]);

  function report(error: unknown) {
    setNotice(message(error));
    if (error instanceof RequestError && error.status === 401) clearAccount();
    else if (error instanceof RequestError && error.code === "workspace-changed") {
      generation.current?.abort();
      uploadController.current?.abort();
      void requestJson<AccountView>("/api/account").then(account => applyAccount(account, null)).catch(cause => {
        setNotice(message(cause)); if (cause instanceof RequestError && cause.status === 401) clearAccount();
      });
    }
  }
  function stopSpeaking() {
    speechEpoch.current++;
    window.speechSynthesis?.cancel();
    setSpeaking(null);
  }
  function stopDictation() {
    const current = recognition.current;
    recognition.current = null;
    current?.abort();
    setListening(false); setInterim("");
  }
  function clearAccount() {
    generation.current?.abort();
    uploadController.current?.abort();
    stopDictation();
    stopSpeaking();
    userRef.current = null;
    workspaceEpoch.current++; detailRef.current = null; draftRef.current = ""; draftSaved.current = null;
    selection.current++;
    setUser(null); setChats([]); setDetail(null); setModels([]); setSelectedModel("");
    setDraft(""); setBusy(false); setUploading(false); setTransfers([]); setSettings(false); setSidebar(false);
    setMenu(false); setHow(false); setDemoLoading(false);
    setActor(null); setAdmin(false); setSwitching(false);
    setFilePreview(null); setStreamStage("Thinking");
    setSpeaking(null); setInterim(""); setVoiceConsent(false); setConnectionError("");
    window.history.replaceState(null, "", "/");
  }
  async function openChat(chat: Chat) {
    const request = ++selection.current;
    setLoadingChat(true); setNotice(""); setSidebar(false); follow.current = true;
    stopSpeaking();
    stopDictation();
    try {
      await flushDraft(true);
      const result = await api<ChatDetail>(`/api/chats/${chat.id}`);
      if (request !== selection.current) return;
      detailRef.current = result; draftRef.current = result.chat.draft || "";
      draftSaved.current = { userId: userRef.current!.id, chatId: result.chat.id, draft: result.chat.draft || "", model: result.chat.model || modelRef.current };
      setDetail(result);
      setDraft(result.chat.draft || "");
      setDraftState("saved");
      if (result.chat.model) setSelectedModel(result.chat.model);
      window.history.replaceState(null, "", `?chat=${chat.id}`);
    } catch (error) { if (request === selection.current) report(error); }
    finally { if (request === selection.current) setLoadingChat(false); }
  }
  function pendingChatCreation() {
    const creating = chatCreation.current;
    return creating && creating.owner === userRef.current?.id && creating.epoch === workspaceEpoch.current ? creating.promise : null;
  }
  // Single-flight: Send, uploads and draft autosave during the first round trip of a new chat share one chat.
  async function ensureChat(): Promise<Chat> {
    if (!detailRef.current && draftWrite.current) { try { await draftWrite.current; } catch { /* Reported by the draft save. */ } }
    if (detailRef.current) return detailRef.current.chat;
    const existing = pendingChatCreation();
    if (existing) return existing;
    const owner = userRef.current?.id;
    const epoch = workspaceEpoch.current;
    const promise = (async () => {
      const { chat } = await api<{ chat: Chat }>("/api/chats", { method: "POST" });
      if (owner !== userRef.current?.id || epoch !== workspaceEpoch.current) throw new RequestError("The active workspace changed.", 409, "workspace-changed");
      if (detailRef.current) return detailRef.current.chat;
      const next = { chat, messages: [], attachments: [] };
      detailRef.current = next;
      setDetail(next); setChats(previous => [chat, ...previous]);
      window.history.replaceState(null, "", `?chat=${chat.id}`);
      return chat;
    })();
    chatCreation.current = { owner, epoch, promise };
    try { return await promise; } finally { if (chatCreation.current?.promise === promise) chatCreation.current = null; }
  }
  async function flushDraft(_force = false): Promise<void> {
    if (!userRef.current) return;
    if (draftWrite.current) { await draftWrite.current; return flushDraft(_force); }
    const creating = detailRef.current ? null : pendingChatCreation();
    if (creating) { try { await creating; } catch { /* Reported by the chat creator. */ } return flushDraft(_force); }
    const owner = userRef.current.id;
    const epoch = workspaceEpoch.current;
    const chatId = detailRef.current?.chat.id;
    const text = draftRef.current;
    const model = modelRef.current;
    const saved = draftSaved.current;
    if ((!chatId && !text) || (saved?.userId === owner && saved.chatId === chatId && saved.draft === text && saved.model === model)) { setDraftState("saved"); return; }
    setDraftState("saving");
    const operation = (async () => {
      try {
        const result = await requestJson<{ chat: Chat | null }>("/api/drafts", {
          method: "POST", headers: { "x-model-chat-subject": owner },
          body: JSON.stringify({ chatId, draft: text, model }),
        });
        if (epoch !== workspaceEpoch.current || owner !== userRef.current?.id) return;
        if (result.chat) {
          const chat = result.chat;
          if (!detailRef.current) {
            detailRef.current = { chat, messages: [], attachments: [] };
            setDetail(detailRef.current);
            window.history.replaceState(null, "", `?chat=${chat.id}`);
          } else if (detailRef.current.chat.id === chat.id) {
            detailRef.current = { ...detailRef.current, chat };
            // Functional update so a draft save never overwrites streamed reply text queued in the same render.
            setDetail(previous => previous && previous.chat.id === chat.id ? { ...previous, chat } : previous);
          }
          setChats(previous => previous.some(item => item.id === chat.id) ? previous.map(item => item.id === chat.id ? chat : item) : [chat, ...previous]);
          draftSaved.current = { userId: owner, chatId: chat.id, draft: text, model };
        }
        setDraftState("saved");
      } catch (error) { setDraftState("error"); throw error; }
    })();
    draftWrite.current = operation;
    try { await operation; } finally { if (draftWrite.current === operation) draftWrite.current = null; }
  }
  async function newChat(skipSave = false) {
    stopDictation();
    if (!skipSave) {
      setSwitching(true);
      try { await flushDraft(true); } catch (error) { report(error); setSwitching(false); return; }
    }
    selection.current++; setDetail(null); detailRef.current = null; setDraft(""); setNotice(""); setSidebar(false);
    draftRef.current = ""; draftSaved.current = null;
    stopSpeaking(); stopDictation();
    window.history.replaceState(null, "", "/");
    composer.current?.focus();
    setSwitching(false);
  }
  async function actAs(userId: string, chatId?: string) {
    if (locked || actor?.appRole !== "superuser" || acting) return;
    setSwitching(true);
    stopDictation();
    try {
      await flushDraft(true);
      const result = await api<AccountView & { chatId: string | null }>("/api/admin/acting", {
        method: "POST", body: JSON.stringify({ userId, chatId, previous: { chatId: detailRef.current?.chat.id, draft: draftRef.current, model: modelRef.current } }),
      });
      applyAccount(result, result.chatId);
      setNotice("Acting as this user. Access and changes are recorded in the audit log.");
    } catch (error) { report(error); }
    finally { setSwitching(false); }
  }
  async function returnToSelf() {
    if (locked) return;
    setSwitching(true);
    stopDictation();
    try {
      await flushDraft(true);
      const result = await api<AccountView & { chatId: string | null }>("/api/admin/stop", {
        method: "POST", body: JSON.stringify({ previous: { chatId: detailRef.current?.chat.id, draft: draftRef.current, model: modelRef.current } }),
      });
      applyAccount(result, result.chatId);
    } catch (error) { report(error); }
    finally { setSwitching(false); }
  }
  async function launchDemo(demoId: DemoId) {
    if (!userRef.current || locked || demoLaunch.current) return;
    demoLaunch.current = true;
    setDemoLoading(true); setNotice("");
    stopSpeaking(); stopDictation();
    const accountId = userRef.current.id;
    const request = ++selection.current;
    const prior = detailRef.current;
    try {
      await flushDraft(true);
      const result = await api<{ detail: ChatDetail; chats: Chat[] }>("/api/demos", {
        method: "POST",
        body: JSON.stringify({
          demoId,
          ...(prior || draftRef.current ? { previous: { chatId: prior?.chat.id, draft: draftRef.current } } : {}),
        }),
      });
      if (accountId !== userRef.current?.id || request !== selection.current) return;
      detailRef.current = result.detail;
      draftRef.current = result.detail.chat.draft || "";
      draftSaved.current = { userId: accountId, chatId: result.detail.chat.id, draft: draftRef.current, model: modelRef.current };
      setDetail(result.detail); setChats(result.chats); setDraft(result.detail.chat.draft || "");
      setHow(false); setSidebar(false); follow.current = true;
      window.history.replaceState(null, "", `?chat=${result.detail.chat.id}`);
      setNotice("Example loaded in a new chat. Review the draft and press Send for a real model response.");
    } catch (error) { setHow(false); report(error); }
    finally {
      demoLaunch.current = false; setDemoLoading(false);
      composer.current?.focus();
    }
  }
  async function refreshModels() {
    setModelLoading(true); setConnectionError("");
    try {
      const result = await api<{ models: Model[] }>("/api/models?refresh=1");
      setModels(result.models); setSelectedModel(value => value || result.models[0]?.id || "");
    } catch (error) { setConnectionError(message(error)); }
    finally { setModelLoading(false); }
  }
  async function refreshChat(id: string) {
    const [updated, listed] = await Promise.all([api<ChatDetail>(`/api/chats/${id}`), api<{ chats: Chat[] }>("/api/chats")]);
    if (userRef.current && detailRef.current?.chat.id === id) { setDetail(updated); setChats(listed.chats); }
  }
  async function send(event?: FormEvent, textOnly = false) {
    event?.preventDefault();
    if (locked || !modelAvailable || !draft.trim()) return;
    if (!textOnly && (pending.length !== readyPending.length || transfers.some(transfer => transfer.error))) {
      setNotice("Some attached files are still processing or could not be uploaded. Nothing was sent. Wait or retry/remove those files, or explicitly choose Send text only.");
      return;
    }
    stopDictation();
    const content = draft.trim();
    const ownerId = userRef.current?.id;
    const epoch = workspaceEpoch.current;
    // Clear the composer now so anything typed while this reply streams becomes the next draft, not this turn.
    draftRef.current = ""; setDraft(""); setDraftState("saving");
    setBusy(true); setNotice(""); setStreamStage("Preparing attachments"); follow.current = true;
    const controller = new AbortController();
    generation.current = controller;
    let chatId: string | undefined;
    let accepted = false;
    let done = false;
    const selectedFiles = textOnly ? [] : pending;
    try {
      await flushDraft(true);
      const chat = await ensureChat();
      chatId = chat.id;
      const response = await fetch(`/api/chats/${chat.id}/messages`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-model-chat-subject": ownerId! },
        body: JSON.stringify({ content, model: selectedModel, fileIds: selectedFiles.map(f => f.id) }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new RequestError(data.error || "The message could not be sent.", response.status, data.code);
      }
      if (!response.body) throw new Error("This browser could not open the reply stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const apply = (line: string) => {
        const item = JSON.parse(line) as StreamEvent;
        if (userRef.current?.id !== ownerId || workspaceEpoch.current !== epoch) return;
        if (item.type === "error") throw new Error(item.error);
        if (item.type === "start") {
          accepted = true;
          setDetail(previous => previous && previous.chat.id === chatId ? ({ ...previous,
            messages: [...previous.messages, item.user, item.assistant],
            attachments: previous.attachments.map(f => selectedFiles.some(p => p.id === f.id) ? { ...f, messageId: item.user.id } : f),
          }) : previous);
        } else if (item.type === "progress") {
          setStreamStage(item.stage);
        } else if (item.type === "attachments") {
          const chatForFiles = chatId;
          void api<{ attachments: Attachment[] }>(`/api/chats/${chatForFiles}/files`).then(result => {
            if (userRef.current?.id !== ownerId || workspaceEpoch.current !== epoch) return;
            setDetail(previous => previous && previous.chat.id === chatForFiles ? { ...previous, attachments: result.attachments } : previous);
          }).catch(report);
        } else if (item.type === "delta" || item.type === "replace") {
          setDetail(previous => previous && previous.chat.id === chatId ? ({ ...previous, messages: previous.messages.map((m, index) => index === previous.messages.length - 1 ?
            { ...m, content: item.type === "delta" ? m.content + item.text : item.text } : m) }) : previous);
        } else if (item.type === "done") {
          done = true;
          setDetail(previous => previous && previous.chat.id === chatId ? ({ ...previous, messages: previous.messages.map(m => m.id === item.message.id ? item.message : m) }) : previous);
        }
      };
      try {
        for (;;) {
          const result = await reader.read();
          buffer += decoder.decode(result.value, { stream: !result.done });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) if (line.trim()) apply(line);
          if (result.done) break;
        }
        if (buffer.trim()) apply(buffer);
        if (!done) throw new Error("The connection ended before the reply finished. Your saved chat will show its current state.");
      } finally { reader.releaseLock(); }
    } catch (error) {
      if (userRef.current?.id === ownerId && workspaceEpoch.current === epoch) {
        report(error);
        if (!accepted) {
          // Restore the unsent message without discarding anything typed since Send.
          const restored = draftRef.current.trim() ? `${content}\n\n${draftRef.current}` : content;
          draftRef.current = restored; setDraft(restored); setDraftState("saving");
        }
      }
    } finally {
      if (chatId && userRef.current?.id === ownerId && workspaceEpoch.current === epoch) {
        try { await refreshChat(chatId); } catch (error) { report(error); }
      }
      if (generation.current === controller) { setBusy(false); generation.current = null; }
      composer.current?.focus();
    }
  }
  async function stop() {
    if (!detail) return;
    try { await api(`/api/chats/${detail.chat.id}/stop`, { method: "POST" }); }
    catch (error) { report(error); }
  }
  async function upload(files: FileList | File[] | null) {
    if (!files?.length) return;
    if (uploadLocked) { setNotice("Finish the current file transfer before adding another selection of files."); return; }
    const selected = Array.from(files).map(file => ({ file, id: crypto.randomUUID() }));
    for (const item of selected) transferControllers.current.set(item.id, new AbortController());
    setUploading(true); setNotice("");
    setTransfers(previous => [...previous, ...selected.map(item => ({ id: item.id, name: item.file.name, progress: 0, active: false }))]);
    const controller = new AbortController();
    uploadController.current = controller;
    const uploadEpoch = workspaceEpoch.current;
    const owner = userRef.current?.id;
    let chatId: string | undefined;
    const update = (id: string, values: Partial<Transfer>) => {
      if (workspaceEpoch.current === uploadEpoch) setTransfers(previous => previous.map(item => item.id === id ? { ...item, ...values } : item));
    };
    try {
      await flushDraft(true);
      const chat = await ensureChat();
      chatId = chat.id;
      let next = 0;
      const transfer = async ({ file, id }: typeof selected[number]) => {
        const local = transferControllers.current.get(id)!;
        const signal = AbortSignal.any([controller.signal, local.signal]);
        let currentFile: string | undefined;
        let accepted = false;
        try {
          signal.throwIfAborted();
          update(id, { active: true });
          const started = await api<{ fileId: string; partBytes: number }>(`/api/chats/${chat.id}/files/start`, {
            method: "POST", signal, body: JSON.stringify({ name: file.name, size: file.size }), headers: { "x-model-chat-subject": owner! },
          });
          currentFile = started.fileId;
          update(id, { fileId: currentFile });
          for (let offset = 0, position = 0; offset < file.size; offset += started.partBytes, position++) {
            for (let attempt = 0; ; attempt++) {
              try {
                await api(`/api/chats/${chat.id}/files/${currentFile}/parts/${position}`, {
                  method: "POST", signal, headers: { "Content-Type": "application/octet-stream", "x-model-chat-subject": owner! },
                  body: file.slice(offset, offset + started.partBytes),
                });
                break;
              } catch (error) {
                if (signal.aborted || attempt >= 4 || !(error instanceof TypeError || (error instanceof RequestError && (error.status >= 500 || error.status === 429)))) throw error;
                await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                signal.throwIfAborted();
              }
            }
            update(id, { progress: Math.min(1, (offset + started.partBytes) / file.size) });
          }
          const { attachment } = await api<{ attachment: Attachment }>(`/api/chats/${chat.id}/files/${currentFile}/complete`, {
            method: "POST", signal, headers: { "x-model-chat-subject": owner! },
          });
          accepted = true;
          if (workspaceEpoch.current !== uploadEpoch) return;
          setDetail(previous => previous?.chat.id === chat.id ? ({ ...previous, attachments: [...previous.attachments.filter(item => item.id !== attachment.id), attachment] }) : previous);
          setTransfers(previous => previous.filter(item => item.id !== id));
        } catch (error) {
          if (workspaceEpoch.current !== uploadEpoch) return;
          if (signal.aborted) setTransfers(previous => previous.filter(item => item.id !== id));
          else { update(id, { active: false, error: message(error) }); report(error); }
        } finally {
          if (!accepted && currentFile && workspaceEpoch.current === uploadEpoch) {
            try {
              if (local.signal.aborted) {
                await api(`/api/chats/${chat.id}/files/${currentFile}`, { method: "DELETE", headers: { "x-model-chat-subject": owner! } });
              } else {
                const saved = (await api<{ attachments: Attachment[] }>(`/api/chats/${chat.id}/files`)).attachments.find(item => item.id === currentFile);
                if (saved && !saved.uploadComplete) await api(`/api/chats/${chat.id}/files/${currentFile}/cancel`, { method: "POST", headers: { "x-model-chat-subject": owner! } });
              }
              setTransfers(previous => previous.filter(item => item.id !== id));
            } catch (error) { if (!(error instanceof RequestError && [404, 409].includes(error.status))) report(error); }
          }
          transferControllers.current.delete(id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(LIMITS.transfersPerUser, selected.length) }, async () => {
        while (next < selected.length) { const item = selected[next++]; await transfer(item); }
      }));
    } catch (error) {
      if (workspaceEpoch.current === uploadEpoch) {
        if (controller.signal.aborted) {
          setNotice("Upload stopped. Files already queued continue processing in their original chats.");
          setTransfers(previous => previous.filter(item => !selected.some(file => file.id === item.id)));
        } else {
          setTransfers(previous => previous.map(item => selected.some(file => file.id === item.id) ? { ...item, active: false, error: message(error) } : item));
          report(error);
        }
      }
    }
    finally {
      for (const item of selected) transferControllers.current.delete(item.id);
      if (chatId && workspaceEpoch.current === uploadEpoch && detailRef.current?.chat.id === chatId && userRef.current) {
        // Refresh attachments only, so a streaming reply in this chat is never overwritten by a server snapshot.
        try {
          const latest = await api<{ attachments: Attachment[] }>(`/api/chats/${chatId}/files`);
          if (workspaceEpoch.current === uploadEpoch) setDetail(previous => previous && previous.chat.id === chatId ? { ...previous, attachments: latest.attachments } : previous);
        } catch (error) { report(error); }
      }
      if (uploadController.current === controller) {
        setUploading(false); uploadController.current = null;
        if (fileInput.current) fileInput.current.value = "";
      }
    }
  }
  async function previewFile(file: Attachment, cursor = 0) {
    const epoch = workspaceEpoch.current;
    const selected = selection.current;
    try {
      const preview = await api<{ name: string; text: string; notes: string; nextCursor: number | null }>(`/api/chats/${file.chatId}/files/${file.id}/extracted?cursor=${cursor}`);
      if (epoch === workspaceEpoch.current && selected === selection.current) setFilePreview({ ...preview, cursor, file });
    } catch (error) { report(error); }
  }
  async function controlFile(file: Attachment, action: "cancel" | "retry") {
    const epoch = workspaceEpoch.current;
    try {
      const result = await api<{ attachment: Attachment }>(`/api/chats/${file.chatId}/files/${file.id}/${action}`, { method: "POST" });
      if (epoch === workspaceEpoch.current) setDetail(previous => previous?.chat.id === file.chatId ? { ...previous, attachments: previous.attachments.map(item => item.id === file.id ? result.attachment : item) } : previous);
    } catch (error) { if (epoch === workspaceEpoch.current) report(error); }
  }
  async function removeFile(file: Attachment) {
    const epoch = workspaceEpoch.current;
    try {
      await api(`/api/chats/${file.chatId}/files/${file.id}`, { method: "DELETE" });
      if (workspaceEpoch.current === epoch) setDetail(previous => previous?.chat.id === file.chatId ? { ...previous, attachments: previous.attachments.filter(f => f.id !== file.id) } : previous);
    } catch (error) { if (workspaceEpoch.current === epoch) report(error); }
  }
  async function saveTitle(event: FormEvent) {
    event.preventDefault();
    if (!rename) return;
    try {
      const { chat } = await api<{ chat: Chat }>(`/api/chats/${rename.id}`, { method: "PATCH", body: JSON.stringify({ title: editingTitle }) });
      setChats(previous => previous.map(c => c.id === chat.id ? chat : c));
      setDetail(previous => previous?.chat.id === chat.id ? { ...previous, chat } : previous);
      setRename(null);
    } catch (error) { report(error); }
  }
  async function confirmDelete() {
    if (!deleteChat) return;
    try {
      await api(`/api/chats/${deleteChat.id}`, { method: "DELETE" });
      setChats(previous => previous.filter(c => c.id !== deleteChat.id));
      if (detail?.chat.id === deleteChat.id) { detailRef.current = null; draftRef.current = ""; draftSaved.current = null; await newChat(true); }
      setDeleteChat(null);
    } catch (error) { report(error); }
  }
  async function logout() {
    try {
      stopDictation();
      await flushDraft(true);
      await api("/api/auth/sign-out", { method: "POST", body: "{}" });
      clearAccount();
    } catch (error) { report(error); }
  }
  function startDictation() {
    if (!voiceConsent) { setVoiceDialog(true); return; }
    const Constructor = dictationConstructor(window as VoiceWindow);
    if (!Constructor) { setNotice("Dictation is not supported by this browser. Use a supported browser such as Edge or Chrome, or type instead."); return; }
    stopSpeaking();
    const instance = new Constructor();
    const epoch = workspaceEpoch.current;
    const owner = userRef.current?.id;
    const selectedChat = selection.current;
    const current = () => recognition.current === instance && epoch === workspaceEpoch.current && owner === userRef.current?.id && selectedChat === selection.current;
    instance.lang = navigator.language || "en-US"; instance.interimResults = true; instance.continuous = true;
    instance.onresult = event => {
      if (!current()) return;
      let final = ""; let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) final += event.results[i][0].transcript + " ";
        else interimText += event.results[i][0].transcript;
      }
      if (final) {
        const next = draftRef.current + (draftRef.current && !draftRef.current.endsWith(" ") ? " " : "") + final;
        if (next.length > LIMITS.inputCharacters) {
          instance.stop();
          setNotice("Dictation reached the 8,000-character message limit. The transcript was shortened; review it before sending.");
        }
        draftRef.current = next.slice(0, LIMITS.inputCharacters);
        setDraft(draftRef.current);
        setDraftState("saving");
      }
      setInterim(interimText);
    };
    instance.onerror = event => { if (!current()) return; if (event.error !== "aborted") setNotice(voiceError(event.error)); setListening(false); setInterim(""); };
    instance.onend = () => { if (current()) { setListening(false); setInterim(""); } };
    recognition.current = instance;
    try { instance.start(); setListening(true); } catch (error) { setNotice(message(error)); }
  }
  function readAloud(id: string, text: string) {
    if (!speechAvailable) { setNotice("Read-aloud is not supported by this browser."); return; }
    const wasSpeaking = speaking === id;
    stopSpeaking();
    if (wasSpeaking) return;
    const epoch = speechEpoch.current;
    recognition.current?.stop();
    const chunks = text.match(/[\s\S]{1,220}(?:\s|$)|[\s\S]{1,220}/g) || [text];
    const speak = (index: number) => {
      if (speechEpoch.current !== epoch) return;
      if (index >= chunks.length) { setSpeaking(null); return; }
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = navigator.language;
      utterance.onend = () => speak(index + 1);
      utterance.onerror = event => {
        if (speechEpoch.current !== epoch) return;
        if (!["interrupted", "canceled"].includes(event.error)) setNotice("Read-aloud stopped. Check your browser's voice support.");
        setSpeaking(null);
      };
      window.speechSynthesis.speak(utterance);
    };
    setSpeaking(id); speak(0);
  }

  const navigation = <>
    {menu && <Dialog title="Menu" onClose={() => setMenu(false)}>
      <div className="menu-items">
        <button onClick={() => { setMenu(false); setHow(true); }}><BookOpen size={20} /><span>How Model Chat works &amp; Demos</span></button>
        {user && <button onClick={() => { setMenu(false); setSettings(true); }}><Settings2 size={20} /><span>Account &amp; connection</span></button>}
        {actor?.appRole === "superuser" && !acting && <button onClick={() => { setMenu(false); setAdmin(true); }}><ShieldCheck size={20} /><span>Users &amp; audit</span></button>}
      </div>
    </Dialog>}
    {how && <Dialog title="How Model Chat works & Demos" onClose={() => { if (!demoLoading) setHow(false); }}>
      <div className="how-intro">
        <p><strong>Email + password. No OTP.</strong> Any email address, including Gmail, works. This is a Model Chat account, not Google sign-in. Use a unique password of at least 12 characters.</p>
        <ol>
          <li>Sign in, choose an available Copilot model, and write a question or load an example below.</li>
          <li>Press Send for a real streamed answer. Stop keeps any partial reply. Ordinary accounts have separate chats; the app superuser can view chats/files and act as users, with an audit log.</li>
          <li>Attach supported documents to ask questions about them. Reopen chats or switch models without losing their saved context.</li>
          <li>Ask for a PDF, chart, GIF/MP4 animation or Word/Excel/PowerPoint file. The model runs Python in an offline, disposable sandbox on the host and attaches the results; it cannot browse the internet or install software. See Files &amp; privacy for its libraries and limits.</li>
        </ol>
        <p>All accounts use the host owner&apos;s Copilot quota. Prompts and extracted file text are sent to Copilot; availability and usage limits apply.</p>
      </div>
      <h3 className="demo-heading">Try a small example</h3>
      <p>Each button creates a separate chat with a ready-to-edit draft. The budget example also attaches a synthetic CSV. <strong>Nothing is sent to a model until you press Send.</strong> Your current draft is saved before switching.</p>
      {!user && <p className="demo-guidance">Sign in or create an account first to load an example.</p>}
      {user && locked && <p className="demo-guidance" role="status">{demoLoading ? "Opening your example..." : "Finish or stop the current operation before loading an example."}</p>}
      <div className="demo-cards">{DEMOS.map(sample => <button key={sample.id} disabled={!user || locked} onClick={() => void launchDemo(sample.id)} aria-label={`Load ${sample.title}`}>
        {sample.id === "budget" ? <FileText size={21} /> : sample.id === "writing" ? <Pencil size={21} /> : <MessageSquare size={21} />}
        <strong>{sample.title}</strong><span>{sample.description}</span><small>Load example draft <ArrowUp size={12} className="arrow-right" /></small>
      </button>)}</div>
      <div className="settings-section"><h3><Mic size={16} /> Voice and files</h3><p>Dictate uses your browser&apos;s speech service, which may process audio online. Read aloud uses browser voices. Uploaded recordings are different: their speech is transcribed locally with Whisper, and video adds up to four sampled frames. Review extracted text with the eye icon before sending.</p><p>Uploads are saved in parts and processed in the background. There is no preset total upload-size, media-duration, or processing-time cutoff. Keep chatting or switch conversations while processing; cancel or retry from the file card. Available disk space, safe-format/decoder budgets, and model context still apply. Large files use labeled excerpts in model requests; full extracted text is available in pages. Videos and images need a vision model. Sampled frames are not continuous video understanding. No files are executed.</p></div>
    </Dialog>}
  </>;
  if (booting) return <main className="boot"><Brand /><LoaderCircle className="spin" aria-label="Loading account" /></main>;
  if (!user) return <><AuthScreen notice={notice} access={access} onMenu={() => setMenu(true)} onSuccess={next => { setNotice(""); applyAccount(next, null); }} />{navigation}</>;

  return <div className="app-shell">
    {sidebar && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => setSidebar(false)} />}
    <aside className={`sidebar ${sidebar ? "open" : ""}`}>
      <div className="sidebar-brand"><Brand /><IconButton label="Close sidebar" onClick={() => setSidebar(false)}><X size={18} /></IconButton></div>
      <button className="new-chat" onClick={() => void newChat()} disabled={locked}><Plus size={18} /> New conversation <span>+</span></button>
      <div className="sidebar-label">YOUR CONVERSATIONS <span>{chats.length}</span></div>
      <nav className="chat-list" aria-label="Chat history">
        {chats.length === 0 && <p className="history-empty">A little space for your thoughts.<br />Your conversations will live here.</p>}
        {chats.map(chat => <div className={`chat-item ${detail?.chat.id === chat.id ? "selected" : ""}`} key={chat.id}>
          <button className="chat-select" onClick={() => void openChat(chat)} disabled={locked}><MessageSquare size={15} /><span>{chat.title}</span></button>
          <div className="chat-actions">
            <IconButton label={`Rename ${chat.title}`} disabled={locked} onClick={() => { setEditingTitle(chat.title); setRename(chat); }}><Pencil size={13} /></IconButton>
            <IconButton label={`Delete ${chat.title}`} disabled={locked} onClick={() => setDeleteChat(chat)}><Trash2 size={13} /></IconButton>
          </div>
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <div className="local-badge"><span className="status-dot" /> {access.tunnelMode ? "Temporary tunnel" : "Personal & local"} <ShieldCheck size={14} /></div>
        <button className="account-button" onClick={() => setSettings(true)}><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><span className="account-text"><strong>{user.name}</strong><small>Account & connection</small></span><Settings2 size={17} /></button>
      </div>
    </aside>
    <main className="main-panel">
      <header className="topbar">
        <div className="topbar-title"><IconButton label="Open sidebar" onClick={() => setSidebar(true)}><PanelLeft size={20} /></IconButton><button className="menu-button" onClick={() => setMenu(true)}><Menu size={18} /><span>Menu</span></button><span>{detail?.chat.title || "A fresh conversation"}</span></div>
        <div className="model-control">
          <span className={`status-dot ${connectionError ? "offline" : ""}`} />
          <select aria-label="Select model" value={selectedModel} disabled={composeLocked || modelLoading || !models.length} onChange={event => { setSelectedModel(event.target.value); setDraftState("saving"); }}>
            {!selectedModel && <option value="">{modelLoading ? "Connecting..." : "No models available"}</option>}
            {selectedModel && !modelAvailable && <option value={selectedModel}>{selectedModel} (unavailable)</option>}
            {models.map(model => <option value={model.id} key={model.id}>{model.name}{model.vision ? " · vision" : ""}{model.multiplier !== undefined ? ` · ${model.multiplier}x` : ""}</option>)}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
          <IconButton label="Refresh Copilot connection" onClick={() => void refreshModels()} disabled={composeLocked || modelLoading}><RefreshCw size={15} className={modelLoading ? "spin" : ""} /></IconButton>
        </div>
      </header>
      {acting && <div className="acting-banner" role="status"><div><strong>Acting as {user.name}</strong><span>{user.email} · Signed in as {actor?.email}. Actions are audited.</span></div><button onClick={() => void returnToSelf()} disabled={locked}>Return to my workspace</button>{(busy || remoteBusy) && <small>Stop the current reply before returning.</small>}</div>}
      {connectionError && <div className="connection-banner" role="status"><ShieldCheck size={18} /><span>{connectionError}</span><button onClick={() => setSettings(true)}>Setup</button></div>}
      {notice && <div className="notice" role="alert"><span>{notice}</span><IconButton label="Dismiss message" onClick={() => setNotice("")}><X size={16} /></IconButton></div>}
      <div className="conversation" ref={scroller} onScroll={() => {
        const node = scroller.current;
        if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
      }}>
        {loadingChat ? <div className="loading-chat"><LoaderCircle className="spin" /> Opening conversation...</div> :
          !detail?.messages.length ? <div className="welcome">
            <div className="welcome-mark"><Leaf size={34} strokeWidth={1.4} /></div>
            <div className="eyebrow">YOUR MODELS. ONE QUIET SPACE.</div>
            <h1>What&apos;s on your mind?</h1>
            <p>{pending.length ? <>{processing ? "Your files are processing in the background." : readyPending.length ? "Your processed files are ready." : "Your uploads need attention."}<br />You can keep chatting while files are processed.</> : <>Start with a thought, a question, or a file.<br />Pick a model. Make room for an idea.</>}</p>
            {pending.length === 0 && <div className="suggestions">
              <button onClick={() => { setDraft("Help me think through an idea. Ask me one useful question to get started."); setDraftState("saving"); composer.current?.focus(); }}><MessageSquare size={20} /><strong>Think it through</strong><span>Find a new perspective</span></button>
              <button onClick={() => fileInput.current?.click()} disabled={uploadLocked}><FileText size={20} /><strong>Explore a document</strong><span>Turn information into insight</span></button>
              <button onClick={() => { setDraft("Help me write something clear and concise. Ask what I want to communicate."); setDraftState("saving"); composer.current?.focus(); }}><Pencil size={20} /><strong>Find the right words</strong><span>Bring a first draft to life</span></button>
              {sandboxInfo?.ready && <button onClick={() => { setDraft("Create a one-page PDF report and a matching bar-chart PNG for these sample figures: Q1 = 12, Q2 = 18, Q3 = 15, Q4 = 22. Include a short summary in the PDF."); setDraftState("saving"); composer.current?.focus(); }}><Code2 size={20} /><strong>Make a file</strong><span>PDF, chart, GIF/MP4 or Office</span></button>}
            </div>}
          </div> : <div className="message-list">
            {detail.messages.map(item => <article key={item.id} className={`message ${item.role}`} aria-label={`${item.role === "user" ? "Your" : "Assistant"} message`}>
              <div className="message-label">{item.role === "user" ? <span className="mini-avatar">{user.name.slice(0, 1).toUpperCase()}</span> : <Leaf size={17} />}
                <strong>{item.role === "user" ? "You" : models.find(m => m.id === item.model)?.name || item.model}</strong>
                <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              {item.role === "assistant" ? <div className="markdown">
                {item.content ? <Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} components={{
                  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
                }}>{item.content}</Markdown> : item.status === "streaming" ? <span className="thinking"><i /><i /><i />{busy ? streamStage : "Processing attachments or generating reply"}</span> : <p className="muted">No answer was generated.</p>}
              </div> : <div className="user-text">{item.content}</div>}
              {item.status === "streaming" && busy && item.content && <div className="tool-stage" role="status"><LoaderCircle className="spin" size={13} />{streamStage}</div>}
              {detail.attachments.filter(f => f.messageId === item.id && f.preview && f.preview !== "pdf").map(file => {
                const source = `/api/chats/${file.chatId}/files/${file.id}/preview`;
                return file.preview === "image"
                  ? <img key={`preview-${file.id}`} className="generated-preview" src={source} alt={`Generated ${file.name}`} loading="lazy" />
                  : <video key={`preview-${file.id}`} className="generated-preview" src={source} controls preload="metadata" aria-label={`Generated ${file.name}`} />;
              })}
              {detail.attachments.filter(f => f.messageId === item.id).map(file => <span key={file.id}><a className="file-chip sent" title={file.notes} href={`/api/chats/${file.chatId}/files/${file.id}`}><FileText size={14} /><span>{file.name}</span><ArrowDown size={13} /></a>
                {file.preview === "pdf" ? <a className="icon-button" aria-label={`Open PDF preview of ${file.name}`} title="Open PDF preview" href={`/api/chats/${file.chatId}/files/${file.id}/preview`} target="_blank" rel="noopener noreferrer"><Eye size={14} /></a>
                  : <IconButton label={`Preview extracted text for ${file.name}`} onClick={() => void previewFile(file)}><Eye size={14} /></IconButton>}</span>)}
              {item.error && <div className={`message-status ${item.status}`} role="status">{item.error}</div>}
              {item.role === "assistant" && item.content && item.status !== "streaming" && <button className={`read-aloud ${speaking === item.id ? "active" : ""}`} disabled={!speechAvailable} onClick={() => readAloud(item.id, item.content)}><Volume2 size={14} />{speaking === item.id ? "Stop reading" : "Read aloud"}</button>}
            </article>)}
          </div>}
        <div ref={bottom} />
      </div>
      <div className="composer-wrap">
        <form className={`composer ${listening ? "listening" : ""}`} onSubmit={send}
          onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
          onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void upload(event.dataTransfer.files); } }}>
          {transfers.length > 0 && <div className="pending-files" aria-label="File transfers">{transfers.map(transfer => <div className="file-chip transfer" key={transfer.id} data-active={transfer.active}>
            {transfer.active ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}
            <span>{transfer.name}<small>{transfer.error || (transfer.active ? `${Math.round(transfer.progress * 100)}% uploaded` : "Waiting to upload")}</small>
              <progress aria-label={`Upload progress for ${transfer.name}`} max={1} value={transfer.progress} /></span>
            <IconButton label={`Remove transfer ${transfer.name}`} onClick={() => {
              transferControllers.current.get(transfer.id)?.abort();
              setTransfers(previous => previous.filter(item => item.id !== transfer.id));
            }}><X size={14} /></IconButton>
          </div>)}</div>}
          {pending.length > 0 && <div className="pending-files">{pending.filter(file => !transfers.some(transfer => transfer.fileId === file.id && !transfer.error)).map(file => {
            const status = file.processingStatus || "ready";
            const running = ["queued", "processing"].includes(status);
            return <div className={`file-chip file-job ${status}`} title={`${file.notes} ${file.characters.toLocaleString()} characters.`} key={file.id}>
              {running ? <LoaderCircle className="spin" size={16} /> : <FileText size={16} />}
              <span>{file.name}<small>{(file.size / 1024 / 1024).toFixed(1)} MB · {file.processingStage || status}{file.processingProgress && running ? ` · ${Math.round(file.processingProgress * 100)}%` : ""}{file.frameCount ? ` · ${file.frameCount} frames` : ""}</small>{file.processingError && <small className="file-error">{file.processingError}</small>}</span>
              <IconButton label={`Preview extracted text for ${file.name}`} disabled={status !== "ready"} onClick={() => void previewFile(file)}><Eye size={14} /></IconButton>
              {file.uploadComplete !== 0 && <a className="icon-button" aria-label={`Download original ${file.name}`} href={`/api/chats/${file.chatId}/files/${file.id}`}><ArrowDown size={14} /></a>}
              {(running || status === "uploading") && <IconButton label={`Cancel processing ${file.name}`} onClick={() => void controlFile(file, "cancel")}><Square size={14} /></IconButton>}
              {file.uploadComplete !== 0 && ["failed", "cancelled"].includes(status) && <IconButton label={`Retry processing ${file.name}`} onClick={() => void controlFile(file, "retry")}><RefreshCw size={14} /></IconButton>}
              <IconButton label={`Remove ${file.name}`} disabled={switching || demoLoading} onClick={() => void removeFile(file)}><X size={14} /></IconButton>
            </div>;
          })}</div>}
          {pending.some(file => file.processingStatus && file.processingStatus !== "ready") && <p className="file-guidance">Send will include every attached file once ready. Wait or retry/remove unfinished files, or choose Send text only to leave them for later.</p>}
          {extraImageRequests > 0 && <p className="file-guidance" role="status">These images/frames need up to {extraImageRequests} additional Copilot {extraImageRequests === 1 ? "request" : "requests"} with this model, using extra quota. Each is analyzed separately at its supplied detail; one reply combines the results. Analyses are saved for later turns.</p>}
          <label className="sr-only" htmlFor="message">Message</label>
          <textarea id="message" ref={composer} rows={2} placeholder={listening ? "Listening... your words will appear here" : "Ask anything, or bring a file into the conversation..."} value={draft}
            onChange={event => { draftRef.current = event.target.value; setDraft(event.target.value); setDraftState("saving"); }} maxLength={LIMITS.inputCharacters} disabled={composeLocked}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
            onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void upload(event.clipboardData.files); } }} />
          {interim && <div className="interim" aria-live="polite">{interim}</div>}
          <div className="composer-tools">
            <div className="tool-group">
              <input type="file" accept={FILE_ACCEPT} multiple ref={fileInput} className="sr-only" tabIndex={-1} onChange={event => void upload(event.target.files)} />
              <IconButton label="Attach files" onClick={() => fileInput.current?.click()} disabled={uploadLocked}>{uploading ? <LoaderCircle className="spin" size={19} /> : <Paperclip size={19} />}</IconButton>
              <button type="button" className={`voice-button ${listening ? "active" : ""}`} disabled={composeLocked || !dictationAvailable}
                title={!dictationAvailable ? "Dictation unavailable in this browser; text chat works." : "Dictate with your browser's speech service"}
                onClick={() => listening ? recognition.current?.stop() : startDictation()}><Mic size={18} /><span>{listening ? "Stop dictation" : "Dictate"}</span></button>
              <span className="upload-status">{uploading ? `${transfers.filter(item => item.active).length} uploading` : pending.length ? `${readyPending.length} ready · ${pending.length - readyPending.length} pending` : ""}</span>
              {uploading && <button type="button" className="voice-button" onClick={() => uploadController.current?.abort()}>Cancel upload</button>}
            </div>
            <div className="send-group">{draft.length > 7000 && <small>{draft.length}/{LIMITS.inputCharacters}</small>}
              {busy || remoteBusy ? <button type="button" className="send-button stop" aria-label="Stop reply" onClick={() => void stop()}><Square size={17} fill="currentColor" /></button> :
                <button type="submit" className="send-button" aria-label="Send message" disabled={!draft.trim() || locked || !modelAvailable}><ArrowUp size={21} /></button>}
            </div>
          </div>
          <div className="attachment-actions">
            <p className="attachment-hint">Select multiple files, drop them here, or paste images. Send includes all attached files.</p>
            {(pending.length > 0 || transfers.some(transfer => transfer.error)) && <button type="button" className="voice-button" disabled={!draft.trim() || locked || !modelAvailable} onClick={() => void send(undefined, true)}>Send text only</button>}
          </div>
        </form>
        <div className="composer-caption"><span>{draftState === "saving" ? "Saving draft..." : draftState === "error" ? "Draft not saved — retry before leaving" : "Draft saved"} · {replyRunning ? "Reply in progress — keep writing; Send is available when it finishes or you press Stop" : dictationAvailable ? "Enter to send · Shift + Enter for a new line" : "Text chat is ready"}</span><button onClick={() => setSettings(true)}>Files & privacy <ShieldCheck size={12} /></button></div>
        <div className="disclaimer">AI can make mistakes. Your prompts and file text are sent to GitHub Copilot.</div>
      </div>
    </main>
    {settings && <Dialog title="Your space, your settings" onClose={() => setSettings(false)}>
      <div className="settings-account"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><p>{user.email}</p></div></div>
      <div className="settings-section"><h3><ShieldCheck size={16} /> {access.tunnelMode ? "Temporary remote access" : "Personal, local-only"}</h3><p>{access.tunnelMode ? "A temporary Cloudflare HTTPS tunnel is active. Anyone with the link can create an email/password account without OTP. This link uses the app's password login, not Cloudflare Access. Cloudflare relays the traffic. Stop the tunnel when finished." : "This app listens on 127.0.0.1 only. Use only the app's explicit temporary-tunnel mode for remote access; do not otherwise expose it through a proxy, LAN or the internet."} App accounts have separate histories and files, but all use the host owner&apos;s Copilot account and usage limits.</p><p>Histories and original files stay in this app&apos;s local SQLite database. Prompts, chat context and extracted file text go to GitHub Copilot when you send. These are not end-to-end encrypted; people with access to your Windows account or backups can read local data.</p></div>
      <div className="settings-section"><h3><span className={`status-dot ${connectionError ? "offline" : ""}`} /> Copilot connection</h3><p>{connectionError || `${models.length} models discovered from the Copilot SDK. Availability may differ from the desktop app and can change with your plan.`}</p><p>Already signed-in CLI credentials are reused through supported SDK authentication. If sign-in is needed, run this from the app folder:</p><code className="command">npm run copilot:login</code><button className="secondary-button" onClick={() => void refreshModels()} disabled={modelLoading}><RefreshCw size={14} /> Refresh connection</button></div>
      <div className="settings-section"><h3><FileText size={16} /> Files and model context</h3>
        <p>Select multiple supported files together, add another selection, drag files onto the composer or paste images. Three files can transfer concurrently per account, six across the app. Each shows progress and can be removed. Processing continues in the background.</p>
        <p>Send includes every attached file, not just the first four. Unfinished or failed attachments must finish or be retried/removed; Send text only explicitly leaves attachments for later. Full extracted text is retained and indexed. Requests use labeled excerpts within a shared context budget adjusted for conversation history, rather than silently dropping files.</p>
        <p>If current images or video frames exceed the model&apos;s per-request image allowance, additional real Copilot requests analyze the overflow at the supplied pixel detail. They use extra quota; one final reply combines the results. Completed per-image analyses are saved. Earlier images are represented by these saved analyses or prior conversation, not claimed to be freshly re-viewed. Reattach an original if a later question needs a fresh pixel inspection. Descriptions can miss details; originals remain available.</p>
        <p>TXT, Markdown, CSV, JSON, LOG, YAML/XML, selectable-text PDF, DOCX, XLSX, PNG/JPEG/WebP/static GIF, and the listed audio/video formats remain supported. There is no preset total file-size or storage quota; disk reserves and decoder safeguards still apply. Images are normalized for model input (16 MP/8192-pixel source limit); video frames have a 4096-pixel limit. No scanned-PDF OCR, macros or executable uploads. Context and model output remain finite; original files and saved prompts are not truncated.</p>
        <p>Download originals from message chips. X removes unsent files; deleting a chat removes its files and saved image analyses. Histories and drafts survive user/chat switches. Up to 100 chats and 100 turns per chat remain.</p>
      </div>
      <div className="settings-section"><h3><Code2 size={16} /> Code runner (files, charts, animations)</h3><p>{sandboxInfo?.message || "Checking the code runner..."}</p>{sandboxInfo?.ready && <><p>Ask for a PDF report, chart, GIF/MP4 animation, or Word/Excel/PowerPoint file. The model writes Python that runs in a disposable Linux sandbox on this computer (WSL). Each run has <strong>no internet or network access</strong>, cannot install packages, cannot see Windows, other chats or other users, and is deleted afterwards. Only files from this chat that the model selects are copied in.{sandboxInfo.limits && <> Limits per run: about {sandboxInfo.limits.wallSeconds} seconds, {sandboxInfo.limits.cpus} CPUs, {Math.round(sandboxInfo.limits.memoryBytes / 1024 ** 3)} GB memory, {Math.round(sandboxInfo.limits.workBytes / 1024 ** 2)} MB scratch space and {sandboxInfo.limits.outputFiles} output files; up to 8 runs per reply.</>}</p><p>Available libraries: {sandboxInfo.libraries.join(", ")}. Only the host owner can add libraries, using a command on this computer; they cannot be installed from chat.</p><p>Results are attached to the reply as downloads. PNG/JPEG/GIF/WebP images, MP4/WebM videos and PDFs also get previews; other types such as HTML or SVG are download-only. Generated code can be wrong; check important results. Runs use the host owner&apos;s Copilot quota like any message.</p></>}</div>
      <div className="settings-section"><h3><Mic size={16} /> Local audio/video processing</h3><p>{mediaInfo?.message || "Checking local media configuration..."} {mediaInfo?.ready && <>Whisper model: {mediaInfo.model}, running on this computer&apos;s CPU.</>}</p><p>MP3, WAV, M4A, AAC, FLAC, OGG, OPUS, MP4, MOV, WEBM, MKV and AVI are accepted when their streams are decodable. Speech becomes a machine transcript; video also supplies up to four still frames. Copilot receives those extracted inputs when you press Send, not native audio/video. Transcription can be imperfect, and unsampled visual events may be missed.</p><p>One recording and one document can process at a time; others wait in a durable queue. No media-duration or overall-processing deadline is imposed. Long recordings are decoded/transcribed in bounded-memory windows, and processing may take a long time. Closing the browser does not discard accepted uploads. Interrupted jobs resume from the beginning after a server restart. Administrator-created delegated jobs stop if that administrator loses access or signs out. Transcription uses installed local packages/cached weights, without a speech API key. Public-link uploads pass through Cloudflare.</p></div>
      <div className="settings-section"><h3><ShieldCheck size={16} /> Administrator access</h3><p>The app superuser can view users&apos; chat sessions and files and act as a user to send messages or modify chats. An audit log records the real actor, effective user, action, object IDs, time and outcome—not prompt/file contents or credentials. {acting && <>You are still signed in as {actor?.email}; signing out ends that real login session.</>}</p></div>
      <div className="settings-section"><h3><Mic size={16} /> Voice, without the surprises</h3><p>Dictation uses browser speech recognition, not a realtime audio model. Your browser may send microphone audio to its speech provider. Read-aloud uses your browser&apos;s voices, which may also use an online service. Text works without either feature.</p><p>No email verification, password reset, or recovery service is configured. Use a unique password and keep a local backup. A temporary shared preview is not production hosting.</p></div>
      <button className="secondary-button logout" onClick={() => void logout()} disabled={uploading || demoLoading}><LogOut size={16} /> Sign out{busy ? " and stop reply" : ""}</button>
    </Dialog>}
    {rename && <Dialog title="Rename conversation" onClose={() => setRename(null)}><form onSubmit={saveTitle}><label className="field-label" htmlFor="chat-title">Conversation name</label><input autoFocus id="chat-title" maxLength={80} required value={editingTitle} onChange={event => setEditingTitle(event.target.value)} /><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setRename(null)}>Cancel</button><button className="primary-button" disabled={!editingTitle.trim()}>Save name</button></div></form></Dialog>}
    {deleteChat && <Dialog title="Delete this conversation?" onClose={() => setDeleteChat(null)}><p><strong>{deleteChat.title}</strong> and its messages and files will be removed from this app. This cannot be undone. Existing backups are not erased.</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteChat(null)}>Keep it</button><button className="danger-button" onClick={() => void confirmDelete()}>Delete conversation</button></div></Dialog>}
    {voiceDialog && <Dialog title="A quick note about dictation" onClose={() => setVoiceDialog(false)}><p>Your browser may send audio to its speech-recognition service. Dictation is not processed locally by this app or by the selected chat model. Review and edit the transcript before sending.</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setVoiceDialog(false)}>Keep typing</button><button className="primary-button" onClick={() => { setVoiceConsent(true); setVoiceDialog(false); setNotice("Dictation enabled for this sign-in. Click Dictate to start the microphone."); }}>I understand</button></div></Dialog>}
    {navigation}
    {filePreview && <Dialog title={filePreview.name} onClose={() => setFilePreview(null)}><p>{filePreview.notes}</p><pre className="extracted-text">{filePreview.text}</pre><div className="dialog-actions"><button className="secondary-button" disabled={filePreview.cursor === 0} onClick={() => void previewFile(filePreview.file, Math.max(0, filePreview.cursor - 8))}>Previous text page</button><button className="secondary-button" disabled={filePreview.nextCursor === null} onClick={() => { if (filePreview.nextCursor !== null) void previewFile(filePreview.file, filePreview.nextCursor); }}>Next text page</button></div></Dialog>}
    {admin && actor?.appRole === "superuser" && !acting && <Dialog title="Users & audit" onClose={() => setAdmin(false)}><AdminPanel request={api} actorId={actor.id} busy={locked} onAct={actAs} /></Dialog>}
  </div>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="dialog" aria-label={title} onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="dialog-heading"><h2>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={19} /></IconButton></div>
    {children}
  </dialog>;
}

function AuthScreen({ onSuccess, notice, access, onMenu }: { onSuccess: (account: AccountView) => void; notice: string; access: { registrationAllowed: boolean; tunnelMode: boolean }; onMenu: () => void }) {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await requestJson(`/api/auth/${signup ? "sign-up" : "sign-in"}/email`, {
        method: "POST", body: JSON.stringify({ email: email.trim(), password }),
      });
      const result = await requestJson<AccountView>("/api/account");
      setPassword(""); onSuccess(result);
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  return <main className="auth-page">
    <button className="menu-button auth-menu" type="button" onClick={onMenu}><Menu size={18} /><span>Menu</span></button>
    <section className="auth-story"><Brand /><div><span className="eyebrow">LESS FRICTION. MORE POSSIBILITY.</span><h1>Many models.<br />One conversation<br />at a time.</h1><p>A small, considered space to think out loud,<br />understand your files, and make things clearer.</p><div className="auth-features"><span><Check size={16} /> Your Copilot models</span><span><Check size={16} /> Text, voice & documents</span><span><Check size={16} /> History that stays with you</span></div></div><span className="auth-local"><ShieldCheck size={16} /> Local interface. Connected intelligence.</span></section>
    <section className="auth-side">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-mobile-brand"><Brand /></div>
        <div className="eyebrow">WELCOME TO YOUR SPACE</div>
        <h2>{signup ? "Make yourself at home." : "Good to have you back."}</h2>
        <p>{signup ? "Quick signup with an email and password. Gmail works too. No OTP or verification email." : "Sign in with your Model Chat email and password. No OTP needed."}</p>
        {(error || notice) && <div className="auth-error" role="alert">{error || notice}</div>}
        <label htmlFor="email">Email</label><input id="email" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} placeholder="you@example.com" />
        <label htmlFor="password">Password</label><input id="password" type="password" autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} required minLength={signup ? 12 : 1} maxLength={128} placeholder={signup ? "At least 12 characters" : "Your password"} />
        {signup && <small className="password-note">Use a unique password, not your Gmail password. This is not Google sign-in. No password recovery is configured.</small>}
        <button className="primary-button auth-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : signup ? "Create account" : "Sign in"}{!busy && <ArrowUp size={17} className="arrow-right" />}</button>
        {access.registrationAllowed && <div className="auth-toggle">{signup ? "Already have a space?" : "First time here?"}<button type="button" onClick={() => { setSignup(!signup); setError(""); setPassword(""); }}>{signup ? "Sign in" : "Create an account"}</button></div>}
        <div className="auth-boundary"><ShieldCheck size={17} /><span>{access.tunnelMode ? "Public signup is open. All model requests use the host owner's Copilot quota. Cloudflare relays traffic." : "Accounts are local to this app, not GitHub accounts. All share this machine's Copilot entitlement. Loopback access only."} Ordinary accounts have separate histories. The app superuser can view your chats/files and act as you; administrator actions are audited.</span></div>
      </form>
    </section>
  </main>;
}
