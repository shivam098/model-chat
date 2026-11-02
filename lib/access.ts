import { randomUUID } from "node:crypto";
import { AppError } from "./errors";
import type { Store } from "./store";

export type AppRole = "user" | "superuser";
export interface AppUser { id: string; name: string; email: string; appRole: AppRole }
export interface AccessContext {
  actor: AppUser;
  subject: AppUser;
  sessionId: string;
  delegationId: string | null;
}
interface ActingRow { id: string; sessionId: string; actorId: string; subjectId: string }
export interface AccountView { user: AppUser; actor: AppUser; acting: boolean }
export interface AuditEvent {
  id: number; at: number; actorId: string | null; subjectId: string | null;
  action: string; objectId: string | null; outcome: "allowed" | "denied" | "error";
  reason: string | null; delegationId: string | null;
}

export class AccessService {
  constructor(public store: Store) {}
  user(id: string): AppUser {
    const user = this.store.db.prepare("SELECT id,name,email,appRole FROM user WHERE id=?").get(id) as AppUser | undefined;
    if (!user) throw new AppError(404, "Account no longer exists.");
    return user;
  }
  record(context: AccessContext | null, action: string, objectId: string | null, outcome: AuditEvent["outcome"], reason: string | null = null, force = false) {
    if (!force && outcome === "allowed" && context?.actor.appRole !== "superuser" && !context?.delegationId) {
      const current = context ? this.store.db.prepare("SELECT appRole FROM user WHERE id=?").get(context.actor.id) as { appRole: string } | undefined : undefined;
      if (current?.appRole !== "superuser") return;
    }
    this.store.db.prepare("INSERT INTO app_audit(at,actorId,subjectId,action,objectId,outcome,reason,delegationId) VALUES (?,?,?,?,?,?,?,?)")
      .run(Date.now(), context?.actor.id ?? null, context?.subject.id ?? null, action, objectId, outcome, reason, context?.delegationId ?? null);
  }
  private sessionValid(actorId: string, sessionId: string) {
    const row = this.store.db.prepare("SELECT expiresAt FROM session WHERE id=? AND userId=?").get(sessionId, actorId) as { expiresAt: string | number } | undefined;
    return Boolean(row && new Date(row.expiresAt).getTime() > Date.now());
  }
  private acting(sessionId: string) {
    return this.store.db.prepare("SELECT id,sessionId,actorId,subjectId FROM app_acting WHERE sessionId=?").get(sessionId) as ActingRow | undefined;
  }
  resolve(actorId: string, sessionId: string, recover = false): AccessContext {
    const actor = this.user(actorId);
    if (!this.sessionValid(actor.id, sessionId)) throw new AppError(401, "Please sign in again.");
    const state = this.acting(sessionId);
    const own: AccessContext = { actor, subject: actor, sessionId, delegationId: null };
    if (!state) return own;
    const subject = this.store.db.prepare("SELECT id,name,email,appRole FROM user WHERE id=?").get(state.subjectId) as AppUser | undefined;
    if (state.actorId !== actor.id || actor.appRole !== "superuser" || !subject || subject.appRole !== "user" || subject.id === actor.id) {
      this.store.db.transaction(() => {
        this.store.db.prepare("DELETE FROM app_acting WHERE sessionId=?").run(sessionId);
        this.record({ ...own, subject: subject ?? { id: state.subjectId, name: "", email: "", appRole: "user" }, delegationId: state.id },
          "acting.invalidated", state.subjectId, "denied", "permission_changed", true);
      })();
      if (recover) return own;
      throw new AppError(409, "Acting-as access ended. Reload to return to your own workspace.", undefined, "workspace-changed");
    }
    return { actor, subject, sessionId, delegationId: state.id };
  }
  check(context: AccessContext) {
    if (!this.sessionValid(context.actor.id, context.sessionId)) throw new AppError(401, "Your login session ended.");
    const actor = this.user(context.actor.id);
    const current = this.acting(context.sessionId);
    if (context.delegationId) {
      const subject = this.user(context.subject.id);
      if (actor.appRole !== "superuser" || subject.appRole !== "user" ||
          current?.id !== context.delegationId || current.actorId !== actor.id || current.subjectId !== subject.id) {
        throw new AppError(409, "Acting-as access changed. Reload your workspace.", undefined, "workspace-changed");
      }
    } else if (current || context.subject.id !== actor.id) {
      throw new AppError(409, "This browser's active workspace changed. Reload before continuing.", undefined, "workspace-changed");
    }
    return actor;
  }
  assertExpectedSubject(context: AccessContext, expected: string | null) {
    if (expected && expected !== context.subject.id) {
      this.record(context, "workspace.assert", null, "denied", "subject_mismatch", true);
      throw new AppError(409, "This browser's active workspace changed. Your request was not applied.", undefined, "workspace-changed");
    }
  }
  requireAdmin(context: AccessContext, allowActing = false) {
    const actor = this.check(context);
    if (actor.appRole !== "superuser") {
      this.record(context, "admin.access", null, "denied", "not_superuser", true);
      throw new AppError(403, "Superuser access is required.");
    }
    if (context.delegationId && !allowActing) {
      this.record(context, "admin.access", null, "denied", "nested_acting", true);
      throw new AppError(409, "Return to your own workspace before selecting another user or opening administration.");
    }
  }
  account(context: AccessContext): AccountView {
    this.check(context);
    return { user: this.user(context.subject.id), actor: this.user(context.actor.id), acting: Boolean(context.delegationId) };
  }
  run<T>(context: AccessContext, action: string, objectId: string | null, operation: () => T, createdId?: (result: T) => string | null): T {
    try {
      return this.store.db.transaction(() => {
        this.check(context);
        const result = operation();
        this.record(context, action, createdId ? createdId(result) : objectId, "allowed");
        return result;
      })();
    } catch (error) {
      this.record(context, action, objectId, error instanceof AppError && error.status < 500 ? "denied" : "error",
        error instanceof AppError ? `http_${error.status}` : "operation_failed");
      throw error;
    }
  }
  start(context: AccessContext, targetId: string) {
    this.requireAdmin(context);
    const subject = this.user(targetId);
    if (subject.appRole !== "user" || subject.id === context.actor.id) {
      this.record(context, "acting.start", subject.id, "denied", "invalid_subject", true);
      throw new AppError(403, "You cannot act as yourself or another superuser.");
    }
    const delegationId = randomUUID();
    this.store.db.prepare("INSERT INTO app_acting(id,sessionId,actorId,subjectId,createdAt) VALUES (?,?,?,?,?)")
      .run(delegationId, context.sessionId, context.actor.id, subject.id, Date.now());
    const next = { ...context, subject, delegationId };
    this.record(next, "acting.start", subject.id, "allowed", null, true);
    return next;
  }
  stop(context: AccessContext, reason = "user_return") {
    this.requireAdmin(context, true);
    if (context.delegationId) {
      this.record(context, "acting.stop", context.subject.id, "allowed", reason, true);
      this.store.db.prepare("DELETE FROM app_acting WHERE sessionId=? AND actorId=?").run(context.sessionId, context.actor.id);
    }
    return { ...context, subject: this.user(context.actor.id), delegationId: null };
  }
  logout(actorId: string, sessionId: string) {
    const state = this.acting(sessionId);
    if (state?.actorId === actorId) {
      const actor = this.user(actorId);
      this.record({ actor, subject: { id: state.subjectId, name: "", email: "", appRole: "user" }, sessionId, delegationId: state.id },
        "acting.stop", state.subjectId, "allowed", "logout", true);
      this.store.db.prepare("DELETE FROM app_acting WHERE sessionId=?").run(sessionId);
    }
  }
  users(context: AccessContext, search: string, offset: number) {
    this.requireAdmin(context);
    const pattern = `%${search.replace(/[!%_]/g, "!$&")}%`;
    const users = this.run(context, "admin.users.list", null, () => this.store.db.prepare(`
      SELECT u.id,u.name,u.email,u.appRole,(SELECT count(*) FROM app_chat c WHERE c.userId=u.id) AS chatCount
      FROM user u WHERE u.email LIKE ? ESCAPE '!' OR u.name LIKE ? ESCAPE '!'
      ORDER BY u.email,u.id LIMIT 26 OFFSET ?
    `).all(pattern, pattern, offset) as (AppUser & { chatCount: number })[]);
    return { users: users.slice(0, 25), hasMore: users.length > 25 };
  }
  userChats(context: AccessContext, targetId: string, search: string, offset: number) {
    this.requireAdmin(context);
    const target = this.user(targetId);
    if (target.appRole === "superuser" && target.id !== context.actor.id) {
      this.record(context, "admin.chats.list", target.id, "denied", "other_superuser", true);
      throw new AppError(403, "Other superusers' workspaces cannot be delegated.");
    }
    const pattern = `%${search.replace(/[!%_]/g, "!$&")}%`;
    const chats = this.store.db.prepare("SELECT id,title,model,createdAt,updatedAt FROM app_chat WHERE userId=? AND title LIKE ? ESCAPE '!' ORDER BY updatedAt DESC,id LIMIT 26 OFFSET ?")
      .all(target.id, pattern, offset);
    this.record({ ...context, subject: target }, "admin.chats.list", target.id, "allowed", null, true);
    return { chats: chats.slice(0, 25), hasMore: chats.length > 25 };
  }
  audit(context: AccessContext, before: number) {
    this.requireAdmin(context);
    this.record(context, "admin.audit.list", null, "allowed");
    const events = this.store.db.prepare("SELECT * FROM app_audit WHERE id<? ORDER BY id DESC LIMIT 51").all(before) as AuditEvent[];
    return { events: events.slice(0, 50), hasMore: events.length > 50 };
  }
  setRoleLocally(email: string, role: AppRole) {
    const matches = this.store.db.prepare("SELECT id FROM user WHERE lower(trim(email))=?").all(email.trim().toLowerCase()) as { id: string }[];
    if (matches.length !== 1) throw new AppError(404, "Exactly one existing account must match. No account was created or reserved.");
    const user = this.user(matches[0].id);
    return this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE user SET appRole=? WHERE id=?").run(role, user.id);
      const states = this.store.db.prepare("SELECT id,sessionId,actorId,subjectId FROM app_acting WHERE actorId=? OR subjectId=?").all(user.id, user.id) as ActingRow[];
      for (const state of states) {
        this.record({ actor: this.user(state.actorId), subject: this.user(state.subjectId), sessionId: state.sessionId, delegationId: state.id },
          "acting.invalidated", state.subjectId, "denied", "role_changed", true);
      }
      this.store.db.prepare("DELETE FROM app_acting WHERE actorId=? OR subjectId=?").run(user.id, user.id);
      this.store.db.prepare("INSERT INTO app_audit(at,actorId,subjectId,action,objectId,outcome,reason,delegationId) VALUES (?,NULL,?,'role.change',?,'allowed',?,NULL)")
        .run(Date.now(), user.id, user.id, `local_console:${role}`);
      return { id: user.id, email: user.email, appRole: role };
    })();
  }
}
