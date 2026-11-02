import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import env from "@next/env";
import { runtimeEnvironment } from "../lib/runtime-env.mjs";

env.loadEnvConfig(process.cwd());
const home = path.join(path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local"), "copilot");
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
