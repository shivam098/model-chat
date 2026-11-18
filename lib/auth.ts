import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { twoFactor } from "better-auth/plugins";
import { authSecret, localOrigin, origin, requestVia, tunnelMode } from "./config";
import { getStore } from "./store";

// Sessions created by a successful authenticator or backup code are recorded, so remote coding can require them.
const secondFactorSessions = {
  id: "model-chat-second-factor",
  hooks: { after: [{
    matcher: context => context.path === "/two-factor/verify-totp" || context.path === "/two-factor/verify-backup-code",
    handler: createAuthMiddleware(async ctx => {
      const created = ctx.context.newSession;
      if (created) getStore().markSecondFactor(created.session.id, created.user.id);
    }),
  }, {
    matcher: context => context.path === "/two-factor/disable",
    handler: createAuthMiddleware(async ctx => {
      const userId = ctx.context.session?.user.id;
      if (userId) getStore().clearSecondFactor(userId);
    }),
  }] },
} satisfies BetterAuthPlugin;

// "public" serves the configured origin (the HTTPS tunnel in tunnel mode); "local" serves this computer's own
// browser at the loopback origin. Both share one user/session database but use cookies for their own host only.
export type AuthKind = "public" | "local";
function authOptions(kind: AuthKind) {
  const base = kind === "local" ? localOrigin : origin;
  return {
    appName: "Model Chat",
    baseURL: base,
    secret: authSecret(),
    database: getStore().db,
    trustedOrigins: [base],
    user: { additionalFields: { appRole: { type: ["user", "superuser"], required: true, defaultValue: "user", input: false } } },
    emailAndPassword: { enabled: true, disableSignUp: false, requireEmailVerification: false, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: {
      cookiePrefix: "model-chat",
      useSecureCookies: kind === "public" && tunnelMode,
      defaultCookieAttributes: { httpOnly: true, sameSite: "strict", path: "/" },
      ipAddress: { ipAddressHeaders: ["x-model-chat-ip"] },
    },
    rateLimit: { enabled: true, window: 60, max: 60, customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
    } },
    // Two-step verification (authenticator app codes plus one-time backup codes). Only the superuser can turn it on.
    plugins: [twoFactor({ issuer: "Model Chat" }), secondFactorSessions],
  } satisfies BetterAuthOptions;
}
type Auth = ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>;
const state = globalThis as typeof globalThis & { modelChatAuths?: Partial<Record<AuthKind, Promise<Auth>>> };
export function getAuth(kind: AuthKind = "public"): Promise<Auth> {
  const key: AuthKind = tunnelMode ? kind : "public";
  const auths = state.modelChatAuths ||= {};
  if (!auths[key]) auths[key] = (async () => {
    const options = authOptions(key);
    await (await getMigrations(options)).runMigrations();
    return betterAuth(options);
  })().catch(error => { delete auths[key]; throw error; });
  return auths[key]!;
}
export function authFor(request: Request): Promise<Auth> {
  return getAuth(requestVia(request) === "local" ? "local" : "public");
}
