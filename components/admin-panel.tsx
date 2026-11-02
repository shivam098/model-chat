"use client";

import { useEffect, useState } from "react";
import type { AppUser, AuditEvent } from "@/lib/access";
import type { Chat } from "@/lib/contracts";

type RequestFn = <T>(url: string, init?: RequestInit) => Promise<T>;
export function AdminPanel({ request, actorId, busy, onAct }: {
  request: RequestFn; actorId: string; busy: boolean; onAct: (userId: string, chatId?: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"users" | "audit">("users");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [users, setUsers] = useState<(AppUser & { chatCount: number })[]>([]);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<AppUser | null>(null);
  const [chatQuery, setChatQuery] = useState("");
  const [chatOffset, setChatOffset] = useState(0);
  const [chats, setChats] = useState<Chat[]>([]);
  const [moreChats, setMoreChats] = useState(false);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [before, setBefore] = useState(Number.MAX_SAFE_INTEGER);
  const [moreAudit, setMoreAudit] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    const timer = setTimeout(() => {
      const load = tab === "users"
        ? request<{ users: (AppUser & { chatCount: number })[]; hasMore: boolean }>(`/api/admin/users?q=${encodeURIComponent(query)}&offset=${offset}`).then(result => {
          if (alive) { setUsers(result.users); setMore(result.hasMore); }
        })
        : request<{ events: AuditEvent[]; hasMore: boolean }>(`/api/admin/audit?before=${before}`).then(result => {
          if (alive) { setAudit(result.events); setMoreAudit(result.hasMore); }
        });
      load.catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load administration."); })
        .finally(() => { if (alive) setLoading(false); });
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
    // The caller binds every request to its current server-authorized workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query, offset, before, refresh]);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setError("");
    const timer = setTimeout(() => {
      request<{ chats: Chat[]; hasMore: boolean }>(`/api/admin/users/${selected.id}/chats?q=${encodeURIComponent(chatQuery)}&offset=${chatOffset}`)
        .then(result => { if (alive) { setChats(result.chats); setMoreChats(result.hasMore); } })
        .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load chat sessions."); });
    }, 200);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, chatQuery, chatOffset]);
  return <div className="admin-panel">
    <p>Administration applies only to this app. Acting as a user can read and change their chats and files. The real actor remains your superuser account, and access and changes are audited without logging message or file contents.</p>
    <div className="admin-tabs">
      <button className="secondary-button" aria-pressed={tab === "users"} onClick={() => setTab("users")}>Users &amp; chat sessions</button>
      <button className="secondary-button" aria-pressed={tab === "audit"} onClick={() => { setTab("audit"); setBefore(Number.MAX_SAFE_INTEGER); }}>Audit log</button>
      <button className="secondary-button" onClick={() => setRefresh(value => value + 1)}>Refresh</button>
    </div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {loading && <p role="status">Loading...</p>}
    {tab === "users" ? <>
      <label className="field-label" htmlFor="admin-user-search">Search users by name or email</label>
      <input id="admin-user-search" value={query} maxLength={100} onChange={event => { setQuery(event.target.value); setOffset(0); }} />
      <div className="admin-users">{users.map(user => <div className="admin-user" key={user.id}>
        <div><strong>{user.name}</strong><span>{user.email}</span><small>{user.appRole} · {user.chatCount} chat sessions</small></div>
        {user.id === actorId ? <small>Your account</small> : user.appRole === "superuser" ? <small>Cannot impersonate a superuser</small> : <div className="admin-row-actions">
          <button className="secondary-button" onClick={() => { setSelected(user); setChatQuery(""); setChatOffset(0); setChats([]); }}>View sessions</button>
          <button className="primary-button" disabled={busy} onClick={() => void onAct(user.id)}>Act as user</button>
        </div>}
      </div>)}</div>
      {!loading && !users.length && <p>No matching users.</p>}
      <div className="admin-pagination"><button disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 25))}>Previous users</button><button disabled={!more} onClick={() => setOffset(value => value + 25)}>Next users</button></div>
      {selected && <section className="settings-section">
        <h3>Chat sessions: {selected.email}</h3>
        <label className="field-label" htmlFor="admin-chat-search">Search chat titles</label>
        <input id="admin-chat-search" value={chatQuery} maxLength={100} onChange={event => { setChatQuery(event.target.value); setChatOffset(0); }} />
        <div className="admin-users">{chats.map(chat => <div className="admin-user" key={chat.id}>
          <div><strong>{chat.title}</strong><small>{chat.model || "No model selected"} · {new Date(chat.updatedAt).toLocaleString()}</small></div>
          <button className="primary-button" disabled={busy} onClick={() => void onAct(selected.id, chat.id)}>Open as user</button>
        </div>)}</div>
        {!chats.length && <p>No matching chat sessions.</p>}
        <div className="admin-pagination"><button disabled={!chatOffset} onClick={() => setChatOffset(value => Math.max(0, value - 25))}>Previous chats</button><button disabled={!moreChats} onClick={() => setChatOffset(value => value + 25)}>Next chats</button></div>
      </section>}
    </> : <>
      <p>Actor and subject are account IDs, not login tokens. A local role change is labeled “Local operator”.</p>
      <div className="audit-list">{audit.map(event => <article className="audit-event" key={event.id}>
        <div><strong>{event.action}</strong><span>{event.outcome}</span><time>{new Date(event.at).toLocaleString()}</time></div>
        <dl><dt>Actor</dt><dd>{event.actorId || (event.reason?.startsWith("local_console:") ? "Local operator" : "Unauthenticated")}</dd>
          <dt>Subject</dt><dd>{event.subjectId || "—"}</dd><dt>Object</dt><dd>{event.objectId || "—"}</dd>
          {event.reason && <><dt>Outcome detail</dt><dd>{event.reason}</dd></>}</dl>
      </article>)}</div>
      <div className="admin-pagination"><button onClick={() => setBefore(Number.MAX_SAFE_INTEGER)}>Newest events</button><button disabled={!moreAudit} onClick={() => setBefore(audit.at(-1)?.id ?? before)}>Older events</button></div>
    </>}
  </div>;
}
