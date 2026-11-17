// 数据集管理：加载 / 校验 / 归一化 / 哈希 / 保存。
// 事实边界：数据集是「评测输入」，不是执行期验收；执行期验收仍由 core/evaluator 负责。
// 设计取舍：checks 可序列化且确定性优先；expected 是编写糖，加载时展开成 checks。
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EvalCase, EvalCategory, EvalCheck, EvalDifficulty, EvalSource, EvalSuite, EvalTurn, ExpectedBehavior,
  TargetKind, ToolCallExpectation,
} from "./types.ts";
import type { TaskStatus } from "../core/types.ts";

export const EVAL_DIRS = {
  datasets: fileURLToPath(new URL("../../evaluation/datasets/", import.meta.url)),
  holdout: fileURLToPath(new URL("../../evaluation/holdout/", import.meta.url)),
  replay: fileURLToPath(new URL("../../evaluation/replay/", import.meta.url)),
} as const;

// 运行产物默认写在仓库 .local/eval（gitignored），不混入源码目录。
export const DEFAULT_RUNS_ROOT = fileURLToPath(new URL("../../../.local/eval/", import.meta.url));

// 套件 id 约定小写；用例 id 允许大写（如 BASE-001 / LIVE-003），便于人工与报告阅读。
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/;
const DIFFICULTIES = new Set<EvalDifficulty>(["easy", "medium", "hard"]);
const SOURCES = new Set<EvalSource>(["fixed", "generated", "failure_replay"]);
const TIERS = new Set<TargetKind>(["scripted", "api-memory", "live"]);
const TASK_STATUSES = new Set<TaskStatus>(["queued", "running", "needs_input", "paused", "succeeded", "failed", "cancelled"]);

type RawCase = Omit<Partial<EvalCase>, "checks" | "expected" | "category" | "difficulty" | "source" | "id" | "prompt" | "turns"> & {
  id?: unknown; category?: unknown; difficulty?: unknown; source?: unknown; prompt?: unknown;
  checks?: unknown; expected?: ExpectedBehavior; turns?: unknown;
};

type RawSuite = {
  schemaVersion?: unknown; id?: unknown; name?: unknown; description?: unknown; holdout?: unknown;
  source?: unknown; cases?: unknown;
};

export interface SuiteMeta {
  id: string;
  name: string;
  path: string;
  holdout: boolean;
  caseCount: number;
}

export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = sort((v as Record<string, unknown>)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── 加载 ────────────────────────────────────────────────────────────────────
export function listSuiteFiles(): Array<{ path: string; holdout: boolean }> {
  const out: Array<{ path: string; holdout: boolean }> = [];
  for (const [dir, holdout] of [[EVAL_DIRS.datasets, false], [EVAL_DIRS.holdout, true], [EVAL_DIRS.replay, false]] as const) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { /* 目录可缺省 */ }
    for (const file of files.sort()) out.push({ path: path.join(dir, file), holdout });
  }
  return out;
}

export function listSuites(): SuiteMeta[] {
  const out: SuiteMeta[] = [];
  for (const { path: file, holdout } of listSuiteFiles()) {
    try {
      const suite = parseSuite(JSON.parse(fs.readFileSync(file, "utf8")), file);
      out.push({ id: suite.id, name: suite.name, path: file, holdout: holdout || Boolean(suite.holdout), caseCount: suite.cases.length });
    } catch { /* 损坏数据集由 validate 单独报告，不阻断套件列表 */ }
  }
  return out;
}

export function loadSuite(ref: string): EvalSuite {
  const resolved = resolveSuitePath(ref);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  return parseSuite(raw, resolved);
}

export function resolveSuitePath(ref: string): string {
  const direct = path.resolve(process.cwd(), ref);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const candidates = listSuiteFiles();
  const byFile = candidates.find((c) => path.basename(c.path) === `${ref}.json`);
  if (byFile) return byFile.path;
  const byId: string[] = [];
  for (const c of candidates) {
    try {
      const suite = JSON.parse(fs.readFileSync(c.path, "utf8")) as RawSuite;
      if (suite.id === ref) byId.push(c.path);
    } catch { /* skip */ }
  }
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) throw new Error(`套件 id 重复：${ref}（${byId.join(", ")}）`);
  throw new Error(`找不到评测套件：${ref}。可用 --suite all / all-holdout / 具体 id / .json 路径`);
}

