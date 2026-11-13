// 本地开发服务端 LLM 代理 + 供应商管理。
// 密钥只存在于服务端（.env.local / .providers.local.json，均 gitignored），
// 浏览器经同源 /api/* 调用；前端 bundle 与 localStorage 不含任何密钥。
// 生产环境同一接口契约由 Supabase Edge Function / Sites Function 实现。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile, execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROVIDERS_FILE = path.join(root, ".providers.local.json");
const PORT = 8787;

function loadEnv() {
  const env = {};
  try {
    const txt = fs.readFileSync(path.join(root, ".env.local"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}
function loadProviders() {
  try {
    return JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveProviders(list) {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(list, null, 2));
}
function publicView(p) {
  return { id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: p.protocol, model: p.model, hasKey: Boolean(p.apiKey) };
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const env = loadEnv();

// 预热常驻 PowerShell 对话框进程：启动时加载 WinForms，点击时立即弹出，消除每次冷启动延迟。
let dialogChild = null;
let pickResolve = null;
let outBuf = "";
function ensureDialog() {
  if (dialogChild && dialogChild.exitCode === null) return dialogChild;
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "while (($line = [Console]::In.ReadLine()) -ne $null) {",
    "  if ($line -eq 'pick') {",
    "    $f = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "    $f.Description = '选择 CampusMate 工作区文件夹';",
    "    $f.ShowNewFolderButton = $true;",
    "    if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($f.SelectedPath) } else { [Console]::Out.WriteLine('') };",
    "    [Console]::Out.Flush();",
    "  }",
    "}",
  ].join("\n");
  dialogChild = spawn("powershell", ["-STA", "-NoProfile", "-Command", script], { stdio: ["pipe", "pipe", "pipe"] });
  dialogChild.stdout.on("data", (d) => {
    outBuf += d.toString("utf8");
    let i;
    while ((i = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, i).replace(/\r$/, "");
      outBuf = outBuf.slice(i + 1);
      if (pickResolve) { const r = pickResolve; pickResolve = null; r(line); }
    }
  });
  dialogChild.on("exit", () => {
    dialogChild = null;
    if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); }
  });
  return dialogChild;
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "";
  // 供应商列表（不含密钥）
  if (req.method === "GET" && url === "/api/providers") {
    const list = loadProviders().map(publicView);
    if (env.LLM_API_KEY) {
      list.unshift({ id: "builtin-deepseek", name: "DeepSeek（内置）", baseUrl: env.LLM_BASE_URL, protocol: "openai", model: env.LLM_MODEL, hasKey: true });
    }
    return json(res, 200, { providers: list });
  }
  // 新增/更新供应商（密钥仅在此一次提交，存服务端）
  if (req.method === "POST" && url === "/api/providers") {
    const p = JSON.parse(await readBody(req));
    if (!p.id || !p.baseUrl) return json(res, 400, { error: "id/baseUrl required" });
    const list = loadProviders().filter((x) => x.id !== p.id);
    list.push({ id: p.id, name: p.name || p.id, baseUrl: p.baseUrl, protocol: p.protocol || "openai", model: p.model || "", apiKey: p.apiKey || "" });
    saveProviders(list);
    return json(res, 200, { ok: true, provider: publicView(p) });
  }
  // 删除供应商
  if (req.method === "DELETE" && url.startsWith("/api/providers/")) {
    const id = decodeURIComponent(url.split("/").pop());
    saveProviders(loadProviders().filter((x) => x.id !== id));
    return json(res, 200, { ok: true });
  }
  // LLM 调用（密钥服务端解析）
  if (req.method === "POST" && url === "/api/llm") {
    const payload = JSON.parse(await readBody(req));
    let key = env.LLM_API_KEY;
    let baseUrl = env.LLM_BASE_URL || "https://api.deepseek.com";
    let model = env.LLM_MODEL || "deepseek-chat";
    if (payload.providerId && payload.providerId !== "builtin-deepseek") {
      const p = loadProviders().find((x) => x.id === payload.providerId);
      if (!p || !p.apiKey) return json(res, 503, { error: "provider key not configured (server-side)" });
      key = p.apiKey; baseUrl = p.baseUrl; model = p.model || model;
    }
    if (!key) return json(res, 503, { error: "LLM_API_KEY not configured (server-side)" });
    try {
      const upstream = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: payload.model || model,
          messages: payload.messages,
          temperature: payload.temperature ?? 0.2,
          ...(payload.tools ? { tools: payload.tools, tool_choice: payload.tool_choice ?? "auto" } : {}),
          ...(payload.responseFormat ? { response_format: payload.responseFormat } : {}),
        }),
      });
      const data = await upstream.json();
      return json(res, upstream.status, data);
    } catch (err) {
      return json(res, 502, { error: String(err) });
    }
  }
  // 群通知摄取（本地运行 QQ工具 group_export，信息本位过滤；不涉外部 URL）
  if (req.method === "GET" && url.startsWith("/api/ingest/qq")) {
    const name = new URL(url, "http://local").searchParams.get("name") || "网安2401官方群";
    const qqDir = env.QQ_TOOL_DIR || "C:\\Users\\Asus\\Documents\\QQ工具";
    const py64 = env.PY64 || "C:\\Users\\Asus\\miniconda3\\python.exe";
    const script = path.join(qqDir, "group_export.py");
    execFile(py64, [script, "--name", name], { cwd: qqDir, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return json(res, 503, { error: `group_export 失败: ${stderr || err.message}`, hint: "先运行 qq_cli.py key + decrypt，且 QQ 已登录" });
      try {
        const data = JSON.parse(fs.readFileSync(path.join(qqDir, "out", "last_group_info.json"), "utf8"));
        return json(res, 200, data);
      } catch (e) {
        return json(res, 503, { error: `读取导出失败: ${e.message}`, stdout });
      }
    });
    return;
  }
  // 微信群通知摄取（本地运行 wechat_cli，信息本位；不涉外部 URL）
  if (req.method === "GET" && url.startsWith("/api/ingest/wechat")) {
    const name = new URL(url, "http://local").searchParams.get("name") || "网安2401班";
    const qqDir = env.QQ_TOOL_DIR || "C:\\Users\\Asus\\Documents\\QQ工具";
    const py64 = env.PY64 || "C:\\Users\\Asus\\miniconda3\\python.exe";
    const script = path.join(qqDir, "wechat_cli.py");
    execFile(py64, [script, "run", "--name", name, "--auto"], { cwd: qqDir, timeout: 180000 }, (err, stdout, stderr) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(qqDir, "out", "last_wechat_group_info.json"), "utf8"));
        return json(res, 200, data);
      } catch (e) {
        return json(res, 503, { error: `微信摄取失败: ${stderr || err.message}`, hint: "先 wechat_cli.py key（或 --key）+ decrypt，且微信已登录" });
      }
    });
    return;
  }
  // 环境检测（零配置引导 / grill me）：本地进程/文件检查，不涉外部 URL
  if (req.method === "GET" && url === "/api/env/check") {
    const qqDir = env.QQ_TOOL_DIR || "C:\\Users\\Asus\\Documents\\QQ工具";
    const py64 = env.PY64 || "C:\\Users\\Asus\\miniconda3\\python.exe";
    let tasks = "";
    try { tasks = execSync("tasklist", { encoding: "utf8", timeout: 10000 }); } catch {}
    const lower = tasks.toLowerCase();
    return json(res, 200, {
      python64: fs.existsSync(py64),
      qqRunning: lower.includes("qq.exe"),
      wechatRunning: lower.includes("weixin.exe"),
      qqKey: fs.existsSync(path.join(qqDir, "data", "key.txt")),
      wechatKey: fs.existsSync(path.join(qqDir, "data", "wechat_key.txt")),
      workspace: qqDir,
    });
  }
  // 原生「选择文件夹」对话框：预热进程即时弹出，返回绝对路径，不让用户手填
  if (req.method === "GET" && url === "/api/workspace/pick") {
    const child = ensureDialog();
    const result = await new Promise((resolve) => {
      pickResolve = resolve;
      child.stdin.write("pick\n");
      setTimeout(() => { if (pickResolve) { pickResolve = null; resolve(null); } }, 120000);
    });
    return json(res, 200, { path: result || null });
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[llm-proxy] http://127.0.0.1:${PORT} (keys server-side only)`);
  ensureDialog(); // 预热对话框进程，首次点击即弹出
});