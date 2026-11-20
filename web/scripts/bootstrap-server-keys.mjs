#!/usr/bin/env node
// 服务端模型密钥引导脚本。
//
// 作用：
// - 读取本机 C:/Users/Asus/DSAPI/API2.txt（Radeon）与 API MOSS.txt（Moss）；
// - 生成/复用 32 字节 master，写入 .local/sites/vault-master.json（仅本地，权限 0600）；
// - 用 AES-256-GCM 生成 campusmate_secrets 三行：__master__ / radeon / moss；
// - 通过官方站点 CLI 的 insert_database_rows 写入 app.campusmate_secrets。
//
// 安全约束：任何模式下都不打印密钥、密文、nonce、tag 或 CLI 原始输出；默认仅输出计划，
// 只有显式 --apply 才会调用 CLI。密钥只经 stdin 传给 CLI，不放进命令行参数。
//
// 用法：
//   node web/scripts/bootstrap-server-keys.mjs            # 只输出计划（默认）
//   node web/scripts/bootstrap-server-keys.mjs --apply    # 写入数据库
// 可用环境变量覆盖：
//   CAMPUSMATE_RADEON_KEY / CAMPUSMATE_MOSS_KEY            # 直接提供明文密钥
//   CAMPUSMATE_VAULT_WRAP_KEY                              # 包裹 master 的 32 字节密钥（hex/base64）
//   CAMPUSMATE_SITE_ID / CAMPUSMATE_PROJECT_ID             # 站点坐标
//   CAMPUSMATE_SITES_CLI / CAMPUSMATE_SITES_CLI_ARGS       # CLI 命令与前置参数
//
// Node 24 默认支持擦除式 TypeScript 语法，因此可以直接从 .mjs 导入 sites-exec.ts 的
// encrypt/decrypt；若使用更旧的 Node，请先升级或改用 --experimental-strip-types。

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decrypt,
  encrypt,
  decodeVaultKey,
  vaultAad,
  VAULT_MASTER_ID,
  VAULT_OWNER,
  VAULT_WRAP_ENV,
} from "../functions/sites-exec.ts";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "..");
const MASTER_FILE = join(REPO_ROOT, ".local", "sites", "vault-master.json");
const RECOVERY_IDS = join(REPO_ROOT, ".local", "sites", "recovery-ids.json");
const DEFAULT_RADEON_FILE = "C:/Users/Asus/DSAPI/API2.txt";
const DEFAULT_MOSS_FILE = "C:/Users/Asus/DSAPI/API MOSS.txt";
const TABLE = "campusmate_secrets";
const SCHEMA_REF_FILE = join(REPO_ROOT, ".local", "sites", "schema-ref.json");
const REQUEST_FILE = join(REPO_ROOT, ".local", "sites", "bootstrap-request.json");
const KEY_VERSION = 1;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("用法：node web/scripts/bootstrap-server-keys.mjs [--apply]");
  console.log("默认只输出计划；--apply 通过 CLI insert_database_rows 写入 campusmate_secrets。");
  console.log("密钥来源：CAMPUSMATE_RADEON_KEY / CAMPUSMATE_MOSS_KEY，或本机 DSAPI 文件。");
  console.log("任何情况下都不会把密钥打印到终端。");
  process.exit(0);
}
const apply = args.includes("--apply");
const unknown = args.filter(arg => arg !== "--apply");
if (unknown.length) {
  console.error("未知参数；只接受 --apply 或 --help。");
  process.exit(2);
}

const fail = (message) => {
  console.error(`[bootstrap-server-keys] ${message}`);
  process.exit(1);
};

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function resolveSiteIds() {
  const recovery = await readJsonFile(RECOVERY_IDS);
  const siteId = process.env.CAMPUSMATE_SITE_ID || recovery?.siteId || "";
  const projectId = process.env.CAMPUSMATE_PROJECT_ID || recovery?.projectId || "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(siteId) || !/^[A-Za-z0-9-]{8,64}$/.test(projectId)) {
    fail("缺少有效的 siteId/projectId（可用 CAMPUSMATE_SITE_ID / CAMPUSMATE_PROJECT_ID 覆盖）。");
  }
  return { siteId, projectId };
}

