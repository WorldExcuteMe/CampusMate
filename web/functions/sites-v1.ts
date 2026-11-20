// Sites V1 数据面：在已鉴权的 Sites 函数内提供 /v1/* 的会话、任务、审批、
// 产物与领域数据接口。所有查询都带 owner 谓词；上游错误只映射为安全码。
import { CloudAgentError } from "./cloud-agents.ts";
import { beijingTimeContext } from "./current-time.ts";
import { parseDocumentText } from "./document-parser.ts";
import { exportArtifact, availableFormats, type ExportSource } from "./export-formats.ts";
import { readCloudEvents, type CloudStreamEvent } from "./cloud-events.ts";

type Row = Record<string, unknown>;
type Filter = [string, unknown];

// 与平台 SDK 2 对齐的最小查询契约：select/eq/limit/update/insertIfAbsent。
export interface SitesV1Query extends PromiseLike<{ data: unknown; error?: unknown }> {
  select(columns: string): SitesV1Query;
  eq(column: string, value: unknown): SitesV1Query;
  limit(value: number): SitesV1Query;
  update(values: Record<string, unknown>): SitesV1Query;
  insertIfAbsent(values: Record<string, unknown>, options: { onConflict: string }): SitesV1Query;
}
export interface SitesV1Database { from(table: string): SitesV1Query }

export interface SitesV1CloudEvent extends Record<string, unknown> { id?: string; type: string }
export interface SitesV1CloudPage { data: unknown[]; next_page?: string | null; next?: string | null }
export interface SitesV1Cloud {
  createSession(agent: { id: string; version: number }, environmentId: string): Promise<{ id: string }>;
  sendMessage(sessionId: string, text: string): Promise<unknown>;
  // 结构化事件（工具结果/工具确认）。缺失时退回文本消息，保证 P0 仍可继续。
  sendEvent?(sessionId: string, event: Record<string, unknown>): Promise<unknown>;
  listEvents(sessionId: string, nextPage?: string): Promise<SitesV1CloudPage>;
  streamEvents(sessionId: string, lastEventId?: string, signal?: AbortSignal): Promise<Response>;
  cancelSession(sessionId: string): Promise<void>;
  getDownloadLink(fileId: string): Promise<{ url: string; expires_at?: string }>;
  fetch?: typeof fetch;
}

export interface SitesV1Config {
  agent: { id: string; version: number };
  environmentId: string;
  // 只读的托管 Provider 条目；不向浏览器暴露密钥。
  providers?: readonly Record<string, unknown>[];
  capabilities?: Record<string, unknown>;
  model?: string;
}

export interface SitesV1Deps {
  db: SitesV1Database;
  cloud: SitesV1Cloud;
  config: SitesV1Config;
  // 服务端模型分步执行器（可选）；存在时 srv-*/BYOK 任务走它，否则只用 Cloud Agents。
  exec?: { advance(taskId: string, owner: string, overrides?: Record<string, unknown>): Promise<{ status: string }> };
  // 运行时解析的 Cloud 绑定（含首次初始化）；缺省用静态 config.agent/environmentId。
  binding?: () => Promise<{ agent: { id: string; version: number }; environmentId: string }>;
  // 用户 BYOK：密钥写入/读取只在服务端；缺省时 providers 只读。
  vault?: {
    put(owner: string, providerId: string, apiKey: string): Promise<void>;
    remove(owner: string, providerId: string): Promise<void>;
    has(owner: string, providerId: string): Promise<boolean>;
    get(owner: string, providerId: string): Promise<string>;
  };
  // 必须来自已验证的平台身份；这里是唯一的 owner 来源。
  ownerOf: (ctx: { request: Request }) => string | null | undefined | Promise<string | null | undefined>;
}

interface AgentEventView {
  id: number;
  taskId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}
interface EventDraft {
  // cloudEventId 用于落库去重（派生事件带 #n 后缀）。
  cloudEventId: string;
  type: string;
  payload: Record<string, unknown>;
}
interface DomainResult { ok: boolean; summary: string; output: Record<string, unknown> }

const sessions = "campusmate_conversations";
const tasks = "campusmate_tasks";
const events = "campusmate_events";
const messages = "campusmate_messages";
const approvals = "campusmate_approvals";
const artifacts = "campusmate_artifacts";
const settings = "campusmate_settings";
const profile = "campusmate_profile";
const providersTable = "campusmate_providers";
const domainTables = { inbox: "campusmate_inbox", daily: "campusmate_daily", opportunities: "campusmate_opportunities" } as const;
const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "needs_input", "paused"]);
const safeTaskStatuses = new Set(["queued", "running", "needs_input", "paused", "succeeded", "failed", "cancelled"]);
const maxBody = 256 * 1024;
const maxTaskBody = 8 * 1024 * 1024;
const maxImportMessages = 500;

class AppError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
});
const dependencyError = () => new AppError(503, "sites_dependency_unavailable");

function rowsOf(result: { data: unknown; error?: unknown }): Row[] {
  if (result.error || !Array.isArray(result.data)) throw dependencyError();
  if (result.data.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw dependencyError();
  return result.data as Row[];
}
const clone = <T>(value: T): T => structuredClone(value);
const textOf = (value: unknown) => typeof value === "string" ? value : "";
const numberOr = (value: unknown, fallback = 0) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const integerOr = (value: unknown, fallback = 0) => {
  const number = numberOr(value, fallback);
  return Number.isSafeInteger(number) ? number : fallback;
};
// 历史增量水位依赖写入时间单调递增；同一实例内用模块级计数器消除同毫秒并列。
let historyClock = 0;
function historyTick(): number {
  historyClock = Math.max(Date.now(), historyClock + 1);
  return historyClock;
}
function jsonValue(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}
function jsonObject(value: unknown): Row {
  const parsed = jsonValue(value, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
}
// 工具参数只展示少量可读键，避免把正文/隐私整段写进事件。
function previewArgs(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const row = value as Row;
  const parts: string[] = [];
  for (const key of ["title", "query", "url", "filename", "name", "kind", "dueAt", "deadline"]) {
    const item = row[key];
    if (typeof item === "string" && item.trim()) parts.push(`${key}=${item.replace(/\s+/g, " ").trim().slice(0, 60)}`);
  }
  return parts.slice(0, 4).join(" · ").slice(0, 200);
}

function clampText(value: unknown, max: number): string {
  const text = textOf(value);
  return text.length > max ? text.slice(0, max) : text;
}
function summarize(value: unknown): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = value.map(block => block && typeof block === "object" && !Array.isArray(block) ? textOf((block as Row).text) : "").join("");
  else if (value && typeof value === "object") {
    try { text = JSON.stringify(value); } catch { text = ""; }
  }
  return clampText(text.replace(/\s+/g, " ").trim(), 500);
}
function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(block => block && typeof block === "object" && !Array.isArray(block) &&
    (block as Row).type === "text" ? textOf((block as Row).text) : "").join("");
}
function safeToolName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : "unknown_tool";
}
function safeFilename(value: unknown): string {
  const base = textOf(value).replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() ?? "";
  const name = base.trim().slice(0, 120);
  return name || "campusmate.md";
}
function safeDisplay(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) : "";
}
function safeId(value: unknown, code: string, max = 200): string {
  if (typeof value !== "string" || !value || value.length > max || !/^[A-Za-z0-9_.:-]+$/.test(value)) throw new AppError(400, code);
  return value;
}
// 云端事件 id / 工具调用 id 只作为不透明引用；限制字符集，避免派生主键出现奇怪字符。
function safeRef(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : fallback;
}
function onlyFields(data: Row, allowed: readonly string[]) {
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new AppError(400, "invalid_body");
}
function boundedNumber(value: unknown, fallback: number, max: number): number {
  const number = numberOr(value, fallback);
  return number >= 0 && number <= max ? Math.round(number) : fallback;
}
async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text));
}

async function readJson(request: Request, limit = maxBody): Promise<Row> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("Content-Type") ?? "")) throw new AppError(415, "json_required");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "body_required");
  let size = 0, text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new AppError(413, "body_too_large");
      text += decoder.decode(value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError(400, "invalid_body");
    return parsed as Row;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "invalid_body");
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* 已释放。 */ }
  }
}

// 网关会替换物理函数名；业务路由始终以 /v1/ 为边界。
function routeOf(pathname: string): string | null {
  const match = /(?:^|\/)v1(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return match[1] || "/";
}
function cloudPage(value: SitesV1CloudPage): { events: CloudStreamEvent[]; next?: string } {
  if (!value || !Array.isArray(value.data)) throw new AppError(502, "cloud_invalid_response");
  const next = value.next_page ?? value.next;
  return {
    events: value.data.filter((item): item is CloudStreamEvent =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item) && typeof (item as Row).type === "string"),
    next: typeof next === "string" && next ? next : undefined,
  };
}

