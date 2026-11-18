import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "./errors";
import { runtimeEnvironment } from "./runtime-env.mjs";

export const GITHUB_HOST = "https://github.com";
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98})$/;

// Shown to every app user, so it never names an account; the cause carries the owner-facing detail.
export const ACCOUNT_UNAVAILABLE = "This app's Copilot sign-in is missing or does not match its configured account. The host owner can run npm run check:copilot on this machine for details.";

export interface StoredAccount { authInfo?: { type: string; host?: string; login?: string }; token?: string }
export interface RuntimeAuth { authInfo?: { type: string; copilotUser?: { login?: string } } }

export function accountError(detail: string) {
  return new AppError(503, ACCOUNT_UNAVAILABLE, { cause: new Error(detail) }, "copilot_account");
}
export function isAccountError(error: unknown) {
  return error instanceof AppError && error.code === "copilot_account";
}
function sameLogin(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/** The account the app must use: MODEL_CHAT_COPILOT_LOGIN, else the account last signed in with npm run copilot:login. Never the GitHub CLI's account. */
export function expectedCopilotLogin(copilotHome: string, env: Record<string, string | undefined> = process.env): { login: string; source: string } {
  const configured = env.MODEL_CHAT_COPILOT_LOGIN?.trim();
  if (configured) {
    if (!LOGIN_PATTERN.test(configured)) throw accountError("MODEL_CHAT_COPILOT_LOGIN is not a valid GitHub login.");
    return { login: configured, source: "MODEL_CHAT_COPILOT_LOGIN" };
  }
  let stored: unknown;
  try {
    const text = readFileSync(path.join(copilotHome, "config.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    stored = (JSON.parse(text) as { lastLoggedInUser?: unknown }).lastLoggedInUser;
  } catch { stored = undefined; }
  const user = stored as { host?: unknown; login?: unknown } | undefined;
  if (user?.host === GITHUB_HOST && typeof user.login === "string" && LOGIN_PATTERN.test(user.login)) {
    return { login: user.login, source: "this app's npm run copilot:login" };
  }
  throw accountError("No Copilot account is set up for this app. Run npm run copilot:login on this machine, or set MODEL_CHAT_COPILOT_LOGIN in .env.local, then refresh the connection.");
}

/** Picks the app's own stored sign-in for the expected login. GitHub CLI and environment credentials are never eligible. */
export function selectStoredSignIn(accounts: readonly StoredAccount[], expected: string): { login: string; token: string } {
  const signedIn = accounts.filter(account => account.authInfo?.type === "user" && account.authInfo.host === GITHUB_HOST && typeof account.authInfo.login === "string");
  const match = signedIn.find(account => sameLogin(account.authInfo!.login!, expected) && typeof account.token === "string" && account.token.length > 0);
  if (match) return { login: match.authInfo!.login!, token: match.token! };
  const others = [...new Set(signedIn.map(account => account.authInfo!.login!).filter(login => !sameLogin(login, expected)))];
  throw accountError(others.length
    ? `This app's stored Copilot sign-in is for ${others.join(", ")}, not the configured account ${expected}. Run npm run copilot:login and sign in as ${expected}, or change MODEL_CHAT_COPILOT_LOGIN.`
    : `This app has no stored Copilot sign-in for ${expected}. Run npm run copilot:login on this machine and sign in as ${expected}, then refresh the connection.`);
}

/** Confirms that the runtime resolved the app's credential to the expected account before anything is sent. */
export function verifyRuntimeIdentity(current: RuntimeAuth, expected: string): string {
  const info = current.authInfo;
  const login = info?.copilotUser?.login;
  if (info?.type !== "token" || !login) {
    throw accountError(`Copilot did not accept this app's stored sign-in for ${expected} (runtime reported ${info?.type ?? "no authentication"}). Run npm run copilot:login and sign in as ${expected}.`);
  }
  if (!sameLogin(login, expected)) throw accountError(`The app's Copilot credential belongs to ${login}, not the configured account ${expected}. Generation was blocked.`);
  return login;
}

/** Runtime environment with an empty, app-owned GitHub CLI config, so gh's active account is invisible to the runtime. */
export function isolatedRuntimeEnvironment(copilotHome: string): Record<string, string | undefined> {
  const ghConfig = path.join(copilotHome, "gh-config-isolated");
  mkdirSync(ghConfig, { recursive: true, mode: 0o700 });
  return { ...runtimeEnvironment(), GH_CONFIG_DIR: ghConfig };
}