// 解析 refs：all = 全部非 holdout；all-holdout = 全部 holdout；all-any = 两者。
export function loadSuites(refs: string[]): EvalSuite[] {
  const metas = listSuites();
  const picked: SuiteMeta[] = [];
  const push = (meta: SuiteMeta) => { if (!picked.some((p) => p.id === meta.id && p.path === meta.path)) picked.push(meta); };
  for (const ref of refs) {
    if (ref === "all") { for (const m of metas) if (!m.holdout) push(m); continue; }
    if (ref === "all-holdout") { for (const m of metas) if (m.holdout) push(m); continue; }
    if (ref === "all-any") { for (const m of metas) push(m); continue; }
    const resolved = resolveSuitePath(ref);
    const meta = metas.find((m) => m.path === resolved);
    if (meta) push(meta);
    else { const suite = loadSuite(resolved); picked.push({ id: suite.id, name: suite.name, path: resolved, holdout: Boolean(suite.holdout), caseCount: suite.cases.length }); }
  }
  if (!picked.length) throw new Error(`没有匹配到任何评测套件（refs=${refs.join(",")}）`);
  const seen = new Map<string, string>();
  for (const meta of picked) {
    const other = seen.get(meta.id);
    if (other && other !== meta.path) throw new Error(`套件 id 冲突：${meta.id}（${other} / ${meta.path}）`);
    seen.set(meta.id, meta.path);
  }
  return picked.map((m) => loadSuite(m.path));
}

