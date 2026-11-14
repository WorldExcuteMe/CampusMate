// Own child processes explicitly: no orphan proxy / unbounded EADDRINUSE restart loops.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] === "preview" ? "preview" : "dev";
let proxy = null, vite = null, restartTimer = null;
let stopping = false;
let restartCount = 0;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const p of [proxy, vite]) if (p && p.exitCode === null) p.kill();
  // The bound prevents a stuck child from keeping an interactive shutdown alive forever.
  const timer = setTimeout(() => process.exit(code), 2000);
  timer.unref();
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(0));
function startProxy() {
  const started = Date.now();
  proxy = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "dev/llm-proxy.mjs")], { cwd: root, stdio: "inherit", windowsHide: true });
  proxy.on("error", (e) => { console.error("[serve] proxy:", e.message); stop(1); });
  proxy.on("exit", (code) => {
    if (stopping) return;
    if (Date.now() - started > 60000) restartCount = 0;
    if (++restartCount > 3) { console.error("[serve] proxy repeatedly failed; stopping (check port 8787/logs)"); stop(1); return; }
    restartTimer = setTimeout(startProxy, Math.min(1000 * 2 ** (restartCount - 1), 4000));
  });
}
async function existingProxy() {
  const port = Number(process.env.CAMPUSMATE_PROXY_PORT ?? 8787);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok || (await r.json()).service !== "campusmate-local-proxy") throw new Error("port occupied by an unknown service");
    return true;
  } catch (e) {
    if (e.cause?.code === "ECONNREFUSED") return false;
    throw e;
  }
}
try {
  if (!await existingProxy()) startProxy();
  else console.log("[serve] reusing existing CampusMate proxy (not owned; will not stop it)");
  vite = spawn(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), mode, "--host", "127.0.0.1", ...process.argv.slice(3)], { cwd: root, stdio: "inherit", windowsHide: true });
  vite.on("error", (e) => { console.error("[serve] vite:", e.message); stop(1); });
  vite.on("exit", (code) => stop(code ?? 0));
} catch (e) { console.error("[serve]", e.message); stop(1); }