// 从密钥文件中提取候选 token；多候选时拒绝猜测，避免把错误的字符串写进 vault。
function extractCandidates(content) {
  const found = new Set();
  for (const raw of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(?:#|\/\/)/.test(line)) continue;
    const labeled = /(?:api[_-]?key|key|token|secret)\s*[:=]\s*["'`]?([A-Za-z0-9._~+\/=-]{16,})["'`]?/i.exec(line);
    if (labeled) {
      found.add(labeled[1]);
      continue;
    }
    for (const token of line.split(/[\s,;]+/)) {
      const clean = token.replace(/^["'`]+|["'`]+$/g, "");
      if (/^[A-Za-z0-9._~+\/=-]{16,}$/.test(clean)) found.add(clean);
    }
  }
  return [...found];
}

async function readProviderKey(file, envName, label) {
  const direct = process.env[envName]?.trim();
  if (direct) return direct;
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    fail(`${label}密钥文件不可读：${file}（也可用 ${envName} 提供）。`);
  }
  const candidates = extractCandidates(content);
  if (candidates.length === 0) fail(`${label}密钥文件未找到可用密钥。`);
  if (candidates.length > 1) fail(`${label}密钥文件包含多个候选，请用 ${envName} 明确指定。`);
  return candidates[0];
}

async function loadMasterFile() {
  let content;
  try {
    content = await readFile(MASTER_FILE, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    fail("vault-master.json 不可读；未读取或打印任何密钥。");
  }
  let data;
  try { data = JSON.parse(content); }
  catch { fail("vault-master.json 无法解析；未覆盖原文件。"); }
  if (!data || typeof data !== "object" || typeof data.masterKey !== "string") {
    fail("vault-master.json 格式无效；未读取或打印任何密钥。");
  }
  return data;
}

async function buildRows(masterKey, radeonKey, mossKey, at) {
  const radeon = await encrypt(radeonKey, masterKey, vaultAad("radeon", VAULT_OWNER, KEY_VERSION), KEY_VERSION);
  const moss = await encrypt(mossKey, masterKey, vaultAad("moss", VAULT_OWNER, KEY_VERSION), KEY_VERSION);
  const masterRow = { id: VAULT_MASTER_ID, owner_id: VAULT_OWNER, ciphertext: Buffer.from(masterKey).toString("base64"), nonce: "", tag: "", key_version: KEY_VERSION, updated_at: at };
  const toRow = (id, fields) => ({ id, owner_id: VAULT_OWNER, ciphertext: fields.ciphertext, nonce: fields.nonce, tag: fields.tag, key_version: fields.keyVersion, updated_at: at });
  const rows = [masterRow, toRow("radeon", radeon), toRow("moss", moss)];
  const check = await decrypt(radeon, masterKey, vaultAad("radeon", VAULT_OWNER, KEY_VERSION));
  if (check !== radeonKey) fail("vault 自检失败：未写入任何数据。");
  return rows;
}

function cliSpec() {
  const command = (process.env.CAMPUSMATE_SITES_CLI || "qoder").trim();
  const prefix = (process.env.CAMPUSMATE_SITES_CLI_ARGS || "").trim();
  if (!command) fail("CAMPUSMATE_SITES_CLI 为空。");
  return { command, args: prefix ? prefix.split(/\s+/) : [] };
}

// 只把加密行写入临时 JSON 文件，再经 --input-file 传给 CLI；stdout/stderr 不回显，
// 避免密钥或站点诊断信息进入日志。临时文件在调用结束后立即删除。
async function insertRowsViaCli(payload) {
  const { command, args: prefix } = cliSpec();
  const inputFile = join(REPO_ROOT, ".local", "sites", `insert-secrets-${payload.requestId}.json`);
  await writeFile(inputFile, JSON.stringify(payload), { mode: 0o600 });
  try {
    const output = await new Promise((resolvePromise, reject) => {
      let child;
      try {
        child = spawn(command, [...prefix, "insert_database_rows", "--input-file", inputFile], {
          stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32",
        });
      } catch { reject(new Error("无法启动站点 CLI")); return; }
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8"); });
      child.on("error", () => reject(new Error("无法启动站点 CLI")));
      child.on("close", (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`站点 CLI 退出码 ${code}`)));
      void stderr;
    });
    // 只读取回执状态，不回显任何行内容。
    try {
      const parsed = JSON.parse(output.replace(/^\uFEFF/, ""));
      const receipt = parsed?.result?.state ? parsed.result : parsed?.result?.result ?? {};
      return { state: receipt.state ?? "unknown", affected: receipt.affected_rows ?? null };
    } catch { return { state: "unknown", affected: null }; }
  } finally {
    await unlink(inputFile).catch(() => {});
  }
}

// 平台 insert_database_rows 要求每行 cells 的列集合一致，且 integer 用十进制字符串。
function toCells(row) {
  return Object.entries(row).map(([column, value]) => {
    if (value === null || value === undefined) return { type: "null", column };
    if (typeof value === "number") return { type: "integer", column, value: String(value) };
    if (typeof value === "boolean") return { type: "boolean", column, value: value ? "true" : "false" };
    if (typeof value === "object") return { type: "json", column, value: JSON.stringify(value) };
    return { type: "text", column, value: String(value) };
  });
}
// schemaRef 来自 get_database_schema；允许用环境变量显式覆盖。
async function resolveSchemaRef() {
  const direct = process.env.CAMPUSMATE_SCHEMA_REF?.trim();
  if (direct) return direct;
  const stored = await readJsonFile(SCHEMA_REF_FILE);
  if (stored && typeof stored.schemaRef === "string" && stored.schemaRef.length >= 40) return stored.schemaRef;
  return fail("缺少 schemaRef：先运行 get_database_schema 写入 .local/sites/schema-ref.json，或设置 CAMPUSMATE_SCHEMA_REF。");
}

// requestId 是这次写入意图的稳定标识；复用同一请求重试，不自动新建。
async function resolveRequestId() {
  const stored = await readJsonFile(REQUEST_FILE);
  if (stored && /^[0-9a-fA-F-]{36}$/.test(String(stored.requestId ?? ""))) return String(stored.requestId);
  const requestId = randomUUID();
  await writeFile(REQUEST_FILE, JSON.stringify({ requestId, table: TABLE, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return requestId;
}

async function main() {
  const { siteId, projectId } = await resolveSiteIds();
  const radeonKey = await readProviderKey(
    process.env.CAMPUSMATE_RADEON_FILE || DEFAULT_RADEON_FILE,
    "CAMPUSMATE_RADEON_KEY",
    "Radeon",
  );
  const mossKey = await readProviderKey(
    process.env.CAMPUSMATE_MOSS_FILE || DEFAULT_MOSS_FILE,
    "CAMPUSMATE_MOSS_KEY",
    "Moss",
  );

  await mkdir(dirname(MASTER_FILE), { recursive: true });
  const existing = await loadMasterFile();
  const masterKey = existing?.masterKey ? decodeVaultKey(existing.masterKey) : randomBytes(32);
  const at = Date.now();
  const rows = await buildRows(masterKey, radeonKey, mossKey, at);
  const schemaRef = await resolveSchemaRef();
  const requestId = await resolveRequestId();

  if (!apply) {
    console.log(JSON.stringify({
      status: "plan",
      siteId,
      projectId,
      table: TABLE,
      schemaRefPresent: Boolean(schemaRef),
      requestId,
      rows: rows.map(row => ({ id: row.id, owner: row.owner_id, keyVersion: row.key_version })),
      masterFile: MASTER_FILE,
      note: "默认不写入；使用 --apply 通过 CLI insert_database_rows 写入。未输出任何密钥或密文。",
    }, null, 2));
    return;
  }

  // master 文件始终保留在本机 .local（不提交），权限尽量收紧。
  const persist = {
    version: 1,
    masterKey: Buffer.from(masterKey).toString("base64"),
    createdAt: new Date(at).toISOString(),
  };
  await writeFile(MASTER_FILE, `${JSON.stringify(persist, null, 2)}\n`, { mode: 0o600 });

  const receipt = await insertRowsViaCli({
    siteId, tableName: TABLE, requestId, schemaRef,
    rows: rows.map(row => ({ cells: toCells(row) })),
  });
  if (receipt.state !== "succeeded") {
    fail(`插入未确认成功（state=${receipt.state}）；不要自动重试，先用 query_database_rows 核对。`);
  }

  console.log(JSON.stringify({
    status: "applied",
    siteId,
    projectId,
    table: TABLE,
    requestId,
    rows: rows.map(row => row.id),
    affectedRows: receipt.affected,
    masterFile: MASTER_FILE,
    note: "已通过 CLI insert_database_rows 写入；未输出任何密钥或密文。"
  }, null, 2));
}

main().catch((error) => {
  // 固定错误文案：不输出异常原文，避免文件内容或 CLI 输出进入日志。
  console.error(`[bootstrap-server-keys] 失败：${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
