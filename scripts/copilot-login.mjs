import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import env from "@next/env";
import { runtimeEnvironment } from "../lib/runtime-env.mjs";
import { COPILOT_TOKEN_VARIABLE, dropCopilotToken } from "../lib/secret-env.mjs";

env.loadEnvConfig(process.cwd());
if (process.env[COPILOT_TOKEN_VARIABLE]?.trim()) console.log(`Note: ${COPILOT_TOKEN_VARIABLE} is set in .env.local, so the app signs in with that token and ignores this stored sign-in. Remove it to use this sign-in.`);
dropCopilotToken();
const home = process.env.MODEL_CHAT_COPILOT_HOME
  ? path.resolve(process.env.MODEL_CHAT_COPILOT_HOME)
  : path.join(path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local"), "copilot");
mkdirSync(home, { recursive: true, mode: 0o700 });
console.log("Signing in using the supported Copilot CLI. App runtime config stays in:", home);
const child = spawn("copilot", ["login"], {
  stdio: "inherit",
  cwd: home,
  env: { ...runtimeEnvironment(), COPILOT_HOME: home },
  shell: false,
});
child.on("error", error => { console.error("Could not launch Copilot CLI:", error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
