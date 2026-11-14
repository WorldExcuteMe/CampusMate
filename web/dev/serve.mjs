// 监督启动器：dev/preview 自动拉起 llm-proxy(8787) 并崩溃自愈，再启动 vite。
// 根因修复：LLM 依赖独立本地代理进程，原先 dev/preview 不拉起、被回收即整轮降级 Mock。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] === "preview" ? "preview" : "dev";

function startProxy() {
  const p = spawn(process.execPath, [path.join(root, "dev", "llm-proxy.mjs")], { cwd: root, stdio: "inherit" });
  p.on("exit", (code) => {
    console.log(`[serve] llm-proxy exit ${code}; auto-restart in 1s`);
    setTimeout(startProxy, 1000);
  });
  return p;
}
startProxy();

const vite = spawn(
  process.execPath,
  [path.join(root, "node_modules", "vite", "bin", "vite.js"), mode, "--host", "127.0.0.1"],
  { cwd: root, stdio: "inherit" },
);
vite.on("exit", (c) => process.exit(c ?? 0));
console.log(`[serve] llm-proxy(8787, auto-restart) + vite ${mode}(5173/4173)`);