// ── 校验 + 归一化 ───────────────────────────────────────────────────────────
export function parseSuite(raw: unknown, sourcePath = "<inline>"): EvalSuite {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${sourcePath}: 顶层必须是对象`);
  const input = raw as RawSuite;
  if (input.schemaVersion !== 1) errors.push(`${sourcePath}: schemaVersion 必须为 1`);
  const id = typeof input.id === "string" ? input.id : "";
  if (!ID_RE.test(id)) errors.push(`${sourcePath}: 套件 id 无效（需小写字母数字/下划线/连字符）`);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
  if (!Array.isArray(input.cases) || input.cases.length === 0) errors.push(`${sourcePath}: cases 必须为非空数组`);
  const holdout = input.holdout === true;
  const cases: EvalCase[] = [];
  const caseIds = new Set<string>();
  const promptSeen = new Set<string>();
  if (Array.isArray(input.cases)) {
    input.cases.forEach((rawCase, index) => {
      const prefix = `cases[${index}]`;
      const normalized = normalizeCase(rawCase, index, prefix, holdout, errors);
      if (!normalized) return;
      if (caseIds.has(normalized.id)) errors.push(`${prefix}.id 重复：${normalized.id}`);
      caseIds.add(normalized.id);
      if (normalized.script?.length && !normalized.turns?.length) {
        const key = normalized.prompt.trim();
        if (promptSeen.has(key)) errors.push(`${prefix}.prompt 与同套件其他脚本化用例重复，脚本路由会串用例`);
        promptSeen.add(key);
      }
      cases.push(normalized);
    });
  }
  if (errors.length) {
    const error = new Error(`数据集校验失败（${sourcePath}）：\n- ${errors.join("\n- ")}`);
    error.name = "EvalDatasetValidationError";
    throw error;
  }
  return {
    schemaVersion: 1, id, name,
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    ...(holdout ? { holdout: true } : {}),
    ...(typeof input.source === "string" ? { source: input.source } : {}),
    cases,
  };
}

function normalizeCase(raw: unknown, index: number, prefix: string, suiteHoldout: boolean, errors: string[]): EvalCase | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${prefix} 必须是对象`); return null; }
  const c = raw as RawCase;
  const id = typeof c.id === "string" ? c.id : "";
  if (!ID_RE.test(id)) errors.push(`${prefix}.id 无效：${String(c.id)}`);
  const category = typeof c.category === "string" && c.category.trim() ? c.category.trim() : "";
  if (!category) errors.push(`${prefix}.category 必填`);
  const difficulty = (typeof c.difficulty === "string" ? c.difficulty : "medium") as EvalDifficulty;
  if (!DIFFICULTIES.has(difficulty)) errors.push(`${prefix}.difficulty 必须为 easy|medium|hard`);
  const source = (typeof c.source === "string" ? c.source : "fixed") as EvalSource;
  if (!SOURCES.has(source)) errors.push(`${prefix}.source 必须为 fixed|generated|failure_replay`);
  const turns = normalizeTurns(c.turns, `${prefix}.turns`, errors);
  const rawPrompt = typeof c.prompt === "string" ? c.prompt : "";
  const prompt = rawPrompt.trim() ? rawPrompt : turns[0]?.prompt ?? "";
  if (!prompt.trim()) errors.push(`${prefix}.prompt 必填（多轮用例可省略，由首轮补全）`);
  if (c.images !== undefined && (!Array.isArray(c.images) || c.images.some((x) => typeof x !== "string"))) errors.push(`${prefix}.images 必须为字符串数组`);
  const tiers = Array.isArray(c.tiers) ? c.tiers.filter((t): t is Exclude<TargetKind, "legacy"> => typeof t === "string" && TIERS.has(t as TargetKind)) : undefined;
  if (Array.isArray(c.tiers) && (!tiers || tiers.length !== c.tiers.length)) errors.push(`${prefix}.tiers 含未知通道`);
  const script = normalizeScript(c.script, `${prefix}.script`, errors);
  if (turns.length && script.length) errors.push(`${prefix} 多轮用例请使用 turns[].script，不要同时设置 case.script`);
  const checks = normalizeChecks(c.checks, c.expected, `${prefix}.checks`, errors);
  const exploratory = c.exploratory === true;
  const hasTurnChecks = turns.some((turn) => (turn.checks?.length ?? 0) > 0 || turn.expectedStatus !== undefined);
  if (!checks.length && !hasTurnChecks && !exploratory) errors.push(`${prefix} 至少需要一条 checks 或 turns[].checks（或显式 exploratory:true）`);
  const budget = c.budget && typeof c.budget === "object" && !Array.isArray(c.budget) ? c.budget : undefined;
  return {
    id, category, difficulty, source,
    ...(c.holdout === true || suiteHoldout ? { holdout: true } : {}),
    ...(exploratory ? { exploratory: true } : {}),
    ...(tiers && tiers.length ? { tiers } : {}),
    prompt,
    ...(c.images ? { images: c.images as string[] } : {}),
    ...(c.context && typeof c.context === "object" ? { context: c.context } : {}),
    ...(turns.length ? { turns } : {}),
    ...(script.length ? { script } : {}),
    ...(Array.isArray(c.toolNames) ? { toolNames: c.toolNames.filter((x): x is string => typeof x === "string") } : {}),
    ...(c.toolStubs && typeof c.toolStubs === "object" ? { toolStubs: c.toolStubs } : {}),
    ...(budget ? { budget } : {}),
    ...(c.simulate && typeof c.simulate === "object" && typeof (c.simulate as { transportError?: unknown }).transportError === "string"
      ? { simulate: { transportError: (c.simulate as { transportError: string }).transportError } } : {}),
    ...(Array.isArray(c.acceptance) ? { acceptance: c.acceptance } : {}),
    ...(Array.isArray(c.acceptanceNotes) ? { acceptanceNotes: c.acceptanceNotes.filter((x): x is string => typeof x === "string") } : {}),
    ...(c.judge && typeof c.judge === "object" ? { judge: c.judge } : {}),
    checks,
    ...(Array.isArray(c.tags) ? { tags: c.tags.filter((x): x is string => typeof x === "string") } : {}),
  };
}

