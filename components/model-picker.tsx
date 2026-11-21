"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Brain, Check, ChevronDown, Eye } from "lucide-react";
import type { Model } from "@/lib/contracts";
import { nearestLevel, orderedLevels, THINKING_LABELS, type ThinkingLevel } from "@/lib/thinking";

const SHORT: Record<ThinkingLevel, string> = { none: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "X-High", max: "Max" };

/**
 * The model menu in the message box: full model names plus, for models with adjustable reasoning, a Thinking row with exactly the
 * levels that model supports. The closed button shows the model and, subtly, its level.
 */
export function ModelPicker({ models, value, thinking, disabled, loading, onModel, onThinking }: {
  models: Model[]; value: string; thinking: string | null | undefined; disabled: boolean; loading: boolean;
  onModel: (id: string) => void; onThinking: (level: ThinkingLevel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = models.find(model => model.id === value);
  const levels = orderedLevels(current?.levels);
  const level = nearestLevel(current?.levels, thinking);
  const name = current?.name || (loading ? value || "Connecting…" : value ? `${value} (unavailable)` : "No models");
  useEffect(() => {
    if (!open) return;
    // The message box scrolls, so the menu is fixed to the viewport just above the button.
    const place = () => {
      const box = button.current?.getBoundingClientRect();
      if (box) setAnchor({ right: Math.max(8, window.innerWidth - box.right), bottom: Math.max(8, window.innerHeight - box.top + 8) });
    };
    place();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", place);
    const selected = root.current?.querySelector<HTMLInputElement>('input[name="model"]:checked') ?? root.current?.querySelector<HTMLInputElement>('input[name="model"]');
    selected?.focus({ preventScroll: true });
    const list = root.current?.querySelector<HTMLElement>(".model-scroll");
    const row = selected?.closest("label");
    if (list && row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - row.offsetHeight) / 2;
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div className="model-picker" ref={root}>
    <button type="button" ref={button} className="model-pill" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} data-model={value} data-thinking={level ?? ""}
      aria-label={`Model: ${name}${level ? `, thinking ${THINKING_LABELS[level]}` : ""}`} title="Model and thinking level for the next message" onClick={() => setOpen(value => !value)}>
      <span className="model-pill-name">{name}</span>{level && <span className="model-pill-level">{SHORT[level]}</span>}<ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div className="model-menu" id={menuId} role="dialog" aria-label="Model and thinking" style={anchor ? { right: anchor.right, bottom: anchor.bottom } : { visibility: "hidden" }}>
      <div className="model-scroll">
      <fieldset className="model-list">
        <legend>Model</legend>
        {models.map(model => <label key={model.id} className={`model-option ${model.id === value ? "selected" : ""}`}>
          <input type="radio" name="model" value={model.id} aria-label={model.name} checked={model.id === value} onChange={() => onModel(model.id)} />
          <span className="model-option-name">{model.name}</span>
          <span className="model-option-meta">
            {model.levels?.length ? <Brain size={13} aria-label="Adjustable thinking" /> : null}
            {model.vision ? <Eye size={13} aria-label="Reads images" /> : null}
            {model.multiplier !== undefined && model.multiplier !== 1 ? <small>{model.multiplier}×</small> : null}
          </span>
          {model.id === value && <Check size={15} className="model-option-check" aria-hidden="true" />}
        </label>)}
      </fieldset>
      </div>
      {levels.length > 0 && <fieldset className="thinking-row">
        <legend><Brain size={14} aria-hidden="true" /> Thinking</legend>
        <div className="thinking-levels">
          {levels.map(item => <label key={item} className={item === level ? "selected" : ""} title={THINKING_LABELS[item]}>
            <input type="radio" name="thinking" value={item} aria-label={THINKING_LABELS[item]} checked={item === level}
              onChange={() => onThinking(item)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); setOpen(false); button.current?.focus(); } }} />
            <span onPointerUp={() => setTimeout(() => setOpen(false), 0)}>{SHORT[item]}</span>
          </label>)}
        </div>
        <small className="thinking-hint">{level === "none" ? "No reasoning: fastest answers." : level === "max" || level === "xhigh" ? "Most reasoning: slower answers." : "Higher levels think longer before answering."}</small>
      </fieldset>}
    </div>}
  </div>;
}
