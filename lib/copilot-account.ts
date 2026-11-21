import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "./errors";
import { runtimeEnvironment } from "./runtime-env.mjs";

export const GITHUB_HOST = "https://github.com";
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98})$/;

// Shown to every app user, so it never names an account; the cause carries the owner-facing detail.
export const ACCOUNT_UNAVAILABLE = "This app's Copilot sign-in is missing or does not match its configured account. The host owner can run npm run check:copilot on this machine for details.";

export const TOKEN_HINT = "Create a new fine-grained personal access token with the Copilot Requests permission, put it in MODEL_CHAT_COPILOT_TOKEN in .env.local, then restart Model Chat.";

export interface StoredAccount { authInfo?: { type: string; host?: string; login?: string }; token?: string }
export interface RuntimeAuth { authInfo?: { type: string; copilotUser?: { login?: string } }; authErrors?: string[] }
/** Where this copy's Copilot credential comes from: the optional token wins over the stored `npm run copilot:login` sign-in. */
export type CredentialPlan =
  | { kind: "token"; token: string; login?: string; source: string }
  | { kind: "stored"; login: string; source: string };

export function accountError(detail: string) {
  return new AppError(503, ACCOUNT_UNAVAILABLE, { cause: new Error(detail) }, "copilot_account");
}
export function isAccountError(error: unknown) {
  return error instanceof AppError && error.code === "copilot_account";
}
function sameLogin(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

function configuredLogin(env: Record<string, string | undefined>): string | undefined {
  const configured = env.MODEL_CHAT_COPILOT_LOGIN?.trim();
  if (configured && !LOGIN_PATTERN.test(configured)) throw accountError("MODEL_CHAT_COPILOT_LOGIN is not a valid GitHub login.");
  return configured || undefined;
}

/** Token (MODEL_CHAT_COPILOT_TOKEN) when one is set, else exactly today's stored sign-in rules. */
export function credentialPlan(copilotHome: string, token: string | undefined, env: Record<string, string | undefined> = process.env): CredentialPlan {
  if (!token) return { kind: "stored", ...expectedCopilotLogin(copilotHome, env) };
  if (token.startsWith("ghp_")) throw accountError(`MODEL_CHAT_COPILOT_TOKEN is a classic personal access token, which Copilot doesn't accept. ${TOKEN_HINT}`);
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw accountError(`MODEL_CHAT_COPILOT_TOKEN isn't a complete token (check for spaces, quotes or a partial copy). ${TOKEN_HINT}`);
  return { kind: "token", token, login: configuredLogin(env), source: "MODEL_CHAT_COPILOT_TOKEN in .env.local" };
}

/** The account the app must use: MODEL_CHAT_COPILOT_LOGIN, else the account last signed in with npm run copilot:login. Never the GitHub CLI's account. */
export function expectedCopilotLogin(copilotHome: string, env: Record<string, string | undefined> = process.env): { login: string; source: string } {
  const configured = configuredLogin(env);
  if (configured) return { login: configured, source: "MODEL_CHAT_COPILOT_LOGIN" };
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
export function verifyRuntimeIdentity(current: RuntimeAuth, expected: string, viaToken = false): string {
  const info = current.authInfo;
  const login = info?.copilotUser?.login;
  if (info?.type !== "token" || !login) {
    throw accountError(viaToken
      ? `Copilot did not accept MODEL_CHAT_COPILOT_TOKEN for ${expected}. Run npm run check:copilot for details. ${TOKEN_HINT}`
      : `Copilot did not accept this app's stored sign-in for ${expected} (runtime reported ${info?.type ?? "no authentication"}). Run npm run copilot:login and sign in as ${expected}.`);
  }
  if (!sameLogin(login, expected)) throw accountError(`The app's Copilot credential belongs to ${login}, not the configured account ${expected}. Generation was blocked.`);
  return login;
}

/** The login Copilot resolved the token to, or null if Copilot didn't accept it. A different account than MODEL_CHAT_COPILOT_LOGIN fails closed. */
export function tokenLogin(current: RuntimeAuth, expected?: string): string | null {
  const info = current.authInfo;
  const login = info?.copilotUser?.login;
  if (info?.type !== "token" || !login) return null;
  if (expected && !sameLogin(login, expected)) {
    throw accountError(`MODEL_CHAT_COPILOT_TOKEN belongs to ${login}, not the configured account ${expected} (MODEL_CHAT_COPILOT_LOGIN). Generation was blocked.`);
  }
  return login;
}

export interface TokenCheck { status: "rejected" | "accepted" | "unknown"; login?: string; expiresAt?: Date }

/** GitHub reports a token's expiry as "YYYY-MM-DD HH:MM:SS UTC" in GitHub-Authentication-Token-Expiration; anything else is ignored. */
export function parseTokenExpiry(header: string | null | undefined): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/.exec(header?.trim() ?? "");
  if (!match) return undefined;
  const date = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Asks GitHub itself (GET /user) whether it accepts the token, for whom, and until when. The token goes nowhere else. */
export async function checkTokenWithGitHub(token: string, fetcher: typeof fetch = fetch): Promise<TokenCheck> {
  try {
    const response = await fetcher("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "model-chat" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) return { status: "rejected" };
    if (!response.ok) return { status: "unknown" };
    const body = await response.json().catch(() => ({})) as { login?: unknown };
    const login = typeof body.login === "string" && LOGIN_PATTERN.test(body.login) ? body.login : undefined;
    return { status: "accepted", login, expiresAt: parseTokenExpiry(response.headers.get("github-authentication-token-expiration")) };
  } catch {
    return { status: "unknown" };
  }
}

/** Plain, owner-facing reason when Copilot didn't accept the token. Users still see only ACCOUNT_UNAVAILABLE. */
export function tokenProblem(check: TokenCheck, runtimeErrors: readonly string[] = []): AppError {
  const runtimeRejected = runtimeErrors.some(error => /\(401\)|bad credentials/i.test(error));
  if (check.status === "rejected" || (check.status === "unknown" && runtimeRejected)) {
    return accountError(`GitHub rejected MODEL_CHAT_COPILOT_TOKEN: it has expired, been revoked or wasn't copied completely. ${TOKEN_HINT}`);
  }
  if (check.status === "accepted") {
    return accountError(`GitHub accepts MODEL_CHAT_COPILOT_TOKEN${check.login ? ` for ${check.login}` : ""}, but Copilot refused it: it's probably missing the Copilot Requests permission, or that account has no Copilot access. ${TOKEN_HINT}`);
  }
  return accountError(`Copilot did not accept MODEL_CHAT_COPILOT_TOKEN, and GitHub couldn't be asked why. It may have expired, been revoked or be missing the Copilot Requests permission. ${TOKEN_HINT}`);
}

/** For npm run check:copilot: the token's expiry, with a warning inside the last 3 days. */
export function expiryNotice(expiresAt: Date | undefined, now = new Date()): { text: string; warn: boolean } {
  if (!expiresAt) return { text: "GitHub reports no expiry date for MODEL_CHAT_COPILOT_TOKEN.", warn: false };
  const days = (expiresAt.getTime() - now.getTime()) / 86_400_000;
  const when = expiresAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  if (days <= 0) return { text: `MODEL_CHAT_COPILOT_TOKEN expired on ${when}. ${TOKEN_HINT}`, warn: true };
  if (days <= 3) return { text: `MODEL_CHAT_COPILOT_TOKEN expires on ${when}, in ${days < 1 ? "less than a day" : `${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"}`}. ${TOKEN_HINT}`, warn: true };
  return { text: `MODEL_CHAT_COPILOT_TOKEN expires on ${when} (in ${Math.floor(days)} days).`, warn: false };
}

/** Runtime environment with an empty, app-owned GitHub CLI config, so gh's active account is invisible to the runtime. */
export function isolatedRuntimeEnvironment(copilotHome: string): Record<string, string | undefined> {
  const ghConfig = path.join(copilotHome, "gh-config-isolated");
  mkdirSync(ghConfig, { recursive: true, mode: 0o700 });
  return { ...runtimeEnvironment(), GH_CONFIG_DIR: ghConfig };
}
