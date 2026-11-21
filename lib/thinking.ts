/** Reasoning ("thinking") levels in the order the Copilot catalogue uses them. Shared by the server and the browser. */
export const THINKING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export const DEFAULT_THINKING: ThinkingLevel = "medium";
export const THINKING_LABELS: Record<ThinkingLevel, string> = { none: "Off", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}
/** The catalogue's levels for a model, in order; empty when the model has no adjustable reasoning. */
export function orderedLevels(levels: readonly string[] | undefined): ThinkingLevel[] {
  return THINKING_LEVELS.filter(level => levels?.includes(level));
}
/** The requested level if the model supports it, otherwise the closest supported one (the lower one on a tie); medium when nothing was chosen. */
export function nearestLevel(levels: readonly string[] | undefined, wanted?: string | null): ThinkingLevel | undefined {
  const supported = orderedLevels(levels);
  if (!supported.length) return undefined;
  const target = isThinkingLevel(wanted) ? wanted : DEFAULT_THINKING;
  if (supported.includes(target)) return target;
  const index = THINKING_LEVELS.indexOf(target);
  return supported.reduce((best, level) => Math.abs(THINKING_LEVELS.indexOf(level) - index) < Math.abs(THINKING_LEVELS.indexOf(best) - index) ? level : best);
}
