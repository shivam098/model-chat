import env from "@next/env";

env.loadEnvConfig(process.cwd());
const { listModels, runCopilotReply, copilotAccount, usesCopilotToken } = await import("../lib/copilot");
const { checkTokenWithGitHub, expiryNotice } = await import("../lib/copilot-account");
const { redactSecrets, takeCopilotToken } = await import("../lib/secret-env.mjs");

try {
  const models = await listModels(true);
  const account = await copilotAccount();
  if (usesCopilotToken()) {
    console.log(`Copilot authenticated as ${account.login} with MODEL_CHAT_COPILOT_TOKEN from .env.local (the stored npm run copilot:login sign-in and the GitHub CLI are not used). ${models.length} models available.`);
    if (!process.env.MODEL_CHAT_COPILOT_LOGIN?.trim()) console.log(`The token belongs to ${account.login}. To pin that account, add MODEL_CHAT_COPILOT_LOGIN=${account.login} to .env.local.`);
    const check = await checkTokenWithGitHub(takeCopilotToken() as string);
    if (check.status === "accepted") {
      const notice = expiryNotice(check.expiresAt);
      if (notice.warn) console.warn(`Warning: ${notice.text}`);
      else console.log(notice.text);
    } else console.log("GitHub didn't report the token's expiry date this time.");
  } else {
    console.log(`Copilot authenticated as ${account.login} (configured by ${account.source}; the GitHub CLI's active account is not used). ${models.length} models available.`);
  }
  console.log(models.map(m => `${m.id} (${m.name})`).join("\n"));
  if (process.argv.includes("--chat")) {
    const model = [...models].filter(m => m.id !== "auto").sort((a, b) => (a.billing?.multiplier ?? 1) - (b.billing?.multiplier ?? 1))[0];
    let text = "";
    await runCopilotReply({
      model: model.id,
      prompt: JSON.stringify({ conversation: [{ role: "user", content: "Reply with exactly: Model Chat connected." }], files: [] }),
      signal: AbortSignal.timeout(90_000),
      onDelta: chunk => { text += chunk; },
      onReplace: full => { text = full; },
    });
    if (!text.trim()) throw new Error("The live chat returned no text.");
    console.log("Tool-free real reply:", text);
  }
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : "Copilot connection failed."));
  if (error instanceof Error && error.cause instanceof Error) console.error("Details:", redactSecrets(error.cause.message).slice(0, 700));
  process.exitCode = 1;
}