function normalizeTurns(raw: unknown, prefix: string, errors: string[]): EvalTurn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0) { errors.push(`${prefix} 必须为非空数组`); return []; }
  const turns: EvalTurn[] = [];
  raw.forEach((item, index) => {
    const at = `${prefix}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) { errors.push(`${at} 必须为对象`); return; }
    const turn = item as { prompt?: unknown; sessionKey?: unknown; images?: unknown; script?: unknown; checks?: unknown; expected?: ExpectedBehavior; expectedStatus?: unknown };
    const prompt = typeof turn.prompt === "string" ? turn.prompt : "";
    if (!prompt.trim()) { errors.push(`${at}.prompt 必填`); return; }
    if (turn.sessionKey !== undefined && (typeof turn.sessionKey !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(turn.sessionKey))) errors.push(`${at}.sessionKey 须为1到80位字母数字/下划线/连字符`);
    if (turn.images !== undefined && (!Array.isArray(turn.images) || turn.images.some((x) => typeof x !== "string"))) errors.push(`${at}.images 必须为字符串数组`);
    const script = normalizeScript(turn.script, `${at}.script`, errors);
    const checks = normalizeChecks(turn.checks, turn.expected, `${at}.checks`, errors);
    let expectedStatus: TaskStatus | TaskStatus[] | undefined;
    if (turn.expectedStatus !== undefined) {
      const list = Array.isArray(turn.expectedStatus) ? turn.expectedStatus : [turn.expectedStatus];
      if (list.length && list.every((value) => typeof value === "string" && TASK_STATUSES.has(value as TaskStatus))) expectedStatus = list as TaskStatus[];
      else errors.push(`${at}.expectedStatus 含未知任务状态`);
    }
    turns.push({
      prompt,
      ...(typeof turn.sessionKey === "string" ? { sessionKey: turn.sessionKey } : {}),
      ...(Array.isArray(turn.images) ? { images: turn.images as string[] } : {}),
      ...(script.length ? { script } : {}),
      ...(checks.length ? { checks } : {}),
      ...(expectedStatus !== undefined ? { expectedStatus } : {}),
    });
  });
  return turns;
}

function normalizeScript(raw: unknown, prefix: string, errors: string[]): NonNullable<EvalCase["script"]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push(`${prefix} 必须为数组`); return []; }
  const out: NonNullable<EvalCase["script"]> = [];
  raw.forEach((step, i) => {
    if (!step || typeof step !== "object") { errors.push(`${prefix}[${i}] 必须为对象`); return; }
    const s = step as { content?: unknown; toolCalls?: unknown; usage?: unknown; model?: unknown };
    const toolCalls = Array.isArray(s.toolCalls) ? s.toolCalls.map((call: unknown, j: number) => {
      if (!call || typeof call !== "object") { errors.push(`${prefix}[${i}].toolCalls[${j}] 必须为对象`); return null; }
      const wrap = call as { name?: unknown; arguments?: unknown; args?: unknown };
      const name = typeof wrap.name === "string" ? wrap.name : "";
      if (!name) { errors.push(`${prefix}[${i}].toolCalls[${j}].name 必填`); return null; }
      const args = wrap.arguments ?? wrap.args;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) { errors.push(`${prefix}[${i}].toolCalls[${j}].arguments 必须为对象`); return null; }
      return { name, ...(args ? { arguments: args as Record<string, unknown> } : {}) };
    }).filter((x): x is { name: string; arguments?: Record<string, unknown> } => Boolean(x)) : [];
    const hasContent = typeof s.content === "string";
    if (!hasContent && !toolCalls.length) { errors.push(`${prefix}[${i}] 需要 content 或 toolCalls`); return; }
    out.push({
      ...(hasContent ? { content: s.content as string } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(s.usage && typeof s.usage === "object" ? { usage: s.usage as { input: number; output: number } } : {}),
      ...(typeof s.model === "string" ? { model: s.model } : {}),
    });
  });
  return out;
}

function normalizeChecks(raw: unknown, expected: ExpectedBehavior | undefined, prefix: string, errors: string[]): EvalCheck[] {
  const out: EvalCheck[] = [];
  if (raw !== undefined) {
    if (!Array.isArray(raw)) { errors.push(`${prefix} 必须为数组`); return []; }
    raw.forEach((item, i) => {
      const check = normalizeCheck(item, `${prefix}[${i}]`, errors);
      if (check) out.push(check);
    });
  }
  if (expected && typeof expected === "object") out.push(...expandExpected(expected, prefix));
  return out.map((c, i) => ({ ...c, id: c.id ?? `${c.kind}-${i + 1}` }));
}

function normalizeCheck(raw: unknown, prefix: string, errors: string[]): EvalCheck | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`${prefix} 必须为对象`); return null; }
  const c = raw as Record<string, unknown>;
  const kind = typeof c.kind === "string" ? c.kind : "";
  const required = c.required === undefined ? undefined : c.required === true;
  const base = { ...(typeof c.id === "string" ? { id: c.id } : {}), ...(required !== undefined ? { required } : {}), ...(typeof c.label === "string" ? { label: c.label } : {}) };
  const strArr = (v: unknown): string[] | null => Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : null;
  switch (kind) {
    case "artifact_export": {
      if (!["md", "docx", "pdf"].includes(String(c.format))) { errors.push(`${prefix}.format 必须为md/docx/pdf`); return null; }
      const contains = c.contains === undefined ? undefined : strArr(c.contains);
      if (c.contains !== undefined && !contains) { errors.push(`${prefix}.contains 必须为字符串数组`); return null; }
      for (const key of ["minBytes", "minHeadings", "minBodyChars"]) if (c[key] !== undefined && (typeof c[key] !== "number" || !Number.isInteger(c[key]) || Number(c[key]) < 0)) errors.push(`${prefix}.${key} 须为非负整数`);
      return { ...base, kind, format: c.format as "md" | "docx" | "pdf", ...numOpt(c, "minBytes"), ...numOpt(c, "minHeadings"), ...numOpt(c, "minBodyChars"), ...(contains ? { contains } : {}) };
    }
    case "status": {
      const list = strArr(c.in);
      if (!list || !list.length) { errors.push(`${prefix}.in 必须为非空数组`); return null; }
      return { ...base, kind, in: list as never };
    }
    case "certificate": return { ...base, kind, passed: c.passed === true };
    case "tool_called": {
      if (typeof c.name !== "string" || !c.name) { errors.push(`${prefix}.name 必填`); return null; }
      return { ...base, kind, name: c.name, ...(typeof c.min === "number" ? { min: c.min } : {}), ...(c.args && typeof c.args === "object" ? { args: c.args as Record<string, unknown> } : {}), ...(c.argsContains && typeof c.argsContains === "object" ? { argsContains: c.argsContains as Record<string, string> } : {}) };
    }
    case "tool_not_called": if (typeof c.name !== "string" || !c.name) { errors.push(`${prefix}.name 必填`); return null; } return { ...base, kind, name: c.name };
    case "tool_order": { const names = strArr(c.names); if (!names || !names.length) { errors.push(`${prefix}.names 必须为非空数组`); return null; } return { ...base, kind, names }; }
    case "reply_includes": {
      const all = c.all === undefined ? undefined : strArr(c.all); const any = c.any === undefined ? undefined : strArr(c.any);
      if ((c.all !== undefined && !all) || (c.any !== undefined && !any)) { errors.push(`${prefix}.all/any 必须为字符串数组`); return null; }
      if (!all?.length && !any?.length) { errors.push(`${prefix} 需要 all 或 any`); return null; }
      return { ...base, kind, ...(all ? { all } : {}), ...(any ? { any } : {}) };
    }
    case "reply_excludes": { const any = strArr(c.any); if (!any?.length) { errors.push(`${prefix}.any 必须为非空字符串数组`); return null; } return { ...base, kind, any }; }
    case "reply_regex": if (typeof c.pattern !== "string" || !c.pattern) { errors.push(`${prefix}.pattern 必填`); return null; } try { new RegExp(c.pattern, typeof c.flags === "string" ? c.flags : "i"); } catch { errors.push(`${prefix}.pattern 不是合法正则`); return null; } return { ...base, kind, pattern: c.pattern, ...(typeof c.flags === "string" ? { flags: c.flags } : {}) };
    case "inbox_saved": case "opportunity_saved": return { ...base, kind, ...numOpt(c, "min"), ...numOpt(c, "max"), ...(typeof c.titleIncludes === "string" ? { titleIncludes: c.titleIncludes } : {}), ...(kind === "inbox_saved" && typeof c.deadlineStartsWith === "string" ? { deadlineStartsWith: c.deadlineStartsWith } : {}) };
    case "pending_approval": case "evidence_verified": case "web_source_cited": return { ...base, kind, ...numOpt(c, "min") };
    case "no_write": case "no_tool_errors": return { ...base, kind };
    case "max_tool_calls": case "max_tokens": case "max_duration_ms": if (typeof c.n !== "number" || !Number.isFinite(c.n) || c.n <= 0) { errors.push(`${prefix}.n 必须为正数`); return null; } return { ...base, kind, n: c.n };
    default: errors.push(`${prefix}.kind 未知：${kind}`); return null;
  }
}

function numOpt(c: Record<string, unknown>, key: string): Record<string, number> {
  return typeof c[key] === "number" && Number.isFinite(c[key]) ? { [key]: c[key] as number } : {};
}

function expandExpected(e: ExpectedBehavior, prefix: string): EvalCheck[] {
  const out: EvalCheck[] = [];
  const push = (check: EvalCheck) => { if (check.required === undefined) check.required = true; out.push(check); };
  if (e.status !== undefined) push({ kind: "status", in: Array.isArray(e.status) ? e.status : [e.status] });
  if (e.certificatePassed !== undefined) push({ kind: "certificate", passed: e.certificatePassed });
  for (const call of e.toolCalled ?? []) push(expandToolCall(call));
  for (const name of e.toolNotCalled ?? []) push({ kind: "tool_not_called", name });
  if (e.replyIncludes?.length) push({ kind: "reply_includes", all: e.replyIncludes });
  if (e.replyAny?.length) push({ kind: "reply_includes", any: e.replyAny });
  if (e.replyExcludes?.length) push({ kind: "reply_excludes", any: e.replyExcludes });
  for (const pattern of e.replyRegex ?? []) push({ kind: "reply_regex", pattern });
  if (e.inboxSaved) push({ kind: "inbox_saved", ...e.inboxSaved });
  if (e.opportunitySaved) push({ kind: "opportunity_saved", ...e.opportunitySaved });
  if (e.pendingApproval !== undefined) push({ kind: "pending_approval", min: e.pendingApproval });
  if (e.evidenceVerified !== undefined) push({ kind: "evidence_verified", min: e.evidenceVerified });
  if (e.noWrite) push({ kind: "no_write" });
  if (e.noToolErrors) push({ kind: "no_tool_errors" });
  if (e.maxToolCalls !== undefined) push({ kind: "max_tool_calls", n: e.maxToolCalls });
  if (e.maxTokens !== undefined) push({ kind: "max_tokens", n: e.maxTokens });
  if (e.maxDurationMs !== undefined) push({ kind: "max_duration_ms", n: e.maxDurationMs });
  if (e.webSourceCited !== undefined) push({ kind: "web_source_cited", min: e.webSourceCited });
  for (const c of out) if (!c.id) c.id = `${c.kind}-${out.indexOf(c) + 1}`;
  void prefix;
  return out;
}

function expandToolCall(call: ToolCallExpectation): EvalCheck {
  return { kind: "tool_called", name: call.name, ...(call.min !== undefined ? { min: call.min } : {}), ...(call.args ? { args: call.args } : {}), ...(call.argsContains ? { argsContains: call.argsContains } : {}) };
}

// ── 哈希 / 统计 / 保存 ──────────────────────────────────────────────────────
export function suiteHash(suite: EvalSuite): string {
  return sha256(stableStringify({ id: suite.id, cases: suite.cases }));
}

export function caseHash(c: EvalCase): string {
  return sha256(stableStringify(c)).slice(0, 16);
}

export function suiteStats(suite: EvalSuite): { total: number; byCategory: Record<string, number>; byDifficulty: Record<string, number>; exploratory: number; holdout: number; scripted: number } {
  const stats = { total: suite.cases.length, byCategory: {} as Record<string, number>, byDifficulty: {} as Record<string, number>, exploratory: 0, holdout: 0, scripted: 0 };
  for (const c of suite.cases) {
    stats.byCategory[c.category] = (stats.byCategory[c.category] ?? 0) + 1;
    stats.byDifficulty[c.difficulty] = (stats.byDifficulty[c.difficulty] ?? 0) + 1;
    if (c.exploratory) stats.exploratory++;
    if (c.holdout) stats.holdout++;
    if (c.script?.length || c.turns?.some((turn) => turn.script?.length)) stats.scripted++;
  }
  return stats;
}

export function saveSuite(suite: EvalSuite, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(suite, null, 2) + "\n", "utf8");
}

export function categoryList(suites: EvalSuite[]): EvalCategory[] {
  const set = new Set<string>();
  for (const s of suites) for (const c of s.cases) set.add(c.category);
  return [...set].sort();
}
