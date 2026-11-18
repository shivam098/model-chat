import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { dataDirectory, localOrigin, requestVia, type Via } from "../config";
import { AppError } from "../errors";
import type { AccessContext, AccessService } from "../access";
import { projectsRoot } from "./paths";

export interface CodingStatus {
  available: boolean;
  reason: string | null;
  via: Via;
  remoteEnabled: boolean;
  platform: NodeJS.Platform;
  projectsRoot: string | null;
  localUrl: string;
}
// Remote coding is off unless the owner turns it on with `npm run code:remote -- on` on the host (phase 2: also needs two-step verification).
export function remoteCodingEnabled() {
  const file = path.join(dataDirectory, "coding-remote.json");
  if (!existsSync(file)) return false;
  try { return (JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown }).enabled === true; } catch { return false; }
}
function evaluate(request: Request, context: AccessContext, service: AccessService): { status: CodingStatus; code: string | null } {
  const actor = service.check(context);
  const via = requestVia(request);
  const remoteEnabled = remoteCodingEnabled();
  let reason: string | null = null, code: string | null = null;
  if (actor.appRole !== "superuser") { reason = "Coding mode is available only to the superuser account."; code = "not_superuser"; }
  else if (context.delegationId) { reason = "Return to your own workspace to use coding mode; it never runs as another user."; code = "acting"; }
  else if (via !== "local" && !remoteEnabled) { reason = `Coding mode works only in a browser on the computer running Model Chat (${localOrigin}).`; code = "remote_disabled"; }
  else if (via !== "local") { reason = "Remote coding needs two-step verification, which isn't set up yet."; code = "second_factor_required"; }
  const available = reason === null;
  return { code, status: { available, reason, via, remoteEnabled, platform: os.platform(), projectsRoot: available ? projectsRoot() : null, localUrl: localOrigin } };
}
export function codingStatus(request: Request, context: AccessContext, service: AccessService) {
  return evaluate(request, context, service).status;
}
export function requireCoding(request: Request, context: AccessContext, service: AccessService, action: string) {
  const { status, code } = evaluate(request, context, service);
  if (!status.available) {
    service.record(context, action, null, "denied", code, true);
    throw new AppError(403, status.reason!, undefined, "coding-unavailable");
  }
  return status;
}
