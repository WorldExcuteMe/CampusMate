// 一键保活：同时启动 llm-proxy(8787) 与 vite preview(4173)；llm-proxy 退出自动重启。
// 解决"会话间/瞬断导致代理被回收→群摄取失败回退历史"的根因（DSH host/session 保活理念）。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function startProxy() {
  const p = spawn(process.execPath, [path.join(root, "dev", "llm-proxy.mjs")], { cwd: root, stdio: "inherit" });
  p.on("exit", (code) => {
    console.log(`[start-all] llm-proxy exit ${code}, restart in 1s`);
    setTimeout(startProxy, 1000);
  });
  return p;
}

startProxy();
const preview = spawn(
  process.execPath,
  [path.join(root, "node_modules", "vite", "bin", "vite.js"), "preview", "--host", "127.0.0.1"],
  { cwd: root, stdio: "inherit" },
);
preview.on("exit", (c) => console.log(`[start-all] preview exit ${c}`));
console.log("[start-all] llm-proxy(8787) + preview(4173) starting; proxy auto-restart on exit");