function sessionView(row: Row) {
  return {
    id: textOf(row.id),
    title: textOf(row.title),
    mode: row.mode === "daily" ? "daily" : "auto",
    archived: row.archived === true,
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : numberOr(row.deleted_at),
    revision: integerOr(row.revision),
    createdAt: numberOr(row.created_at),
    updatedAt: numberOr(row.updated_at),
  };
}
function taskView(row: Row) {
  const usage = jsonObject(row.usage);
  const result = jsonValue(row.result, null);
  return {
    id: textOf(row.id),
    userId: textOf(row.owner_id),
    title: textOf(row.title),
    ...(row.intent ? { intent: textOf(row.intent) } : {}),
    status: safeTaskStatuses.has(textOf(row.status)) ? textOf(row.status) : "failed",
    usage: {
      tokens: integerOr(usage.tokens), toolCalls: integerOr(usage.toolCalls),
      wallMs: integerOr(usage.wallMs), costUsd: numberOr(usage.costUsd),
    },
    ...(result && typeof result === "object" ? { result } : {}),
    ...(row.error ? { error: textOf(row.error) } : {}),
    sessionId: textOf(row.session_id),
    turnId: textOf(row.turn_id),
    createdAt: numberOr(row.created_at),
    updatedAt: numberOr(row.updated_at),
    historyRevision: String(numberOr(row.updated_at)),
    cancelRequested: row.cancel_requested === true,
  };
}
function messageView(row: Row) {
  return {
    id: textOf(row.id),
    role: row.role === "assistant" ? "assistant" : "user",
    content: clampText(row.content, 100_000),
    turnId: textOf(row.turn_id),
    ...(row.task_id ? { taskId: textOf(row.task_id) } : {}),
    // 导入的历史记录帮助前端识别浏览器旧消息与云端记录是同一份。
    ...(textOf(row.id).startsWith("imp_") ? { imported: true } : {}),
    createdAt: numberOr(row.created_at),
    updatedAt: numberOr(row.updated_at),
  };
}
function eventView(row: Row): AgentEventView {
  return {
    id: integerOr(row.seq),
    taskId: textOf(row.task_id),
    seq: integerOr(row.seq),
    type: textOf(row.type),
    payload: jsonObject(row.payload),
    createdAt: numberOr(row.created_at),
  };
}
function approvalView(row: Row) {
  return {
    id: textOf(row.id),
    taskId: textOf(row.task_id),
    toolName: textOf(row.tool_name),
    risk: textOf(row.risk),
    status: textOf(row.status),
  };
}
function publicProvider(provider: Row) {
  const id = textOf(provider.id);
  const name = safeDisplay(provider.displayName ?? provider.name ?? id);
  const model = safeDisplay(provider.modelId ?? provider.model);
  return {
    id, name, displayName: name, model, modelId: model,
    protocol: safeDisplay(provider.protocol ?? "openai"),
    ...(typeof provider.baseUrl === "string" ? { baseUrl: provider.baseUrl.slice(0, 500) } : {}),
    ...(Number.isSafeInteger(provider.contextLimit) ? { contextLimit: Number(provider.contextLimit) } : {}),
    capabilities: jsonObject(provider.capabilities),
    // 只暴露“是否已在服务端配置密钥”，绝不返回密钥本身。
    managed: true, readonly: true, builtin: true,
    hasKey: Boolean(provider.apiKey) || provider.hasKey === true,
    ...(provider.isDefault === true ? { isDefault: true } : {}),
  };
}

function idleStatus(event: Row): string {
  const reason = event.stop_reason ?? event.reason;
  const type = reason && typeof reason === "object" && !Array.isArray(reason) ? textOf((reason as Row).type) : "";
  if (type === "error") return "failed";
  if (type === "interrupted") return "cancelled";
  if (type === "requires_action") return "needs_input";
  return "succeeded";
}
const askTools = new Set(["ask", "ask_user", "request_approval"]);

