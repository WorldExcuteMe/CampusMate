import { fileURLToPath, URL } from "node:url";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // junction 外的 ?url 导入会同时校验文件路径与查询路径，仅放行 pdfjs 构建目录。
  server: { fs: { allow: [
    fileURLToPath(new URL("..", import.meta.url)),
    dirname(realpathSync(createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"))),
  ] } },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});