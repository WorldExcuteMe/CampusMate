// 本地开发服务端 LLM 代理 + 供应商管理。
// 密钥只存在于服务端（.env.local / .providers.local.json，均 gitignored），
// 浏览器经同源 /api/* 调用；前端 bundle 与 localStorage 不含任何密钥。
// 生产环境同一接口契约由 Supabase Edge Function / Sites Function 实现。
import http from "node:http";
import { createHandler } from "../functions/handler.ts";
import { safeFetch, htmlToText } from "../../backend/src/core/ssrf.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execSync, spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.env.CAMPUSMATE_DEV_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROVIDERS_FILE = path.join(root, ".providers.local.json");
const PORT = Number(process.env.CAMPUSMATE_PROXY_PORT ?? 8787);

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
async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) { const error = new Error("request_too_large"); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const env = { ...loadEnv(), ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined)) };
const origins = ["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:4173", "http://localhost:4173"];
const modelHandler = createHandler({
  authorize: async () => "local-developer",
  allowedOrigins: origins,
  providers: () => {
    const list = loadProviders();
    if (env.LLM_API_KEY) list.unshift({ id: "builtin-deepseek", name: env.LLM_DISPLAY_NAME || "服务端模型", baseUrl: env.LLM_BASE_URL || "https://api.deepseek.com", protocol: "openai", model: env.LLM_MODEL || "deepseek-chat", apiKey: env.LLM_API_KEY });
    return list;
  },
  saveProvider: (p) => saveProviders([...loadProviders().filter((x) => x.id !== p.id), p]),
  removeProvider: (id) => saveProviders(loadProviders().filter((x) => x.id !== id)),
});