export function createSitesV1(deps: SitesV1Deps) {
  const { db, cloud, config } = deps;
  // 同一实例内的任务事件串行化：SSE 与轮询可能同时触发 reconcile。
  const taskLocks = new Map<string, Promise<unknown>>();
  async function withTaskLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = taskLocks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    taskLocks.set(key, current);
    try {
      return await current;
    } finally {
      if (taskLocks.get(key) === current) taskLocks.delete(key);
    }
  }

  async function selectRows(table: string, filters: Filter[], columns = "*", limit?: number): Promise<Row[]> {
    let query = db.from(table).select(columns);
    for (const [column, value] of filters) query = query.eq(column, value);
    if (limit !== undefined) query = query.limit(limit);
    return rowsOf(await query);
  }
  async function insertRow(table: string, row: Row, conflict = "id"): Promise<Row[]> {
    return rowsOf(await db.from(table).insertIfAbsent(clone(row), { onConflict: conflict }).select("*"));
  }
  async function updateRows(table: string, values: Row, filters: Filter[]): Promise<Row[]> {
    let query = db.from(table).update(clone(values));
    for (const [column, value] of filters) query = query.eq(column, value);
    return rowsOf(await query.select("*"));
  }

  async function readTask(owner: string, id: string): Promise<Row | null> {
    const found = await selectRows(tasks, [["id", id], ["owner_id", owner]], "*", 1);
    return found[0] ?? null;
  }
  async function readSession(owner: string, id: string): Promise<Row | null> {
    const found = await selectRows(sessions, [["id", id], ["owner_id", owner]], "*", 1);
    return found[0] ?? null;
  }
  async function requireSession(owner: string, id: string): Promise<Row> {
    const session = await readSession(owner, id);
    if (!session || session.deleted_at !== null && session.deleted_at !== undefined) throw new AppError(404, "session_not_found");
    return session;
  }
  async function requireTask(owner: string, id: string): Promise<Row> {
    const task = await readTask(owner, id);
    if (!task) throw new AppError(404, "task_not_found");
    return task;
  }
  async function patchTask(task: Row, patch: Row, expectedStatus?: string): Promise<boolean> {
    const at = historyTick();
    const filters: Filter[] = [["id", task.id], ["owner_id", task.owner_id]];
    if (expectedStatus !== undefined) filters.push(["status", expectedStatus]);
    const changed = await updateRows(tasks, { ...patch, updated_at: at }, filters);
    if (changed.length !== 1) return false;
    Object.assign(task, patch, { updated_at: at });
    return true;
  }
  async function nextOrd(owner: string, sessionId: string): Promise<number> {
    const found = await selectRows(messages, [["owner_id", owner], ["session_id", sessionId]], "ord");
    return found.reduce((max, row) => Math.max(max, integerOr(row.ord)), 0) + 1;
  }
  // 懒建 Cloud Session，并用 updated_at 作为非空 CAS 令牌，避免同一会话绑定到多个云 Session。
  async function ensureCloudSession(owner: string, sessionId: string): Promise<string> {
    return withTaskLock(`session:${sessionId}`, async () => {
      let createdId = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const session = await readSession(owner, sessionId);
        if (!session) throw new AppError(404, "session_not_found");
        if (session.deleted_at !== null && session.deleted_at !== undefined) throw new AppError(404, "session_not_found");
        const bound = textOf(session.cloud_session_id);
        if (bound) return bound;
        // 首次创建时按运行时解析绑定；之后直接用静态配置补齐行元数据。
        const target = !createdId && deps.binding
          ? await deps.binding()
          : { agent: config.agent, environmentId: config.environmentId };
        if (!createdId) {
          createdId = textOf((await cloud.createSession(target.agent, target.environmentId)).id);
          if (!createdId) throw new AppError(502, "cloud_invalid_response");
        }
        const changed = await updateRows(sessions, {
          cloud_session_id: createdId, agent_id: target.agent.id, agent_version: target.agent.version,
          environment_id: target.environmentId, updated_at: historyTick(),
        }, [["id", sessionId], ["owner_id", owner], ["updated_at", numberOr(session.updated_at)]]);
        // 另一个实例先完成绑定（或改过会话元数据）时重读，绝不覆盖已有绑定。
        if (changed.length === 1) return createdId;
      }
      throw new AppError(409, "session_binding_conflict");
    });
  }

  // 每条 AgentEvent 用 seq_counter 做 CAS 写入；并发重放时只允许一个写入者前进。
  async function persistEvent(owner: string, task: Row, draft: EventDraft): Promise<AgentEventView> {
    const eventId = `${textOf(task.id)}:${draft.cloudEventId}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = attempt === 0 ? task : await readTask(owner, textOf(task.id));
      if (!current) throw new AppError(404, "task_not_found");
      const duplicate = await selectRows(events, [["id", eventId], ["task_id", task.id], ["owner_id", owner]], "*", 1);
      if (duplicate.length) {
        task.seq_counter = integerOr(current.seq_counter);
        return eventView(duplicate[0]);
      }
      const previousSeq = integerOr(current.seq_counter);
      const seq = previousSeq + 1;
      const at = historyTick();
      const changed = await updateRows(tasks, {
        seq_counter: seq, updated_at: at,
      }, [["id", task.id], ["owner_id", owner], ["seq_counter", previousSeq]]);
      if (changed.length !== 1) continue;
      // 主键由云端事件 id 决定：并发读取即使各自推进了 seq，也只会落一条事件。
      const inserted = await insertRow(events, {
        id: eventId, task_id: textOf(task.id), owner_id: owner, seq,
        cloud_event_id: draft.cloudEventId, type: draft.type, payload: draft.payload, created_at: at,
      });
      if (!inserted.length) {
        // 另一实例抢先写入：回收空序号，避免前端等待一个永远缺失的 seq。
        await updateRows(tasks, { seq_counter: previousSeq }, [
          ["id", task.id], ["owner_id", owner], ["seq_counter", seq],
        ]).catch(() => []);
        task.seq_counter = previousSeq;
        const existing = await selectRows(events, [["id", eventId], ["task_id", task.id], ["owner_id", owner]], "*", 1);
        if (existing.length) return eventView(existing[0]);
        continue;
      }
      task.seq_counter = seq;
      task.updated_at = at;
      return { id: seq, taskId: textOf(task.id), seq, type: draft.type, payload: draft.payload, createdAt: at };
    }
    throw dependencyError();
  }

  function makeDrafts(cloudId: string, items: [string, Row][]): EventDraft[] {
    return items.map(([type, payload], index) => ({
      cloudEventId: index === 0 ? cloudId : `${cloudId}#${index}`,
      type, payload,
    }));
  }

  async function finalizeTask(owner: string, task: Row, status: string, reason?: string, errorCode?: string) {
    // 用户已取消的任务不再被迟到的 idle/error 覆盖。
    const current = await readTask(owner, textOf(task.id));
    if (!current) return;
    if (textOf(current.status) === "cancelled") {
      task.status = "cancelled";
      task.cancel_requested = true;
      return;
    }
    const history = await selectRows(events, [["task_id", task.id], ["owner_id", owner]], "type,payload,seq");
    const summary = history.filter(row => row.type === "llm.delta")
      .sort((a, b) => integerOr(a.seq) - integerOr(b.seq))
      .map(row => textOf(jsonObject(row.payload).text)).join("").slice(0, 12_000);
    const files = await selectRows(artifacts, [["task_id", task.id], ["owner_id", owner]], "id");
    // 空 summary 不写入，前端才能回退到 error 或状态提示。
    const result: Row = {
      ...(summary ? { summary } : {}), artifactIds: files.map(row => textOf(row.id)),
      completion: { state: status === "succeeded" ? "complete" : "partial", reason: reason ?? (status === "succeeded" ? "end_turn" : "execution_interrupted") },
    };
    const patch: Row = { status, result };
    if (errorCode) patch.error = errorCode;
    if (status === "cancelled") patch.cancel_requested = true;
    // 状态 CAS 落败说明已被取消或另一终态写入；此时不得再补写 assistant 消息。
    if (!await patchTask(task, patch, textOf(current.status))) {
      task.status = textOf(current.status);
      return;
    }
    if (summary) {
      const at = historyTick();
      await insertRow(messages, {
        id: `msg_${textOf(task.id)}_assistant`, owner_id: owner, session_id: textOf(task.session_id),
        turn_id: textOf(task.turn_id), task_id: textOf(task.id), role: "assistant", content: summary,
        ord: await nextOrd(owner, textOf(task.session_id)), created_at: at, updated_at: at,
      });
    }
  }

  async function saveArtifact(owner: string, task: Row, event: Row): Promise<Row | null> {
    const fileId = textOf(event.file_id);
    if (!/^file_[A-Za-z0-9_-]{1,160}$/.test(fileId)) return null;
    const existing = await selectRows(artifacts, [["id", fileId], ["owner_id", owner]], "*", 1);
    if (existing.length) return existing[0];
    const row: Row = {
      id: fileId, owner_id: owner, task_id: textOf(task.id), cloud_file_id: fileId,
      filename: safeFilename(event.original_filename ?? event.filename ?? "campusmate.md"),
      content_type: clampText(event.content_type, 100) || "application/octet-stream",
      size: Number.isSafeInteger(event.size) && Number(event.size) >= 0 ? Number(event.size) : 0,
      sha256: null, inline: null, created_at: Date.now(),
    };
    const inserted = await insertRow(artifacts, row);
    return inserted[0] ?? (await selectRows(artifacts, [["id", fileId], ["owner_id", owner]], "*", 1))[0] ?? null;
  }

  async function sendCloudEvent(session: Row, event: Row) {
    const sessionId = textOf(session.cloud_session_id);
    if (!sessionId) return;
    if (typeof cloud.sendEvent === "function") await cloud.sendEvent(sessionId, clone(event));
    else await cloud.sendMessage(sessionId, JSON.stringify(event));
  }
  async function sendToolResult(session: Row, toolUseId: string, ok: boolean, output: Row) {
    // 回传给云端的工具结果也必须有界，避免超过事件/消息体积上限。
    const text = clampText(JSON.stringify(output), 16_000);
    await sendCloudEvent(session, {
      type: "user.custom_tool_result", tool_use_id: toolUseId,
      content: [{ type: "text", text }], is_error: !ok,
    });
  }

  async function executeDomainTool(owner: string, task: Row, name: string, input: Row, toolUseId: string): Promise<DomainResult> {
    const [table, prefix] = name === "save_to_inbox" ? [domainTables.inbox, "inbox"]
      : name === "create_daily_task" ? [domainTables.daily, "daily"]
      : ["create_opportunity", "save_opportunity"].includes(name) ? [domainTables.opportunities, "opp"]
      : ["", ""];
    if (table) {
      const id = `${prefix}_${(await sha256Text(`${owner}\n${toolUseId}`)).slice(0, 24)}`;
      const at = Date.now();
      const data = { ...input, taskId: textOf(task.id), source: "agent", savedAt: at };
      const existing = await selectRows(table, [["id", id], ["owner_id", owner]], "id", 1);
      if (!existing.length) {
        await insertRow(table, { id, owner_id: owner, data, created_at: at, updated_at: at });
      }
      const label = name === "save_to_inbox" ? "已保存到 Inbox" : name === "create_daily_task" ? "已创建日常任务" : "已保存到机会雷达";
      return { ok: true, summary: label, output: { id, ...data } };
    }
    if (["set_growth_goal", "update_profile"].includes(name)) {
      const current = await selectRows(profile, [["owner_id", owner]], "*", 1);
      const data = current.length ? jsonObject(current[0].data) : {};
      const goals = Array.isArray(data.goals) ? data.goals.filter(goal => typeof goal === "string") : [];
      const goal = textOf(input.goal);
      if (goal && !goals.includes(goal)) goals.push(goal.slice(0, 500));
      const merged = { ...data, goals, ...(typeof input.name === "string" ? { name: input.name.slice(0, 200) } : {}) };
      const at = Date.now();
      if (current.length) await updateRows(profile, { data: merged, updated_at: at }, [["owner_id", owner]]);
      else await insertRow(profile, { owner_id: owner, data: merged, updated_at: at }, "owner_id");
      return { ok: true, summary: "已更新个人画像", output: { goals: merged.goals } };
    }
    return { ok: false, summary: "unsupported_tool", output: { error: "unsupported_tool", tool: name } };
  }

  async function createApproval(owner: string, task: Row, toolUseId: string, input: Row): Promise<{ id: string; risk: string }> {
    const id = `apr_${(await sha256Text(`${textOf(task.id)}\n${toolUseId}`)).slice(0, 24)}`;
    // 审批面板只展示 risk 文本；优先提供 ask 的问题，便于用户判断。
    const question = clampText(textOf(input.question ?? input.prompt ?? input.message).replace(/\s+/g, " ").trim(), 500);
    const risk = question || (typeof input.risk === "string" && /^[a-z_]{1,40}$/.test(input.risk) ? input.risk : "confirm");
    const existing = await selectRows(approvals, [["id", id], ["owner_id", owner]], "id", 1);
    if (!existing.length) {
      await insertRow(approvals, {
        id, owner_id: owner, task_id: textOf(task.id), tool_name: "ask",
        args: { tool_use_id: toolUseId, input }, risk, status: "pending", created_at: Date.now(), decided_at: null,
      });
    }
    return { id, risk };
  }

  // 翻译并持久化云端事件。返回 stop 表示流应关闭（终态或等待审批）。
  async function processCloudEvents(
    owner: string, task: Row, session: Row | null, incoming: CloudStreamEvent[], sink?: (event: AgentEventView) => void,
  ): Promise<{ stop: boolean; emitted: AgentEventView[] }> {
    return withTaskLock(textOf(task.id), () => processCloudEventsLocked(owner, task, session, incoming, sink));
  }
  async function processCloudEventsLocked(
    owner: string, task: Row, session: Row | null, incoming: CloudStreamEvent[], sink?: (event: AgentEventView) => void,
  ): Promise<{ stop: boolean; emitted: AgentEventView[] }> {
    const existing = await selectRows(events, [["task_id", task.id], ["owner_id", owner]], "cloud_event_id");
    const seen = new Set(existing.map(row => textOf(row.cloud_event_id)));
    const emitted: AgentEventView[] = [];
    let stop = false;

    for (const raw of incoming) {
      const event = raw as unknown as Row;
      const type = textOf(event.type).replace(/^agent\./, "");
      const cloudId = textOf(event.id);
      if (!type || !/^[A-Za-z0-9_.:-]{1,200}$/.test(cloudId)) continue;
      const fresh = !seen.has(cloudId);
      const drafts: EventDraft[] = [];
      let stopAfter = false;

      switch (type) {
        case "tool_use": {
          const name = safeToolName(event.name);
          const toolUseId = safeRef(event.tool_use_id, cloudId);
          const args = previewArgs(event.input ?? event.arguments);
          drafts.push(...makeDrafts(cloudId, [
            ["tool.called", { name, toolUseId, callInstanceId: toolUseId, ...(args ? { argsSummary: args } : {}) }],
            ["step.started", { name, toolUseId }],
          ]));
          break;
        }
        case "tool_result": {
          const toolUseId = safeRef(event.tool_use_id, "");
          const durationMs = boundedNumber(event.duration_ms ?? event.durationMs, 0, 3_600_000);
          drafts.push(...makeDrafts(cloudId, [["tool.result", {
            ok: event.is_error !== true, durationMs,
            summary: summarize(event.content ?? event.output ?? event.result),
            ...(toolUseId ? { toolUseId, callInstanceId: toolUseId } : {}),
          }]]));
          break;
        }
        case "message": {
          const text = extractText(event.content);
          if (text) drafts.push(...makeDrafts(cloudId, [["llm.delta", { text: clampText(text, 16_000) }]]));
          break;
        }
        case "thinking": {
          // L2：只保留有界摘要，不持久化完整思考原文。
          const summary = extractText(event.content).replace(/\s+/g, " ").trim();
          drafts.push(...makeDrafts(cloudId, [["step.started", { phase: "thinking" }]]));
          if (summary) {
            // 平台 thinking 事件按到达顺序转成增量，聊天内可边思考边显示。
            drafts.push(...makeDrafts(`${cloudId}:delta`, [["thinking.delta", { text: clampText(summary, 2_000) }]]));
            drafts.push(...makeDrafts(`${cloudId}:summary`, [["thinking.summary", {
              excerpt: clampText(summary, 240), chars: summary.length, source: "cloud",
            }]]));
          }
          break;
        }
        case "artifact_delivered": {
          const artifact = await saveArtifact(owner, task, event);
          if (artifact) {
            drafts.push(...makeDrafts(cloudId, [["tool.result", {
              ok: true, name: "DeliverArtifacts", artifactId: textOf(artifact.id),
              summary: `已交付 ${safeDisplay(artifact.filename)}`,
            }]]));
          }
          break;
        }
        case "custom_tool_use": {
          const name = safeToolName(event.name);
          const tool = name.split(".").pop() || name;
          const toolUseId = safeRef(event.tool_use_id, cloudId);
          if (askTools.has(tool)) {
            if (fresh) {
              const approval = await createApproval(owner, task, toolUseId, jsonObject(event.input ?? event.arguments));
              await finalizeTask(owner, task, "needs_input", "approval_pending");
              drafts.push(...makeDrafts(cloudId, [
                ["tool.approval_requested", { approvalId: approval.id, toolName: "ask", risk: approval.risk }],
                ["task.needs_input", { reason: "approval_pending", approvalId: approval.id }],
              ]));
            }
            stopAfter = true;
            break;
          }
          let result: DomainResult = { ok: false, summary: "unsupported_tool", output: { error: "unsupported_tool" } };
          if (fresh) {
            result = await executeDomainTool(owner, task, tool, jsonObject(event.input ?? event.arguments), toolUseId);
            if (session) await sendToolResult(session, toolUseId, result.ok, result.output);
          }
          drafts.push(...makeDrafts(cloudId, [
            ["tool.called", { name: tool, toolUseId, callInstanceId: toolUseId }],
            ["tool.result", { ok: result.ok, summary: result.summary, name: tool, toolUseId, callInstanceId: toolUseId }],
          ]));
          break;
        }
        case "idle":
        case "session.status_idle": {
          const derived = idleStatus(event);
          if (fresh) {
            const reason = derived === "needs_input" ? "approval_pending" : derived === "failed" ? "execution_interrupted" : undefined;
            await finalizeTask(owner, task, derived, reason, derived === "failed" ? "execution_failed" : undefined);
          }
          // 取消可能发生在 finalize 前；以任务当前状态为准，避免把已取消任务显示为成功。
          const status = safeTaskStatuses.has(textOf(task.status)) ? textOf(task.status) : derived;
          drafts.push(...makeDrafts(cloudId, [["task.status", { status }]]));
          stopAfter = true;
          break;
        }
        case "error":
        case "session.error": {
          if (fresh) await finalizeTask(owner, task, "failed", "execution_interrupted", "execution_failed");
          const status = textOf(task.status) === "cancelled" ? "cancelled" : "failed";
          drafts.push(...makeDrafts(cloudId, [["task.status", {
            status, ...(status === "failed" ? { code: "execution_failed" } : {}),
          }]]));
          stopAfter = true;
          break;
        }
        default:
          // 未知事件不落库、不透传载荷。
          break;
      }

      for (const draft of drafts) {
        if (seen.has(draft.cloudEventId)) continue;
        const view = await persistEvent(owner, task, draft);
        seen.add(draft.cloudEventId);
        emitted.push(view);
        sink?.(view);
      }
      // 仅在整条云端事件的所有派生事件落库后推进游标；中途失败时重连会重新读取该事件。
      const cursorAt = historyTick();
      const cursorChanged = await updateRows(tasks, {
        last_cloud_event_id: cloudId, updated_at: cursorAt,
      }, [["id", task.id], ["owner_id", owner]]);
      if (cursorChanged.length === 1) {
        task.last_cloud_event_id = cloudId;
        task.updated_at = cursorAt;
      }
      seen.add(cloudId);
      if (stopAfter) { stop = true; break; }
    }
    return { stop, emitted };
  }

  // 用 last_cloud_event_id 之后的历史补齐；cloud_event_id 去重保证重放幂等。
  async function reconcile(owner: string, task: Row, session: Row | null): Promise<void> {
    if (!session || !textOf(session.cloud_session_id)) return;
    if (terminalStatuses.has(textOf(task.status))) return;
    let page: string | undefined;
    for (let index = 0; index < 20; index++) {
      const parsed = cloudPage(await cloud.listEvents(textOf(session.cloud_session_id), page));
      if (parsed.events.length) {
        const processed = await processCloudEvents(owner, task, session, parsed.events);
        if (processed.stop) return;
      }
      page = parsed.next;
      if (!page) return;
    }
  }

  async function listTaskEvents(owner: string, taskId: string, after: number): Promise<AgentEventView[]> {
    const found = await selectRows(events, [["task_id", taskId], ["owner_id", owner]]);
    return found.map(eventView).filter(event => event.seq > after).sort((a, b) => a.seq - b.seq);
  }
  async function readTaskEventsAfter(owner: string, request: Request, task: Row, fallback = 0): Promise<{ events: AgentEventView[]; after: number }> {
    const url = new URL(request.url);
    const raw = url.searchParams.get("after") ?? request.headers.get("Last-Event-ID") ?? "";
    const after = raw === "" ? fallback : integerOr(raw, -1);
    if (after < 0) throw new AppError(400, "invalid_cursor");
    return { events: await listTaskEvents(owner, textOf(task.id), after), after };
  }

  async function loadArtifactInline(owner: string, artifact: Row): Promise<{ text: string; sha256: string }> {
    const inline = jsonObject(artifact.inline);
    if (typeof inline.text === "string") return { text: inline.text, sha256: textOf(artifact.sha256) };
    let url: URL;
    try { url = new URL((await cloud.getDownloadLink(textOf(artifact.cloud_file_id))).url); }
    catch { throw new AppError(502, "artifact_unavailable"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new AppError(502, "artifact_unavailable");
    const fetcher = cloud.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(url.href, { redirect: "error", cache: "no-store" });
    } catch {
      throw new AppError(502, "artifact_unavailable");
    }
    if (!response.ok) throw new AppError(502, "artifact_unavailable");
    const declared = Number(response.headers.get("Content-Length") ?? "");
    if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
      try { await response.body?.cancel(); } catch { /* 释放下载连接。 */ }
      throw new AppError(413, "artifact_too_large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 2 * 1024 * 1024) throw new AppError(413, "artifact_too_large");
    const text = new TextDecoder("utf-8").decode(bytes);
    const served = new TextEncoder().encode(text);
    const sha256 = await sha256Bytes(served);
    await updateRows(artifacts, {
      inline: { format: "md", text }, sha256, size: served.byteLength, content_type: "text/markdown; charset=utf-8",
    }, [["id", artifact.id], ["owner_id", owner]]);
    artifact.inline = { format: "md", text };
    artifact.sha256 = sha256;
    artifact.size = served.byteLength;
    return { text, sha256 };
  }
  function artifactSource(row: Row): ExportSource {
    const inline = jsonObject(row.inline);
    const src = inline.source && typeof inline.source === "object" && !Array.isArray(inline.source) ? inline.source as Row : {};
    return {
      title: textOf(src.title) || textOf(row.filename).replace(/\.[^.]*$/, "") || "campusmate",
      markdown: textOf(inline.text),
      ...(src.table && typeof src.table === "object" ? { table: src.table as ExportSource["table"] } : {}),
      ...(Array.isArray(src.slides) ? { slides: src.slides as ExportSource["slides"] } : {}),
      ...(src.chart && typeof src.chart === "object" ? { chart: src.chart as ExportSource["chart"] } : {}),
      ...(typeof src.mermaid === "string" ? { mermaid: src.mermaid } : {}),
      ...(src.json !== undefined ? { json: src.json } : {}),
      ...(Number.isSafeInteger(src.section) ? { section: Number(src.section) } : {}),
      ...(Number.isSafeInteger(src.totalSections) ? { totalSections: Number(src.totalSections) } : {}),
    };
  }
  function artifactView(row: Row, inline?: { text: string; sha256: string }) {
    const source = inline ?? (jsonObject(row.inline).text !== undefined
      ? { text: textOf(jsonObject(row.inline).text), sha256: textOf(row.sha256) } : null);
    return {
      id: textOf(row.id), taskId: textOf(row.task_id), documentId: textOf(row.cloud_file_id), revision: 1,
      sha256: textOf(row.sha256), kind: "markdown", filename: textOf(row.filename), contentType: textOf(row.content_type),
      size: integerOr(row.size),
      inline: source ? { format: "md", text: source.text } : null,
      primaryFormat: textOf(jsonObject(row.inline).primaryFormat) || undefined,
      section: Number.isSafeInteger(jsonObject(jsonObject(row.inline).source).section) ? Number(jsonObject(jsonObject(row.inline).source).section) : undefined,
      totalSections: Number.isSafeInteger(jsonObject(jsonObject(row.inline).source).totalSections) ? Number(jsonObject(jsonObject(row.inline).source).totalSections) : undefined,
      source: artifactSource(row),
      availableFormats: availableFormats(artifactSource(row)),
    };
  }

  // 历史分页按“轮次”分组；游标编码为 createdAt.seq.index.key 的稳定字符串。
  function encodeOrder(order: [number, number, number, string]): string {
    return `${order[0]}.${order[1]}.${order[2]}.${encodeURIComponent(order[3])}`;
  }
  function decodeOrder(value: string | null): [number, number, number, string] | null {
    if (!value) return null;
    const match = /^(\d{1,16})\.(\d{1,16})\.(\d{1,16})\.(.*)$/.exec(value);
    if (!match) throw new AppError(400, "invalid_cursor");
    try { return [Number(match[1]), Number(match[2]), Number(match[3]), decodeURIComponent(match[4])]; }
    catch { throw new AppError(400, "invalid_cursor"); }
  }
  function compareOrder(a: [number, number, number, string], b: [number, number, number, string]): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3].localeCompare(b[3]);
  }
  async function buildHistory(owner: string, sessionId: string) {
    const [taskRows, messageRows] = await Promise.all([
      selectRows(tasks, [["owner_id", owner], ["session_id", sessionId]]),
      selectRows(messages, [["owner_id", owner], ["session_id", sessionId]]),
    ]);
    const groups = new Map<string, { created: number; updated: number; messages: Row[]; task?: Row }>();
    for (const message of messageRows.sort((a, b) => integerOr(a.ord) - integerOr(b.ord))) {
      const key = textOf(message.turn_id) || textOf(message.id);
      const group = groups.get(key) ?? { created: integerOr(message.created_at), updated: integerOr(message.updated_at), messages: [] };
      group.created = Math.min(group.created, integerOr(message.created_at));
      group.updated = Math.max(group.updated, integerOr(message.updated_at));
      group.messages.push(message);
      groups.set(key, group);
    }
    for (const task of taskRows) {
      const key = textOf(task.turn_id) || textOf(task.id);
      const group = groups.get(key) ?? { created: integerOr(task.created_at), updated: integerOr(task.updated_at), messages: [] };
      group.created = Math.min(group.created, integerOr(task.created_at));
      group.updated = Math.max(group.updated, integerOr(task.updated_at));
      group.task = task;
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => {
      const order: [number, number, number, string] = [group.created, 0, 0, key];
      const version = String(group.updated || group.created);
      return {
        key, order, version,
        task: group.task ? taskView(group.task) : undefined,
        messages: group.messages.map(message => ({
          ...messageView(message),
          historyKey: key, historyOrder: order, historyVersion: version,
        })),
      };
    }).sort((a, b) => compareOrder(a.order, b.order));
  }
  function historyPage(
    session: Row, items: Awaited<ReturnType<typeof buildHistory>>, after: string,
    before: string | undefined, hasMore: boolean, totalTokens: number, next?: string, withTotal = true,
  ) {
    return {
      session: sessionView(session), items, after,
      ...(before ? { before } : {}), hasMore,
      ...(next ? { next } : {}), ...(withTotal ? { totalTokens } : {}),
    };
  }

  async function decideApproval(owner: string, id: string, decision: string): Promise<Response> {
    if (decision !== "approved" && decision !== "rejected") throw new AppError(400, "invalid_decision");
    const found = await selectRows(approvals, [["id", id], ["owner_id", owner]], "*", 1);
    if (!found.length) throw new AppError(404, "approval_not_found");
    const approval = found[0];
    if (textOf(approval.status) === decision) return json(200, { ok: true, approval: approvalView(approval), deduped: true });
    if (textOf(approval.status) !== "pending") throw new AppError(409, "approval_decided");
    const changed = await updateRows(approvals, { status: decision, decided_at: Date.now() }, [
      ["id", id], ["owner_id", owner], ["status", "pending"],
    ]);
    if (changed.length !== 1) throw new AppError(409, "approval_decided");
    const task = await readTask(owner, textOf(approval.task_id));
    const args = jsonObject(approval.args);
    const toolUseId = textOf(args.tool_use_id);
    if (task) {
      const session = await readSession(owner, textOf(task.session_id));
      if (session && toolUseId) {
        await sendCloudEvent(session, {
          type: "user.tool_confirmation", tool_use_id: toolUseId,
          decision, approved: decision === "approved",
        });
      }
      await patchTask(task, { status: "running", error: null, cancel_requested: false });
    }
    return json(200, { ok: true, approval: { ...approvalView(approval), status: decision } });
  }

  async function createSessionRoute(owner: string, request: Request): Promise<Response> {
    const data = await readJson(request);
    onlyFields(data, ["id", "title", "mode"]);
    const id = safeId(data.id, "invalid_session_id");
    const title = clampText(data.title, 200);
    if (!title.trim()) throw new AppError(400, "invalid_title");
    const mode = data.mode === "daily" ? "daily" : "auto";
    const existing = await selectRows(sessions, [["id", id], ["owner_id", owner]], "*", 1);
    if (existing.length) return json(200, { session: sessionView(existing[0]), deduped: true });
    const at = Date.now();
    const inserted = await insertRow(sessions, {
      id, owner_id: owner, title, mode, archived: false, deleted_at: null, revision: 0,
      cloud_session_id: null, agent_id: null, agent_version: null, environment_id: null,
      created_at: at, updated_at: at,
    });
    if (!inserted.length) {
      const ownerCopy = await selectRows(sessions, [["id", id], ["owner_id", owner]], "*", 1);
      if (ownerCopy.length) return json(200, { session: sessionView(ownerCopy[0]), deduped: true });
      throw new AppError(409, "session_conflict");
    }
    return json(201, { session: sessionView(inserted[0]) });
  }

  // 同一会话的历史消息进入服务端模型上下文；没有历史时只带当前输入。
  async function conversationHistory(owner: string, sessionId: string, currentPrompt: string): Promise<Array<{ role: string; content: string }>> {
    const rows = await selectRows(messages, [["owner_id", owner], ["session_id", sessionId]], "role,content,ord");
    rows.sort((a, b) => integerOr(a.ord) - integerOr(b.ord));
    const history = rows.slice(-20).flatMap(row => {
      const role = textOf(row.role);
      if (role !== "user" && role !== "assistant") return [];
      const content = clampText(row.content, 8_000);
      return content ? [{ role, content }] : [];
    });
    return [...history, { role: "user", content: currentPrompt }];
  }

  async function createTaskRoute(owner: string, request: Request): Promise<Response> {
    const data = await readJson(request, maxTaskBody);
    onlyFields(data, ["title", "intent", "sessionId", "turnId", "images", "documents", "providerId", "reasoning", "contextLimit"]);
    const sessionId = safeId(data.sessionId, "invalid_session_id");
    const turnId = safeId(data.turnId, "invalid_turn_id");
    // title 是任务列表的短标签；完整用户输入在 intent，必须按原文发给云端。
    // 16k 个 UTF-16 单元在最坏 UTF-8 情况下仍小于云端 64KB 的 sendMessage 上限。
    const title = clampText(data.title, 500);
    const intent = typeof data.intent === "string" ? clampText(data.intent, 16_000) : null;
    const prompt = intent && intent.trim() ? intent : title;
    // Cloud Agents 已隐藏：所有新任务固定走服务端模型执行器；旧客户端传 qoder-cloud 时映射到默认模型。
    const requestedProvider = textOf(data.providerId);
    const providerId = requestedProvider === "qoder-cloud" ? "srv-moss" : requestedProvider || "srv-moss";
    const runtime = deps.exec ? "server-model" : "cloud-agents";
    if (!prompt.trim()) throw new AppError(400, "invalid_title");
    await requireSession(owner, sessionId);

    const taskId = `task_${(await sha256Text(`${owner}\n${sessionId}\n${turnId}`)).slice(0, 32)}`;
    const existing = await readTask(owner, taskId);
    if (existing) return json(200, { taskId, status: textOf(existing.status), deduped: true });

    const documents: Array<{ name: string; text: string }> = [];
    if (runtime === "server-model" && Array.isArray(data.documents)) {
      for (const raw of data.documents.slice(0, 8)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Row;
        const name = clampText(item.name, 200);
        if (!name) continue;
        const fallback = clampText(item.text, 100_000);
        const dataUrl = typeof item.dataUrl === "string" && item.dataUrl.startsWith("data:") && item.dataUrl.length <= 6_000_000
          ? item.dataUrl : "";
        let text = fallback;
        if (dataUrl) {
          try {
            const parsed = await parseDocumentText(dataUrl, name);
            if (parsed.trim()) text = clampText(parsed, 100_000);
          } catch { /* 服务端解析失败时保留附件层的文本回退。 */ }
        }
        if (text) documents.push({ name, text });
      }
    }
    const at = historyTick();
    const history = runtime === "server-model" ? await conversationHistory(owner, sessionId, prompt) : [];
    const task: Row = {
      id: taskId, owner_id: owner, session_id: sessionId, turn_id: turnId, title,
      intent, status: "queued", usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 },
      result: null, error: null, seq_counter: 0, cancel_requested: false,
      last_cloud_event_id: null, created_at: at, updated_at: at,
      provider_id: providerId || null, runtime,
      checkpoint: runtime === "server-model" ? {
        version: 1, messages: history, images: Array.isArray(data.images) ? data.images.slice(0, 4).filter(v => typeof v === "string") : [], documents,
        toolRounds: 0, usage: { inputTokens: 0, outputTokens: 0, tokens: 0, toolCalls: 0, wallMs: 0 },
        stage: "simple", attempts: 0, leaseUntil: 0, done: false,
        ...(Number.isSafeInteger(data.contextLimit) && Number(data.contextLimit) >= 8_000 && Number(data.contextLimit) <= 2_000_000 ? { contextLimit: Number(data.contextLimit) } : {}),
      } : null,
    };
    const inserted = await insertRow(tasks, task);
    if (!inserted.length) {
      const current = await readTask(owner, taskId);
      if (current) return json(200, { taskId, status: textOf(current.status), deduped: true });
      throw new AppError(409, "task_conflict");
    }

    try {
      const ord = await nextOrd(owner, sessionId);
      await insertRow(messages, {
        id: `msg_${taskId}_user`, owner_id: owner, session_id: sessionId, turn_id: turnId,
        task_id: taskId, role: "user", content: prompt, ord, created_at: at, updated_at: at,
      });
      if (runtime === "server-model") {
        await patchTask(task, { status: "running" });
        await deps.exec!.advance(taskId, owner, { reasoning: data.reasoning });
        const latest = await readTask(owner, taskId);
        return json(201, { taskId, status: textOf(latest?.status) || "running" });
      }
      const cloudSessionId = await ensureCloudSession(owner, sessionId);
      // 每条用户消息都附带权威时间，防止平台 Agent 用训练记忆猜日期。
      await cloud.sendMessage(cloudSessionId, `${beijingTimeContext()}\n\n【用户消息】\n${prompt}`);
      await patchTask(task, { status: "running" });
      return json(201, { taskId, status: "running" });
      return json(201, { taskId, status: "running" });
    } catch (error) {
      await patchTask(task, { status: "failed", error: safeCloudCode(error) }).catch(() => false);
      throw error;
    }
  }

  async function streamTask(owner: string, request: Request, task: Row): Promise<Response> {
    const session = await readSession(owner, textOf(task.session_id));
    if (!session || !textOf(session.cloud_session_id)) throw new AppError(409, "run_reconciliation_required");
    const url = new URL(request.url);
    const rawAfter = url.searchParams.get("after") ?? request.headers.get("Last-Event-ID") ?? "0";
    const after = integerOr(rawAfter, -1);
    if (after < 0) throw new AppError(400, "invalid_cursor");

    await reconcile(owner, task, session);
    const buffered = await listTaskEvents(owner, textOf(task.id), after);

    const controller = new AbortController();
    const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    const signal = anySignal ? anySignal([request.signal, controller.signal]) : controller.signal;
    const encoder = new TextEncoder();
    const sessionId = textOf(session.cloud_session_id);

    const stream = new ReadableStream<Uint8Array>({
      async start(output) {
        let upstream: Response | null = null;
        let closed = false;
        const send = (name: string, data: unknown) => {
          if (closed) return;
          output.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const finish = (status: string) => {
          if (closed) return;
          send("close", { status });
          closed = true;
          try { output.close(); } catch { /* 已关闭。 */ }
        };
        try {
          for (const event of buffered) send("task_event", event);
          send("task_status", taskView(task));
          if (terminalStatuses.has(textOf(task.status))) { finish(textOf(task.status)); return; }

          upstream = await cloud.streamEvents(sessionId, textOf(task.last_cloud_event_id) || undefined, signal);
          if (!upstream.body) throw new AppError(502, "cloud_invalid_response");
          const iterator = readCloudEvents(upstream.body);
          for (;;) {
            const { value, done } = await iterator.next();
            if (done) break;
            if (!value || value.type === "heartbeat") continue;
            const processed = await processCloudEvents(owner, task, session, [value], event => send("task_event", event));
            if (processed.emitted.length) send("task_status", taskView(task));
            if (processed.stop) { finish(textOf(task.status)); return; }
          }
          finish(textOf(task.status));
        } catch (error) {
          if (closed) return;
          if (!signal.aborted) send("stream_interrupted", { reconnect: true });
          closed = true;
          try { output.close(); } catch { /* 已关闭。 */ }
          void error;
        } finally {
          try { await upstream?.body?.cancel(); } catch { /* 订阅结束不取消云端任务。 */ }
        }
      },
      async cancel() {
        controller.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
        "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
      },
    });
  }

  async function domainRoutes(owner: string, request: Request, kind: "inbox" | "daily" | "opportunities" | "profile"): Promise<Response> {
    if (kind === "profile") {
      if (request.method === "GET") {
        const found = await selectRows(profile, [["owner_id", owner]], "*", 1);
        return json(200, { profile: found.length ? jsonObject(found[0].data) : {} });
      }
      if (request.method === "PUT") {
        const data = await readJson(request);
        const found = await selectRows(profile, [["owner_id", owner]], "*", 1);
        const at = Date.now();
        if (found.length) await updateRows(profile, { data, updated_at: at }, [["owner_id", owner]]);
        else await insertRow(profile, { owner_id: owner, data, updated_at: at }, "owner_id");
        return json(200, { profile: data });
      }
      return json(405, { error: "method_not_allowed" });
    }
    const table = domainTables[kind];
    if (request.method === "GET") {
      const found = await selectRows(table, [["owner_id", owner]]);
      const items = found.sort((a, b) => integerOr(b.updated_at) - integerOr(a.updated_at))
        .map(row => ({ ...jsonObject(row.data), id: jsonObject(row.data).id ?? textOf(row.id) }));
      return json(200, { [kind]: items });
    }
    if (request.method === "POST") {
      const data = await readJson(request);
      const id = typeof data.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(data.id)
        ? data.id : `${kind.slice(0, 3)}_${crypto.randomUUID().replace(/-/g, "")}`;
      const existing = await selectRows(table, [["id", id], ["owner_id", owner]], "*", 1);
      if (existing.length) return json(200, { [kind]: { ...jsonObject(existing[0].data), id } , deduped: true });
      const at = Date.now();
      const stored = { ...data, id };
      const inserted = await insertRow(table, { id, owner_id: owner, data: stored, created_at: at, updated_at: at });
      if (!inserted.length) throw new AppError(409, "domain_conflict");
      return json(201, { [kind]: stored });
    }
    return json(405, { error: "method_not_allowed" });
  }

  // server-model 任务：先做有界 advance，再从 events 表按 seq 续传；最多 12 步/50 秒。
  async function streamServerTask(owner: string, request: Request, initial: Row): Promise<Response> {
    const url = new URL(request.url);
    const after = integerOr(url.searchParams.get("after") ?? request.headers.get("Last-Event-ID") ?? "0", -1);
    if (after < 0) throw new AppError(400, "invalid_cursor");
    const encoder = new TextEncoder();
    const taskId = textOf(initial.id);
    const stream = new ReadableStream<Uint8Array>({
      async start(output) {
        let cursor = after;
        let closed = false;
        const send = (name: string, data: unknown) => {
          if (closed) return;
          output.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const finish = (status: string) => { if (closed) return; send("close", { status }); closed = true; try { output.close(); } catch { /* closed */ } };
        const deadline = Date.now() + 50_000;
        try {
          for (let step = 0; step < 12; step++) {
            if (request.signal.aborted || Date.now() >= deadline) break;
            // advance 进行期间持续拉取事件：llm.delta 一落库就推给浏览器，首字体感接近流式。
            let settled = false;
            const advancing = deps.exec!.advance(taskId, owner)
              .catch(() => undefined)
              .finally(() => { settled = true; });
            while (!settled && !request.signal.aborted && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 280));
              const live = await listTaskEvents(owner, taskId, cursor);
              for (const event of live) { send("task_event", event); cursor = Math.max(cursor, integerOr(event.seq)); }
            }
            await advancing;
            const current = await readTask(owner, taskId);
            if (!current) { finish("failed"); return; }
            const list = await listTaskEvents(owner, taskId, cursor);
            for (const event of list) { send("task_event", event); cursor = Math.max(cursor, integerOr(event.seq)); }
            send("task_status", taskView(current));
            if (terminalStatuses.has(textOf(current.status))) { finish(textOf(current.status)); return; }
            // advance 被租约挡住时会立即返回，避免空转。
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          const current = await readTask(owner, taskId);
          finish(current ? textOf(current.status) : "failed");
        } catch {
          finish("failed");
        }
      },
      cancel() { /* 断开仅结束订阅，任务保留在 DB，轮询可继续。 */ },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  }

  // ── 用户 BYOK ─────────────────────────────────────��─────────────────────
  function userProviderView(row: Row, hasKey: boolean) {
    const model = safeDisplay(row.model_id);
    const name = safeDisplay(row.display_name) || model;
    return {
      id: textOf(row.id), name, displayName: name, model, modelId: model,
      protocol: safeDisplay(row.protocol) || "openai",
      baseUrl: clampText(row.base_url, 500),
      capabilities: jsonObject(row.capabilities),
      managed: false, readonly: false, builtin: false, hasKey,
      ...(row.is_default === true ? { isDefault: true } : {}),
    };
  }
  async function removeProviderRoute(owner: string, id: string): Promise<Response> {
    if (!deps.vault) throw new AppError(403, "byok_not_enabled");
    const rows = await selectRows(providersTable, [["id", id], ["owner_id", owner]], "*", 1);
    if (!rows.length) throw new AppError(404, "provider_not_found");
    const at = Date.now();
    await updateRows(providersTable, { deleted_at: at, is_default: false, updated_at: at }, [["id", id], ["owner_id", owner]]);
    await deps.vault.remove(owner, id);
    return json(200, { ok: true });
  }
  async function defaultProviderRoute(owner: string, id: string): Promise<Response> {
    if (!deps.vault) throw new AppError(403, "byok_not_enabled");
    const rows = await selectRows(providersTable, [["id", id], ["owner_id", owner]], "*", 1);
    if (!rows.length || rows[0].deleted_at !== null && rows[0].deleted_at !== undefined) throw new AppError(404, "provider_not_found");
    await updateRows(providersTable, { is_default: false }, [["owner_id", owner]]);
    await updateRows(providersTable, { is_default: true, updated_at: Date.now() }, [["id", id], ["owner_id", owner]]);
    return json(200, { ok: true });
  }
  async function testProviderRoute(owner: string, id: string): Promise<Response> {
    if (!deps.vault) throw new AppError(403, "byok_not_enabled");
    const rows = await selectRows(providersTable, [["id", id], ["owner_id", owner]], "*", 1);
    if (!rows.length) throw new AppError(404, "provider_not_found");
    const row = rows[0];
    const configuredModel = textOf(row.model_id);
    let apiKey: string;
    try { apiKey = await deps.vault.get(owner, id); }
    catch { throw new AppError(400, "provider_key_missing"); }
    const baseUrl = textOf(row.base_url).replace(/\/+$/, "");
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/models`, {
        method: "GET", redirect: "error",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return json(200, { ok: false, configuredModel, actualModel: "", note: "网络不可达或超时" });
    }
    if (!response.ok) return json(200, { ok: false, configuredModel, actualModel: "", note: `上游返回 ${response.status}` });
    let actualModel = "";
    try {
      const body = await response.json() as Row;
      const list = Array.isArray(body.data) ? body.data : [];
      const found = list.find(item => item && typeof item === "object" && !Array.isArray(item) && (item as Row).id === configuredModel);
      actualModel = found ? configuredModel : textOf((list[0] as Row | undefined)?.id);
    } catch { /* 非 JSON models 响应也视为连通。 */ }
    return json(200, { ok: true, configuredModel, actualModel: actualModel || configuredModel, note: "文本连接成功" });
  }
  async function saveProviderRoute(owner: string, request: Request): Promise<Response> {
    if (!deps.vault) throw new AppError(403, "byok_not_enabled");
    const data = await readJson(request);
    onlyFields(data, ["id", "providerId", "name", "displayName", "baseUrl", "protocol", "model", "modelId", "apiKey", "contextLimit", "capabilities", "removeSecret"]);
    const id = safeId(data.providerId ?? data.id, "invalid_provider_id", 120);
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new AppError(400, "invalid_provider_id");
    const baseUrl = clampText(data.baseUrl, 500).replace(/\/+$/, "");
    if (!/^https:\/\/[^\s]+$/i.test(baseUrl)) throw new AppError(400, "invalid_base_url");
    const model = clampText(data.modelId ?? data.model, 200);
    if (!model) throw new AppError(400, "invalid_model");
    const name = clampText(data.displayName ?? data.name, 120) || model;
    const protocol = safeDisplay(data.protocol) || "openai";
    const limit = data.contextLimit === null || data.contextLimit === undefined ? null : boundedNumber(data.contextLimit, 0, 10_000_000) || null;
    const apiKey = typeof data.apiKey === "string" ? data.apiKey.trim() : "";
    if (apiKey.length > 4000) throw new AppError(400, "invalid_api_key");
    const removeSecret = data.removeSecret === true;
    if (apiKey && removeSecret) throw new AppError(400, "invalid_body");
    const owned = await selectRows(providersTable, [["owner_id", owner]]);
    const active = owned.filter(row => row.deleted_at === null || row.deleted_at === undefined);
    const existing = active.find(row => textOf(row.id) === id) ?? null;
    let capabilities = existing ? jsonObject(existing.capabilities) : {};
    if (data.capabilities && typeof data.capabilities === "object" && !Array.isArray(data.capabilities)) {
      capabilities = { ...capabilities, ...jsonObject(data.capabilities) };
    }
    let hasKey = existing ? existing.has_key === true : false;
    if (apiKey) { await deps.vault.put(owner, id, apiKey); hasKey = true; }
    if (removeSecret) { await deps.vault.remove(owner, id); hasKey = false; }
    const at = Date.now();
    const values = {
      display_name: name, base_url: baseUrl, protocol, model_id: model,
      context_limit: limit, capabilities, has_key: hasKey, deleted_at: null, updated_at: at,
    };
    if (existing) {
      await updateRows(providersTable, values, [["id", id], ["owner_id", owner]]);
    } else {
      const inserted = await insertRow(providersTable, {
        id, owner_id: owner, is_default: active.length === 0, created_at: at, ...values,
      }, "id");
      if (!inserted.length) await updateRows(providersTable, values, [["id", id], ["owner_id", owner]]);
    }
    return json(200, { ok: true, provider: userProviderView({ id, ...values }, hasKey) });
  }

  return async function handle(ctx: { request: Request }): Promise<Response> {
    const request = ctx.request;
    const url = new URL(request.url);
    const route = routeOf(url.pathname);
    if (route === null) return json(404, { error: "not_found" });

    let owner: string | null = null;
    try { owner = (await deps.ownerOf(ctx)) ?? null; }
    catch { return json(401, { error: "login_required" }); }
    if (typeof owner !== "string" || !owner.trim() || owner.length > 200) return json(401, { error: "login_required" });

    try {
      // 会话
      if (route === "/sessions") {
        if (request.method === "POST") return await createSessionRoute(owner, request);
        if (request.method === "GET") {
          // 软删除记录也返回 deletedAt，其他窗口才能据此移除本地会话列表。
          const found = await selectRows(sessions, [["owner_id", owner]]);
          const list = found.sort((a, b) => numberOr(b.updated_at) - numberOr(a.updated_at)).slice(0, 500);
          return json(200, { sessions: list.map(sessionView) });
        }
        return json(405, { error: "method_not_allowed" });
      }
      const sessionMatch = /^\/sessions\/([A-Za-z0-9_.:-]{1,200})(?:\/(tasks|import|history\/page|history\/changes|history))?$/.exec(route);
      if (sessionMatch) {
        const id = sessionMatch[1];
        const operation = sessionMatch[2];
        const session = await requireSession(owner, id);
        if (!operation) {
          if (request.method === "GET") return json(200, { session: sessionView(session) });
          if (request.method === "PATCH") {
            const data = await readJson(request);
            onlyFields(data, ["title", "mode", "archived", "expectedRevision"]);
            const expected = data.expectedRevision;
            if (!Number.isSafeInteger(expected) || Number(expected) < 0) throw new AppError(400, "invalid_revision");
            const patch: Row = {};
            if (data.title !== undefined) {
              const title = clampText(data.title, 200);
              if (!title.trim()) throw new AppError(400, "invalid_title");
              patch.title = title;
            }
            if (data.mode !== undefined) patch.mode = data.mode === "daily" ? "daily" : "auto";
            if (data.archived !== undefined) patch.archived = data.archived === true;
            patch.revision = Number(expected) + 1;
            patch.updated_at = Date.now();
            const changed = await updateRows(sessions, patch, [["id", id], ["owner_id", owner], ["revision", Number(expected)]]);
            if (changed.length !== 1) throw new AppError(409, "revision_conflict");
            return json(200, { session: sessionView(changed[0]) });
          }
          if (request.method === "DELETE") {
            const data = await readJson(request);
            onlyFields(data, ["expectedRevision"]);
            const expected = data.expectedRevision;
            if (!Number.isSafeInteger(expected) || Number(expected) < 0) throw new AppError(400, "invalid_revision");
            const changed = await updateRows(sessions, {
              deleted_at: Date.now(), revision: Number(expected) + 1, updated_at: Date.now(),
            }, [["id", id], ["owner_id", owner], ["revision", Number(expected)]]);
            if (changed.length !== 1) throw new AppError(409, "revision_conflict");
            return json(200, { session: sessionView(changed[0]) });
          }
          return json(405, { error: "method_not_allowed" });
        }
        if (operation === "tasks" && request.method === "GET") {
          const found = await selectRows(tasks, [["owner_id", owner], ["session_id", id]]);
          return json(200, { tasks: found.sort((a, b) => numberOr(a.created_at) - numberOr(b.created_at)).map(taskView) });
        }
        if (operation === "history" && request.method === "GET") {
          const [taskRows, messageRows] = await Promise.all([
            selectRows(tasks, [["owner_id", owner], ["session_id", id]]),
            selectRows(messages, [["owner_id", owner], ["session_id", id]]),
          ]);
          return json(200, {
            session: sessionView(session),
            messages: messageRows.sort((a, b) => integerOr(a.ord) - integerOr(b.ord)).map(messageView),
            tasks: taskRows.sort((a, b) => numberOr(a.created_at) - numberOr(b.created_at)).map(taskView),
          });
        }
        if (operation === "history/page" && request.method === "GET") {
          const limitParam = url.searchParams.get("limit");
          const limit = Math.min(Math.max(limitParam === null ? 30 : integerOr(limitParam, 30), 1), 100);
          const before = decodeOrder(url.searchParams.get("before"));
          const all = await buildHistory(owner, id);
          const filtered = before ? all.filter(item => compareOrder(item.order, before) < 0) : all;
          const items = filtered.slice(-limit);
          const hasMore = filtered.length > items.length;
          const older = items.length ? encodeOrder(items[0].order) : url.searchParams.get("before") ?? undefined;
          // after 是下一次历史增量的更新时间水位，不是最后一条的创建顺序。
          const watch = all.reduce((max, item) => Math.max(max, integerOr(item.version)), 0);
          const totalTokens = all.reduce((sum, item) => sum + integerOr(item.task?.usage.tokens), 0);
          return json(200, historyPage(session, items, encodeOrder([watch, 0, 0, ""]), older, hasMore, totalTokens));
        }
        if (operation === "history/changes" && request.method === "GET") {
          const limitParam = url.searchParams.get("limit");
          const limit = Math.min(Math.max(limitParam === null ? 30 : integerOr(limitParam, 30), 1), 100);
          const all = await buildHistory(owner, id);
          const totalTokens = all.reduce((sum, item) => sum + integerOr(item.task?.usage.tokens), 0);
          const rawAfter = url.searchParams.get("after");
          // 水位取更新时间而不是创建时间：已加载轮次的后续任务/消息更新也要返回。
          const watermark = decodeOrder(rawAfter)?.[0] ?? 0;
          const next = decodeOrder(url.searchParams.get("next"));
          const changed = all
            .map(item => ({ item, at: integerOr(item.version) }))
            .filter(({ item, at }) => next ? compareOrder([at, 0, 0, item.key], next) > 0 : at > watermark)
            .sort((a, b) => a.at - b.at || a.item.key.localeCompare(b.item.key));
          const items = changed.slice(0, limit).map(entry => entry.item);
          const hasMore = changed.length > items.length;
          const last = items.length ? changed[items.length - 1] : undefined;
          const nextValue = hasMore && last ? encodeOrder([last.at, 0, 0, last.item.key]) : undefined;
          const consumed = last ? last.at : next?.[0] ?? watermark;
          const after = hasMore
            ? rawAfter ?? encodeOrder([watermark, 0, 0, ""])
            : encodeOrder([Math.max(watermark, consumed), 0, 0, ""]);
          // 空增量页省略总量，便于前端识别无变化并跳过重渲染。
          return json(200, historyPage(session, items, after, undefined, hasMore, totalTokens, nextValue, items.length > 0));
        }
        if (operation === "import" && request.method === "POST") {
          const data = await readJson(request, 1024 * 1024);
          onlyFields(data, ["messages"]);
          if (!Array.isArray(data.messages) || data.messages.length > maxImportMessages) throw new AppError(400, "invalid_messages");
          let ord = await nextOrd(owner, id);
          let imported = 0;
          for (const [index, raw] of data.messages.entries()) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError(400, "invalid_messages");
            const message = raw as Row;
            const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "";
            if (!role || typeof message.content !== "string") throw new AppError(400, "invalid_messages");
            const content = clampText(message.content, 100_000);
            const turnId = typeof message.turnId === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(message.turnId)
              ? message.turnId : `${id}:import:${index}`;
            const messageId = `imp_${(await sha256Text(`${id}\n${turnId}\n${role}\n${content}\n${index}`)).slice(0, 32)}`;
            const at = historyTick();
            const inserted = await insertRow(messages, {
              id: messageId, owner_id: owner, session_id: id, turn_id: turnId,
              task_id: null, role, content, ord: ord++, created_at: at, updated_at: at,
            });
            if (inserted.length) imported++;
          }
          return json(200, { ok: true, imported });
        }
        return json(405, { error: "method_not_allowed" });
      }

      // 任务
      if (route === "/tasks") {
        if (request.method === "POST") return await createTaskRoute(owner, request);
        return json(405, { error: "method_not_allowed" });
      }
      const taskMatch = /^\/tasks\/([A-Za-z0-9_.:-]{1,200})(?:\/(events|stream|cancel|resume))?$/.exec(route);
      if (taskMatch) {
        const id = taskMatch[1];
        const operation = taskMatch[2];
        const task = await requireTask(owner, id);
        if (!operation && request.method === "GET") {
          if (textOf(task.runtime) === "server-model" && deps.exec && !terminalStatuses.has(textOf(task.status))) {
            await deps.exec.advance(textOf(task.id), owner).catch(() => undefined);
            const latest = await readTask(owner, textOf(task.id));
            if (latest) return json(200, { task: taskView(latest) });
          }
          return json(200, { task: taskView(task) });
        }
        if (operation === "events" && request.method === "GET") {
          if (textOf(task.runtime) === "server-model" && deps.exec) {
            await deps.exec.advance(textOf(task.id), owner).catch(() => undefined);
          } else {
            const session = await readSession(owner, textOf(task.session_id));
            await reconcile(owner, task, session);
          }
          const { events: list } = await readTaskEventsAfter(owner, request, task);
          return json(200, { events: list, task: taskView(task) });
        }
        if (operation === "stream" && request.method === "GET") {
          if (textOf(task.runtime) === "server-model" && deps.exec) return await streamServerTask(owner, request, task);
          return await streamTask(owner, request, task);
        }
        if (operation === "cancel" && request.method === "POST") {
          if (!terminalStatuses.has(textOf(task.status))) {
            await patchTask(task, { status: "cancelled", cancel_requested: true }, textOf(task.status));
          }
          const session = await readSession(owner, textOf(task.session_id));
          if (textOf(task.runtime) !== "server-model" && session && textOf(session.cloud_session_id)) await cloud.cancelSession(textOf(session.cloud_session_id));
          const latest = await readTask(owner, id);
          return json(202, { ok: true, task: taskView(latest ?? task) });
        }
        if (operation === "resume" && request.method === "POST") {
          // 与事件处理共用同一任务锁；审批通过后前端还会调用 resume，running 时直接幂等返回。
          return await withTaskLock(textOf(id), async () => {
            const current = await requireTask(owner, id);
            if (textOf(current.status) === "running") return json(200, { task: taskView(current), deduped: true });
            if (!["paused", "needs_input", "failed"].includes(textOf(current.status))) throw new AppError(409, "task_not_resumable");
            const session = await readSession(owner, textOf(current.session_id));
            if (!session || !textOf(session.cloud_session_id)) throw new AppError(409, "run_reconciliation_required");
            if (textOf(current.runtime) === "server-model" && deps.exec) {
              await deps.exec.advance(id, owner).catch(() => undefined);
              const latest = await readTask(owner, id);
              return json(200, { task: taskView(latest ?? current) });
            }
            await cloud.sendMessage(textOf(session.cloud_session_id), `${beijingTimeContext()}\n\n继续`);
            await patchTask(current, { status: "running", error: null, cancel_requested: false });
            return json(200, { task: taskView(current) });
          });
        }
        return json(405, { error: "method_not_allowed" });
      }

      // 审批
      if (route === "/approvals" && request.method === "GET") {
        const found = await selectRows(approvals, [["owner_id", owner]]);
        // 执行面板只展示待处理审批，已决记录不再重复出现。
        const pending = found.filter(row => textOf(row.status) === "pending");
        return json(200, { approvals: pending.sort((a, b) => numberOr(b.created_at) - numberOr(a.created_at)).map(approvalView) });
      }
      const approvalMatch = /^\/approvals\/([A-Za-z0-9_.:-]{1,200})$/.exec(route);
      if (approvalMatch && request.method === "POST") {
        const data = await readJson(request);
        onlyFields(data, ["decision"]);
        return await decideApproval(owner, approvalMatch[1], textOf(data.decision));
      }

      // 产物
      const artifactMatch = /^\/artifacts\/([A-Za-z0-9_.:-]{1,200})(\/download)?$/.exec(route);
      if (artifactMatch && request.method === "GET") {
        const found = await selectRows(artifacts, [["id", artifactMatch[1]], ["owner_id", owner]], "*", 1);
        if (!found.length) return json(404, { error: "artifact_not_found" });
        const artifact = found[0];
        const inline = await loadArtifactInline(owner, artifact);
        if (artifactMatch[2]) {
          const format = (url.searchParams.get("format") ?? "md") as Parameters<typeof exportArtifact>[1];
          const allowed = availableFormats(artifactSource(artifact));
          if (!allowed.includes(format)) return json(400, { error: "unsupported_format" });
          if (format === "md") {
            const filename = safeFilename(artifact.filename).replace(/\.(md|markdown)$/i, "") + ".md";
            return new Response(new TextEncoder().encode(inline.text), {
              status: 200,
              headers: {
                "Content-Type": "text/markdown; charset=utf-8",
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
                "X-File-Sha256": inline.sha256,
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
              },
            });
          }
          const exported = exportArtifact(artifactSource(artifact), format);
          const digest = await sha256Bytes(exported.bytes);
          return new Response(exported.bytes.slice().buffer as ArrayBuffer, {
            status: 200,
            headers: {
              "Content-Type": exported.contentType,
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
              "X-File-Sha256": digest,
              "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            },
          });
        }
        return json(200, { artifact: artifactView(artifact, inline), availableFormats: availableFormats(artifactSource(artifact)) });
      }

      // 托管 Provider（只读）+ 用户 BYOK（可写）
      if (route === "/providers") {
        if (request.method === "GET") {
          const managed = (config.providers ?? []).filter(provider =>
            Boolean(provider) && typeof provider === "object" && !Array.isArray(provider));
          const owned = deps.vault
            ? (await selectRows(providersTable, [["owner_id", owner]])).filter(row =>
              row.deleted_at === null || row.deleted_at === undefined)
            : [];
          return json(200, {
            providers: [
              ...managed.map(provider => publicProvider(provider)),
              ...owned.map(row => userProviderView(row, row.has_key === true)),
            ],
            mutable: Boolean(deps.vault),
          });
        }
        if (request.method === "POST") return await saveProviderRoute(owner, request);
        return json(405, { error: "method_not_allowed" });
      }
      const providerMatch = /^\/providers\/([A-Za-z0-9_.:-]{1,120})(?:\/(default|test))?$/.exec(route);
      if (providerMatch) {
        const providerId = providerMatch[1];
        if (!providerMatch[2] && request.method === "DELETE") return await removeProviderRoute(owner, providerId);
        if (providerMatch[2] === "default" && request.method === "POST") return await defaultProviderRoute(owner, providerId);
        if (providerMatch[2] === "test" && request.method === "POST") return await testProviderRoute(owner, providerId);
        return json(405, { error: "method_not_allowed" });
      }
      if (route === "/capabilities" && request.method === "GET") {
        return json(200, { capabilities: { sessions: true, tasks: true, approvals: true, artifacts: true, domain: true, streaming: true, ...(config.capabilities ?? {}) } });
      }

      // Agent 设置
      if (route === "/settings/agent") {
        if (request.method === "GET") {
          const found = await selectRows(settings, [["owner_id", owner]], "*", 1);
          return json(200, found.length
            ? { settings: jsonObject(found[0].data), revision: integerOr(found[0].revision), updatedAt: numberOr(found[0].updated_at) }
            : { settings: {}, revision: 0, updatedAt: 0 });
        }
        if (request.method === "PATCH") {
          const data = await readJson(request);
          const expected = data.expectedRevision;
          delete data.expectedRevision;
          if (expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 0)) throw new AppError(400, "invalid_revision");
          const found = await selectRows(settings, [["owner_id", owner]], "*", 1);
          const at = Date.now();
          if (!found.length) {
            if (expected !== undefined && Number(expected) !== 0) throw new AppError(409, "revision_conflict");
            const inserted = await insertRow(settings, { owner_id: owner, data, revision: 0, updated_at: at }, "owner_id");
            if (!inserted.length) throw new AppError(409, "revision_conflict");
            return json(200, { settings: data, revision: 0, updatedAt: at });
          }
          const current = found[0];
          const revision = integerOr(current.revision);
          if (expected !== undefined && Number(expected) !== revision) throw new AppError(409, "revision_conflict");
          const merged = { ...jsonObject(current.data), ...data };
          const changed = await updateRows(settings, { data: merged, revision: revision + 1, updated_at: at }, [
            ["owner_id", owner], ["revision", revision],
          ]);
          if (changed.length !== 1) throw new AppError(409, "revision_conflict");
          return json(200, { settings: merged, revision: revision + 1, updatedAt: at });
        }
        return json(405, { error: "method_not_allowed" });
      }

      // 领域数据
      const domain = /^\/domain\/(inbox|daily|opportunities|profile)$/.exec(route);
      if (domain) return await domainRoutes(owner, request, domain[1] as "inbox" | "daily" | "opportunities" | "profile");

      return json(404, { error: "not_found" });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function safeCloudCode(error: unknown): string {
  if (!(error instanceof CloudAgentError)) return "sites_dependency_unavailable";
  if (error.message === "cloud_token_missing_or_invalid") return "ai_not_configured";
  if (error.status === 429) return "cloud_rate_limited";
  if (error.status === 409) return "cloud_busy";
  if (error.status === 504) return "cloud_timeout";
  if (error.status === 400) return "cloud_invalid_input";
  return "cloud_unavailable";
}
function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return json(error.status, { error: error.message });
  if (error instanceof CloudAgentError) {
    if (error.message === "cloud_token_missing_or_invalid") return json(503, { error: "ai_not_configured" });
    // Cloud Agents 初始化/模型配置错误：透出安全错误码，便于定位而不是一律 cloud_unavailable。
    if (error.message.startsWith("ai_") || error.message.startsWith("sites_")) return json(error.status || 503, { error: error.message });
    const status = error.status === 429 ? 429 : error.status === 409 ? 409 : error.status === 504 ? 504 : 502;
    const code = status === 429 ? "cloud_rate_limited" : status === 409 ? "cloud_busy" : status === 504 ? "cloud_timeout" : "cloud_unavailable";
    return json(status, { error: code }, error.retryAfter === undefined ? {} : { "Retry-After": String(error.retryAfter) });
  }
  // 不泄露异常原文（可能包含数据库或上游细节）。
  return json(503, { error: "sites_dependency_unavailable" });
}
