import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxy = {
  "/functions/v1/app": "http://127.0.0.1:8000",
  // 所有 /api/* 均由本地 llm-proxy(8787) 提供；整段代理，避免新增端点漏配导致 404 空体。
  "/api": "http://127.0.0.1:8787",
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
  build: { outDir: "dist" },
});
