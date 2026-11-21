// Optional Copilot token for this copy of Model Chat (MODEL_CHAT_COPILOT_TOKEN in .env.local). It is read once into
// this process's memory and removed from process.env, so no child process (shells, tools, the tunnel, builds started
// from here) can inherit it. Only the Copilot runtime receives it, as the SDK's gitHubToken or over RPC.
export const COPILOT_TOKEN_VARIABLE = "MODEL_CHAT_COPILOT_TOKEN";
const TOKEN_SHAPES = /\b(?:github_pat|gh[opusr])_[A-Za-z0-9_]{8,}/g;

/** The configured token, or undefined when this copy uses its stored `npm run copilot:login` sign-in. */
export function takeCopilotToken() {
  if (COPILOT_TOKEN_VARIABLE in process.env) {
    globalThis.modelChatCopilotToken = String(process.env[COPILOT_TOKEN_VARIABLE] ?? "").trim();
    delete process.env[COPILOT_TOKEN_VARIABLE];
  }
  return globalThis.modelChatCopilotToken || undefined;
}
/** For scripts that never use the token themselves: drop it before they start other programs. */
export function dropCopilotToken() {
  delete process.env[COPILOT_TOKEN_VARIABLE];
}
export function withoutCopilotToken(env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) if (key.toUpperCase() === COPILOT_TOKEN_VARIABLE) delete copy[key];
  return copy;
}
/** Removes GitHub tokens (and the configured token itself) from text before it is shown or logged. */
export function redactSecrets(text) {
  let result = String(text ?? "");
  const token = globalThis.modelChatCopilotToken;
  if (token) result = result.split(token).join("[redacted]");
  return result.replace(TOKEN_SHAPES, "[redacted]");
}