// 普适：QQ 摄取工具默认用入仓 tools/qq-ingest（任何用户都有），env 可覆盖；python 自动探测 64 位。
const QQ_DIR = env.QQ_TOOL_DIR || path.join(root, "..", "tools", "qq-ingest");
function detectPython64() {
  const home = os.homedir();
  const cands = [
    env.PY64,
    path.join(home, "miniconda3", "python.exe"),
    path.join(home, "anaconda3", "python.exe"),
    path.join(home, "AppData", "Local", "Programs", "Python", "Python312", "python.exe"),
    path.join(home, "AppData", "Local", "Programs", "Python", "Python311", "python.exe"),
    "python", "python3", "py",
  ];
  for (const c of cands) {
    if (!c) continue;
    try {
      const out = execSync(`"${c}" -c "import struct;print(struct.calcsize('P')*8)"`, { timeout: 8000, encoding: "utf8" }).trim();
      if (out === "64") return c;
    } catch {}
  }
  return "python";
}
let python64;
const getPython64 = () => python64 ??= detectPython64();

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
  dialogChild = spawn("powershell", ["-STA", "-NoProfile", "-Command", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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

// 思考强度映射（服务端解析模型后下发该厂商 OpenAI-compatible 端点接受的参数）。
// 默认 low：本环境复杂度在检索广度而非推理深度，low 覆盖提取/分类/去重/路由/总结/检索；仅核验/冲突用 medium。
function reasoningParams(model, tier) {
  const m = String(model || "").toLowerCase();
  const t = tier || "low";
  if (/^(o1|o3|o4|gpt-5)/.test(m)) return { reasoning_effort: t };
  if (/qwen|qwq/.test(m)) return { enable_thinking: t !== "low" };
  return {}; // DeepSeek 思考由模型选择决定(chat/reasoner)；其余非思考模型零开销
}

const server = http.createServer(async (req, res) => {
  try {
  const url = req.url || "";
  // All endpoints have host/origin checks before any local filesystem/process access.
  const host = new URL(`http://${req.headers.host || "invalid"}`).hostname;
  const origin = req.headers.origin;
  const ownOrigin = `http://${req.headers.host}`;
  if (!["127.0.0.1", "localhost"].includes(host) || req.headers["sec-fetch-site"] === "cross-site" ||
      origin && origin !== ownOrigin && !origins.includes(origin)) return json(res, 403, { error: "origin_not_allowed" });
  if (req.method === "GET" && url === "/api/health") return json(res, 200, { ok: true, service: "campusmate-local-proxy" });
  const route = url.split("?")[0].replace(/^\/functions\/v1\/app/, "/api");
  if (route === "/api/llm" || route === "/api/providers" || route.startsWith("/api/providers/")) {
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);
    const result = await modelHandler(new Request(`http://${req.headers.host}${url}`, { method: req.method, headers: req.headers, ...(body === undefined ? {} : { body }) }));
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer())); return;
  }
  // 普适群发现：枚举本机所有群（uin/总数/信息密度/样例），供 agent 自动定位通知群
  if (req.method === "GET" && url.split("?")[0] === "/api/ingest/qq/groups") {
    const qqDir = QQ_DIR;
    const py64 = getPython64();
    const script = path.join(qqDir, "group_export.py");
    execFile(py64, [script, "--list", "--limit", "3"], { cwd: qqDir, timeout: 180000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) return json(res, 503, { error: `群发现失败: ${stderr || err.message}`, hint: "先运行 qq_cli.py key + decrypt，且 QQ 已登录" });
      try { return json(res, 200, JSON.parse(stdout)); }
      catch (e) { return json(res, 503, { error: `解析群列表失败: ${e.message}`, stdout: stdout.slice(0, 2000) }); }
    });
    return;
  }
  // 自主环境配置：短提示词全新环境下自动取钥+解密（QQ 需已登录），无需人工干预
  if (req.method === "POST" && url === "/api/ingest/bootstrap") {
    const cli = path.join(QQ_DIR, "qq_cli.py");
    const run = (args) => new Promise((resolve) => {
      execFile(getPython64(), [cli, ...args], { cwd: QQ_DIR, timeout: 120000 }, (err, stdout, stderr) => resolve({ err: err ? String(stderr || err.message) : null, stdout }));
    });
    const key = await run(["key"]);
    const dec = await run(["decrypt", "--no-wal"]);
    const qqKey = fs.existsSync(path.join(QQ_DIR, "data", "key.txt"));
    const plain = fs.existsSync(path.join(QQ_DIR, "data", "nt_msg.plain.db"));
    return json(res, 200, { ok: qqKey && plain, qqKey, plain, keyErr: key.err, decErr: dec.err });
  }
  // 群通知摄取（本地运行 QQ工具 group_export，信息本位过滤；不涉外部 URL）
  if (req.method === "GET" && url.startsWith("/api/ingest/qq")) {
    const params = new URL(url, "http://local").searchParams;
    const name = params.get("name") || "";
    const uin = params.get("uin") || "";
    const qqDir = QQ_DIR;
    const py64 = getPython64();
    const script = path.join(qqDir, "group_export.py");
    const args = [script];
    if (uin) args.push("--uin", uin);
    else if (name) args.push("--name", name);
    else return json(res, 400, { error: "name 或 uin 必填；先调 /api/ingest/qq/groups 定位群" });
    execFile(py64, args, { cwd: qqDir, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        const se = String(stderr || err.message || "");
        let code = "INGEST_FAILED";
        let hint = "确认 QQ(NT版) 已登录；工具已入仓 tools/qq-ingest，python 自动探测64位";
        if (/没找到 nt_msg.db|nt_msg\.db/.test(se)) { code = "QQ_DB_NOT_FOUND"; hint = "未找到QQ数据库：请确认QQ(NT版)已登录并产生过聊天记录"; }
        else if (/取钥|密钥|key/.test(se)) { code = "QQ_KEY_FAILED"; hint = "取钥失败：请确认QQ已登录（密钥从运行中QQ内存提取）"; }
        else if (/明文库不存在|自动解密失败/.test(se)) { code = "DECRYPT_FAILED"; hint = "自动解密失败：请确认QQ已登录，或手动 qq_cli.py key && qq_cli.py decrypt --no-wal"; }
        else if (/未找到群/.test(se)) { code = "GROUP_NOT_FOUND"; hint = "未找到该群：先用 list_groups 查看本机群"; }
        else if (/python|不是内部|command not found|ENOENT/.test(se)) { code = "PYTHON_MISSING"; hint = "未找到64位Python：安装Python3或设 env.PY64"; }
        return json(res, 503, { error: `群摄取失败[${code}]: ${se.slice(0, 300)}`, hint, code });
      }
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
    const qqDir = QQ_DIR;
    const py64 = getPython64();
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
    const qqDir = QQ_DIR;
    const py64 = getPython64();
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
  // 完全访问：终端执行（用户授权，普适使用者主机）
  if (req.method === "POST" && url === "/api/terminal") {
    const { command, cwd } = JSON.parse(await readBody(req));
    const workdir = cwd || env.QQ_TOOL_DIR || root;
    exec(command, { cwd: workdir, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      return json(res, 200, { stdout: stdout || "", stderr: stderr || "", code: err ? (err.code ?? 1) : 0 });
    });
    return;
  }
  // 完全访问：文件读
  if (req.method === "POST" && url === "/api/fs/read") {
    const { path: p } = JSON.parse(await readBody(req));
    try { return json(res, 200, { content: fs.readFileSync(p, "utf8").slice(0, 200000) }); }
    catch (e) { return json(res, 200, { error: String(e.message) }); }
  }
  // 完全访问：文件写
  if (req.method === "POST" && url === "/api/fs/write") {
    const { path: p, content } = JSON.parse(await readBody(req));
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, "utf8"); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 200, { error: String(e.message) }); }
  }
  // 网页抓取：仅请求任务给定的真实目标 URL，不替换代理
  if (req.method === "POST" && url === "/api/web/fetch") {
    const { url: target } = JSON.parse(await readBody(req));
    try {
      const r = await safeFetch(target);
      const html = r.text;
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return json(res, 200, { status: r.status, text: text.slice(0, 20000) });
    } catch (e) { return json(res, 200, { error: String(e.message) }); }
  }
  // RAG 检索：本地摄取数据 + 文档关键词召回
  if (req.method === "POST" && url === "/api/rag/search") {
    const { query, k, group } = JSON.parse(await readBody(req));
    const qqDir = QQ_DIR;
    // 源内检索：group 为纯数字群号时读该群导出文件，否则读最近一次摄取；防路径注入仅允许数字
    const file = group && /^\d+$/.test(String(group)) ? `group_${group}_info.json` : "last_group_info.json";
    let docs = [];
    try {
      const d = JSON.parse(fs.readFileSync(path.join(qqDir, "out", file), "utf8"));
      docs = (d.records || []).map((r) => ({ src: "qq:" + d.group, time: r.time || "", text: r.text }));
    } catch {}
    const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const scored = docs
      .map((d) => ({ ...d, score: words.reduce((s, w) => s + (d.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter((d) => d.score > 0).sort((a, b) => b.score - a.score).slice(0, k || 5);
    return json(res, 200, { results: scored });
  }
  // 广泛网页搜索：真实搜索引擎（DuckDuckGo html），返回标题+真实链接+摘要；不做代理替换
  if (req.method === "POST" && url === "/api/web/search") {
    const { query, limit } = JSON.parse(await readBody(req));
    try {
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query || ""))}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      const html = await r.text();
      const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const results = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && results.length < (Number(limit) || 6)) {
        let href = m[1];
        const u = href.match(/uddg=([^&]+)/);
        if (u) href = decodeURIComponent(u[1]);
        if (!/^https?:/.test(href)) continue;
        results.push({ title: strip(m[2]), url: href, snippet: strip(m[3]) });
      }
      return json(res, 200, { results });
    } catch (e) {
      return json(res, 200, { error: String(e.message), results: [] });
    }
  }
  json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e instanceof SyntaxError ? "invalid_json" : "local_request_failed" });
    else res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[llm-proxy] http://127.0.0.1:${server.address().port} (keys server-side only)`);
  // Dialog and Python discovery are lazy: do not spawn UI/process probes at startup.
});