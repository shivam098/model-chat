import env from "@next/env";

env.loadEnvConfig(process.cwd());
const { listModels, runCopilotReply } = await import("../lib/copilot");

try {
  const models = await listModels(true);
  console.log(`Copilot authenticated. ${models.length} models available.`);
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
  console.error(error instanceof Error ? error.message : "Copilot connection failed.");
  if (error instanceof Error && error.cause instanceof Error) {
    console.error("Runtime diagnostic:", error.cause.message.replace(/(?:gh[o_up]|github_pat|ghs)_[A-Za-z0-9_]+/g, "[redacted]").slice(0, 500));
  }
  process.exitCode = 1;
}
