import { defineConfig } from "@playwright/test";
import path from "node:path";
import os from "node:os";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  outputDir: process.env.CAMPUSMATE_E2E_OUTPUT ?? path.join(os.tmpdir(), "campusmate-demo-e2e"),
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `"${process.execPath}" e2e/demo-server.mjs`,
    url: "http://127.0.0.1:5173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
