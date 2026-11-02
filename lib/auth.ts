import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { authSecret, origin, tunnelMode } from "./config";
import { getStore } from "./store";

function authOptions() {
  return {
    appName: "Model Chat",
    baseURL: origin,
    secret: authSecret(),
    database: getStore().db,
    trustedOrigins: [origin],
    user: { additionalFields: { appRole: { type: ["user", "superuser"], required: true, defaultValue: "user", input: false } } },
    emailAndPassword: { enabled: true, disableSignUp: false, requireEmailVerification: false, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: {
      cookiePrefix: "model-chat",
      useSecureCookies: tunnelMode,
      defaultCookieAttributes: { httpOnly: true, sameSite: "strict", path: "/" },
      ipAddress: { ipAddressHeaders: ["x-model-chat-ip"] },
    },
    rateLimit: { enabled: true, window: 60, max: 60, customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
    } },
  } satisfies BetterAuthOptions;
}
type Auth = ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>;
const state = globalThis as typeof globalThis & { modelChatAuth?: Promise<Auth> };
export function getAuth(): Promise<Auth> {
  if (!state.modelChatAuth) state.modelChatAuth = (async () => {
    const options = authOptions();
    await (await getMigrations(options)).runMigrations();
    return betterAuth(options);
  })().catch(error => { state.modelChatAuth = undefined; throw error; });
  return state.modelChatAuth;
}
