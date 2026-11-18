import type { PermissionRequest } from "@github/copilot-sdk";
import { classifyPath, mentionsBlocked } from "./paths";

/** Session-scoped approvals kept by Model Chat (never delegated to the runtime, so every request still reaches this policy). */
export interface Allowances { commands: Set<string>; writes: boolean; domains: Set<string> }
export function emptyAllowances(): Allowances { return { commands: new Set(), writes: false, domains: new Set() }; }

export interface ApprovalCard {
  kind: "command" | "write" | "read" | "url";
  /** The exact command, path or URL the owner approves. */
  subject: string;
  intention?: string;
  diff?: string;
  outside: boolean;
  warning?: string;
  /** What "Allow for this session" covers; absent when only a one-time approval is offered. */
  sessionScope?: string;
  commandIds?: string[];
  domain?: string;
}
export type Gate = { action: "approve" } | { action: "reject"; reason: string } | { action: "ask"; card: ApprovalCard };

const unique = (values: string[]) => [...new Set(values.map(value => value.toLowerCase()).filter(Boolean))];
// Launches that escape the shell tool's tracking: Model Chat couldn't list or stop what they start.
const UNTRACKED_LAUNCH = /\b(Start-Process|Start-Job|Start-ThreadJob|nohup|disown|setsid)\b|(^|[;|\n]|&&)\s*(start|saps)\s+\S|(^|[^&])&\s*$/im;
export const untrackedLaunch = (command: string) => UNTRACKED_LAUNCH.test(command);

export function gate(request: PermissionRequest, project: string, allowances: Allowances): Gate {
  const managed = Boolean(request.managedApprovalRequired);
  switch (request.kind) {
    case "shell": {
      const paths = request.possiblePaths || [];
      if (mentionsBlocked(request.fullCommandText) || paths.some(item => classifyPath(item, project) === "blocked")) {
        return { action: "reject", reason: "The command touches Model Chat's data, credentials or secret files, which coding mode never allows." };
      }
      if (untrackedLaunch(request.fullCommandText)) {
        return { action: "reject", reason: "Model Chat can't list or stop processes started this way. Run long-running commands with the shell tool in mode \"async\" (without detach) instead." };
      }
      const outside = paths.some(item => classifyPath(item, project) === "outside");
      const ids = unique(request.commands.map(command => command.identifier));
      const bypass = Boolean(request.requestSandboxBypass);
      if (!managed && !outside && !bypass && ids.length && ids.every(id => allowances.commands.has(id))) return { action: "approve" };
      return { action: "ask", card: {
        kind: "command", subject: request.fullCommandText, intention: request.intention, outside, commandIds: ids,
        warning: [request.warning, bypass ? request.requestSandboxBypassReason || "Runs outside the runtime's sandbox." : "", outside ? "May read or change files outside the project folder." : ""].filter(Boolean).join(" ") || undefined,
        sessionScope: ids.length && !outside && !bypass && request.canOfferSessionApproval ? `${ids.join(", ")} commands in this project` : undefined,
      } };
    }
    case "write": {
      const zone = classifyPath(request.fileName, project);
      if (zone === "blocked") return { action: "reject", reason: "That file is Model Chat data, a credential or a secret file; coding mode never changes it." };
      if (!managed && zone === "project" && allowances.writes && !request.requestSandboxBypass) return { action: "approve" };
      return { action: "ask", card: {
        kind: "write", subject: request.fileName, intention: request.intention, diff: request.diff || request.newFileContents, outside: zone === "outside",
        warning: zone === "outside" ? "This file is outside the project folder." : undefined,
        sessionScope: zone === "project" ? "file changes in this project" : undefined,
      } };
    }
    case "read": {
      const zone = classifyPath(request.path, project);
      if (zone === "blocked") return { action: "reject", reason: "That location holds credentials, secrets or Model Chat's data; coding mode never reads it." };
      if (zone === "project" && !managed && !request.requestSandboxBypass) return { action: "approve" };
      return { action: "ask", card: { kind: "read", subject: request.path, intention: request.intention, outside: zone === "outside", warning: "Reads outside the project folder." } };
    }
    case "url": {
      let domain = "";
      try { domain = new URL(request.url).hostname.toLowerCase(); } catch { return { action: "reject", reason: "Invalid URL." }; }
      if (!managed && allowances.domains.has(domain)) return { action: "approve" };
      return { action: "ask", card: { kind: "url", subject: request.url, intention: request.intention, outside: false, domain, sessionScope: `pages on ${domain}` } };
    }
    default:
      return { action: "reject", reason: `Coding mode doesn't allow ${request.kind} requests.` };
  }
}

export type Decision = "once" | "session" | "deny";
/** Applies an owner decision. Session approvals are remembered here; the runtime only ever receives one-time approvals. */
export function applyDecision(card: ApprovalCard, decision: Decision, allowances: Allowances) {
  if (decision === "deny") return { kind: "reject" as const, feedback: "The owner denied this request. Ask before trying an alternative." };
  if (decision === "session" && card.sessionScope) {
    if (card.kind === "command") for (const id of card.commandIds || []) allowances.commands.add(id);
    if (card.kind === "write") allowances.writes = true;
    if (card.kind === "url" && card.domain) allowances.domains.add(card.domain);
  }
  return { kind: "approve-once" as const, approvedInteractively: true };
}
