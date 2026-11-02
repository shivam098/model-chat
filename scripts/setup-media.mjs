import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import env from "@next/env";
import { runtimeEnvironment } from "../lib/runtime-env.mjs";

env.loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index >= 0 && !args[index + 1]) throw new Error(`Missing value for ${flag}.`);
  return index >= 0 ? args[index + 1] : fallback;
};
const python = value("--python", process.env.MODEL_CHAT_MEDIA_PYTHON || "python");
const model = value("--model", process.env.MODEL_CHAT_WHISPER_MODEL || "large-v3-turbo");
const result = spawnSync(python, [path.resolve("scripts", "media-worker.py"), "--probe", "--model", model], {
  env: { ...runtimeEnvironment(), HF_HUB_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
  encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
});
if (result.error) throw new Error(`Could not start Python: ${result.error.message}`);
let probe;
try { probe = JSON.parse(result.stdout.trim()); } catch { throw new Error("Python did not return a valid media probe. Install requirements-media.txt into an app-local virtual environment and rerun setup:media."); }
if (result.status !== 0 || !probe.ok) throw new Error(probe.error || "Local Whisper packages or a complete cached model were not found.");
const data = path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local");
mkdirSync(data, { recursive: true, mode: 0o700 });
writeFileSync(path.join(data, "media-config.json"), JSON.stringify({
  python: probe.python, modelPath: probe.modelPath, modelName: probe.modelName, versions: probe.versions,
}, null, 2), { mode: 0o600 });
console.log(`Local media processing configured: Whisper ${probe.modelName} on CPU.`);
console.log(`Reusing installed Python: ${probe.python}`);
console.log("No model or package download was performed. Configuration is stored privately in .local/media-config.json.");
