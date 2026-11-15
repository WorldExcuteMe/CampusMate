import { defineConfig } from "@playwright/test";
import path from "node:path";
import os from "node:os";

export default defineConfig({
  testDir: "./e2e", testMatch: "**/*.integration.ts", workers: 1, timeout: 90_000,
  outputDir: process.env.CAMPUSMATE_E2E_OUTPUT ?? path.join(os.tmpdir(), "campusmate-runtime-e2e"),
  use: { baseURL: "http://127.0.0.1:5188", headless: true, actionTimeout: 10_000, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    command: `"${process.execPath}" ../backend/tests/e2e/server.ts`,
    url: "http://127.0.0.1:5188", reuseExistingServer: false, timeout: 60_000,
  },
});
