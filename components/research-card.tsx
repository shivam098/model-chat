"use client";

import { useEffect, useState } from "react";
import { BookOpenText, Check, CircleAlert, FileText, LoaderCircle, PenLine, Search, Telescope, X } from "lucide-react";
import type { ResearchEntry, ResearchView } from "@/lib/contracts";

export const ACTIVE_RESEARCH: ResearchView["state"][] = ["planning", "awaiting_start", "running", "writing"];
const ICONS: Record<ResearchEntry["kind"], typeof Search> = { plan: Telescope, search: Search, read: BookOpenText, skip: CircleAlert, write: PenLine, note: FileText };

function duration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
function Activity({ log, limit }: { log: ResearchEntry[]; limit?: number }) {
  const items = limit ? log.slice(-limit) : log;
  return <ol className="research-log">
    {items.map((item, index) => {
      const Icon = ICONS[item.kind] || FileText;
      return <li key={`${item.at}-${index}`} className={`research-entry ${item.kind}`}><Icon size={14} aria-hidden="true" />
        {item.url && (item.kind === "read" && item.text.startsWith("Read:"))
          ? <a href={item.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">{item.text}</a> : <span>{item.text}</span>}</li>;
    })}
  </ol>;
}

/** Deep research in a reply: plan review before anything runs, live progress while it works, and its details once the report is in. */
export function ResearchCard({ research, deciding, onStart, onCancel }: {
  research: ResearchView; deciding: boolean; onStart: (plan?: string[]) => void; onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const running = research.state === "running" || research.state === "writing";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const counts = `${research.counts.searches} of ${research.limits.searches} searches · ${research.counts.pages} of ${research.limits.pages} pages`;
  if (research.state === "planning") return <div className="research-card" role="status">
    <div className="research-head"><LoaderCircle className="spin" size={16} aria-hidden="true" /><strong>Drafting a research plan…</strong></div>
    <p className="research-note">You&apos;ll review the plan before any searching starts.</p>
  </div>;
  if (research.state === "awaiting_start") {
    const steps = editing ? text.split("\n").map(line => line.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean) : research.plan;
    return <div className="research-card plan" role="group" aria-label="Research plan">
      <div className="research-head"><Telescope size={16} aria-hidden="true" /><strong>{research.title || "Research plan"}</strong></div>
      {editing ? <>
        <label className="sr-only" htmlFor={`plan-${research.id}`}>Plan steps, one per line</label>
        <textarea id={`plan-${research.id}`} className="research-edit" value={text} rows={Math.min(10, Math.max(4, research.plan.length + 1))} onChange={event => setText(event.target.value)} />
        <small className="research-note">One step per line, up to 7.</small>
      </> : <ol className="research-plan">{research.plan.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      <p className="research-note">Runs in the background, so you can close this tab. Uses up to {research.limits.searches} searches and {research.limits.pages} full pages, at most {research.limits.minutes} minutes.</p>
      <div className="research-actions">
        <button type="button" className="primary-button" disabled={deciding || !steps.length || steps.length > 7} onClick={() => onStart(editing ? steps : undefined)}><Check size={16} />Start research</button>
        {editing ? <button type="button" className="secondary-button" disabled={deciding} onClick={() => setEditing(false)}>Keep original</button>
          : <button type="button" className="secondary-button" disabled={deciding} onClick={() => { setText(research.plan.map((step, index) => `${index + 1}. ${step}`).join("\n")); setEditing(true); }}><PenLine size={16} />Edit plan</button>}
        <button type="button" className="text-button" disabled={deciding} onClick={onCancel}><X size={14} />Cancel</button>
      </div>
    </div>;
  }
  if (running) return <div className="research-card running" role="status" aria-live="polite">
    <div className="research-head"><LoaderCircle className="spin" size={16} aria-hidden="true" />
      <strong>{research.state === "writing" ? "Writing the report" : "Researching"}</strong>
      <span className="research-time">{duration(now - (research.startedAt || now))}</span>
    </div>
    <p className="research-counts">{counts}</p>
    <Activity log={research.log.filter(item => item.kind !== "plan")} limit={6} />
    <details className="research-details"><summary>Plan</summary><ol className="research-plan">{research.plan.map((step, index) => <li key={index}>{step}</li>)}</ol></details>
  </div>;
  const took = research.startedAt && research.finishedAt ? ` · ${duration(research.finishedAt - research.startedAt)}` : "";
  return <details className={`research-card done ${research.state}`}>
    <summary><Telescope size={14} aria-hidden="true" />{research.state === "complete" ? "Deep research" : research.state === "cancelled" ? "Research stopped" : "Research didn't finish"} · {research.counts.searches} searches · {research.counts.pages} pages{took}</summary>
    {research.plan.length > 0 && <><h4>Plan</h4><ol className="research-plan">{research.plan.map((step, index) => <li key={index}>{step}</li>)}</ol></>}
    <h4>Activity</h4>
    <Activity log={research.log} />
    <p className="research-note">{research.counts.requests} model requests ({research.counts.userRequests} user-initiated){research.counts.failedPages ? ` · ${research.counts.failedPages} page${research.counts.failedPages === 1 ? "" : "s"} couldn't be read` : ""}.</p>
  </details>;
}
