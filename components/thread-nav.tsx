"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown, ChevronDown, ChevronUp, ListOrdered, X } from "lucide-react";

export interface NavItem { id: string; text: string; time: string }
const firstLine = (text: string) => {
  const line = text.split("\n").find(part => part.trim())?.trim() || "(attachments only)";
  return line.length > 90 ? `${line.slice(0, 88)}…` : line;
};

/**
 * Finding your way around a long conversation: a slim rail of markers (one per message you sent) along the right edge, with a preview on
 * hover and a jump on click; previous/next buttons and Alt+↑/↓; "Jump to latest" when scrolled up; on phones, a sheet listing your messages.
 */
export function ThreadNav({ items, scroller, onJump, atBottom, onLatest }: { items: NavItem[]; scroller: RefObject<HTMLDivElement | null>; onJump: (id: string) => void; atBottom: boolean; onLatest: () => void }) {
  const [positions, setPositions] = useState<number[]>([]);
  const [active, setActive] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const frame = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const box = node.getBoundingClientRect();
        const tops = itemsRef.current.map(item => {
          const element = node.querySelector<HTMLElement>(`[data-message-id="${item.id}"]`);
          return element ? element.getBoundingClientRect().top - box.top + node.scrollTop : 0;
        });
        const height = Math.max(1, node.scrollHeight);
        setPositions(tops.map(top => Math.min(98, Math.max(2, (top / height) * 100))));
        // The message you're reading: the last one starting at (or above) the top of the view; at the very bottom, the last one.
        const line = node.scrollTop + 48;
        let current = -1;
        tops.forEach((top, index) => { if (top <= line) current = index; });
        const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 8 && (tops.at(-1) ?? 0) >= node.scrollTop;
        setActive(atEnd ? tops.length - 1 : Math.max(0, current));
      });
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const list = node.querySelector(".message-list");
    if (list) observer.observe(list);
    return () => { node.removeEventListener("scroll", measure); observer.disconnect(); cancelAnimationFrame(frame.current); };
  }, [scroller, items]);

  const step = (direction: -1 | 1) => {
    const list = itemsRef.current;
    if (!list.length) return;
    const node = scroller.current;
    // Moving up from inside a long message first returns to its start.
    const current = activeRef.current < 0 ? (direction > 0 ? -1 : list.length) : activeRef.current;
    let target = current + direction;
    if (direction < 0 && node && current >= 0 && current < list.length) {
      const element = node.querySelector<HTMLElement>(`[data-message-id="${list[current].id}"]`);
      if (element && element.getBoundingClientRect().top < node.getBoundingClientRect().top - 24) target = current;
    }
    if (target >= 0 && target < list.length) onJump(list[target].id);
    else if (direction > 0) onLatest();
  };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      if (document.querySelector("[role=dialog]")) return;
      event.preventDefault();
      step(event.key === "ArrowUp" ? -1 : 1);
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onJump, onLatest]);

  return <>
    {items.length > 1 && <nav className="thread-nav" aria-label="Your messages in this conversation">
      <button type="button" className="thread-step" aria-label="Previous message" title="Previous message (Alt+↑)" onClick={() => step(-1)}><ChevronUp size={16} /></button>
      <div className="thread-track">
        {items.map((item, index) => <button type="button" key={item.id} className={`thread-mark ${index === active ? "active" : ""}`} style={{ top: `${positions[index] ?? (index + 1) / (items.length + 1) * 100}%` }}
          aria-label={`Jump to your message ${index + 1} of ${items.length}: ${firstLine(item.text)}`} aria-current={index === active ? "location" : undefined} onClick={() => onJump(item.id)}>
          <span className="thread-tip" aria-hidden="true"><small>{index + 1} · {item.time}</small>{firstLine(item.text)}</span>
        </button>)}
      </div>
      <button type="button" className="thread-step" aria-label="Next message" title="Next message (Alt+↓)" onClick={() => step(1)}><ChevronDown size={16} /></button>
    </nav>}
    {items.length > 1 && <button type="button" className="thread-list-button" aria-label="Your messages" title="Your messages in this conversation" aria-expanded={sheet} onClick={() => setSheet(true)}><ListOrdered size={18} /></button>}
    {!atBottom && <button type="button" className="jump-latest" aria-label="Jump to latest" title="Jump to latest (Alt+↓ past the last message)" onClick={onLatest}><ArrowDown size={16} /><span>Latest</span></button>}
    {sheet && <div className="thread-sheet-backdrop" onClick={() => setSheet(false)}>
      <div className="thread-sheet" role="dialog" aria-modal="true" aria-label="Your messages" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") setSheet(false); }}>
        <header><h2>Your messages</h2><button type="button" className="icon-button" aria-label="Close" autoFocus onClick={() => setSheet(false)}><X size={18} /></button></header>
        <ol>{items.map((item, index) => <li key={item.id}><button type="button" aria-current={index === active ? "location" : undefined} onClick={() => { setSheet(false); onJump(item.id); }}>
          <span className="thread-sheet-number">{index + 1}</span><span className="thread-sheet-text">{firstLine(item.text)}</span><time>{item.time}</time>
        </button></li>)}</ol>
      </div>
    </div>}
  </>;
}
