import { defineConfig } from "@playwright/test";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.MODEL_CHAT_TEST_DATA_DIR ||= path.resolve(".local", `browser-test-${randomUUID()}`);
// Test data stays isolated, but the test server uses this machine's app Copilot sign-in (never the GitHub CLI's account).
const copilotHome = process.env.MODEL_CHAT_COPILOT_HOME || path.resolve(process.env.MODEL_CHAT_DATA_DIR || ".local", "copilot");

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:3211", channel: "msedge", trace: "retain-on-failure" },
  webServer: {
    command: "npm start -- --port 3211",
    url: "http://127.0.0.1:3211/api/health",
    timeout: 120_000,
    reuseExistingServer: false,
    env: { MODEL_CHAT_DATA_DIR: process.env.MODEL_CHAT_TEST_DATA_DIR, MODEL_CHAT_COPILOT_HOME: copilotHome },
  },
});
