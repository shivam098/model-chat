import { defineConfig } from "@playwright/test";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.MODEL_CHAT_TEST_DATA_DIR ||= path.resolve(".local", `browser-test-${randomUUID()}`);

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
    env: { MODEL_CHAT_DATA_DIR: process.env.MODEL_CHAT_TEST_DATA_DIR },
  },
});
