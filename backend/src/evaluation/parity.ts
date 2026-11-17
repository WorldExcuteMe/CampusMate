// Parity 对照：把「人类在真实聊天框产生的任务事件」与「Headless 评测 trace」归一成同一套
// 行为指纹，比较工具序列/参数哈希/状态/来源/用量，回答“评测是否等价于真实使用”。
// 事实边界：LLM 有采样非确定性，文本不逐字比较（只报语义重叠信号）；工具调用/状态/副作用才是等价性主指标。
import fs from "node:fs";
import { canonicalArgs, sha256 } from "../runtime/idempotency.ts";
import type { EvalResult, EvalRun, EvalTrace } from "./types.ts";

export interface BehaviorFingerprint {
  source: "human" | "eval";
  label: string;
  status: string;
  toolSequence: string[];
  // 参数哈希与 toolSequence 对齐；人类任务缺参数数据时为 null。
  toolArgsHashes: string[] | null;
  llmRequests: number | null;
  toolErrors: number | null;
  sourceUrls: string[];
  tokens: number | null;
  durationMs: number | null;
  reply: string;
  turns: number;
}

export interface HumanTaskEvidence {
  task?: {
    id?: string; status?: unknown; createdAt?: number; updatedAt?: number;
    usage?: { tokens?: number; toolCalls?: number } | null;
    result?: { summary?: string } | null; error?: string | null; turnSeq?: number;
  };
  events?: unknown[];
  invocations?: unknown[];
}

export interface HumanEvidence {
  tasks?: HumanTaskEvidence[];
  // 兼容单任务直传。
  task?: HumanTaskEvidence["task"];
  events?: unknown[];
  invocations?: unknown[];
}

export interface ParityThresholds {
  requireStatusMatch: boolean;
  minToolSimilarity: number;              // 0–1，按顺序 LCS 相似度
  minArgsMatchRate: number | null;        // null = 有参数数据时也不作为门槛
  maxLlmRequestDelta: number | null;      // null = 不检查
}

export interface ParityMetrics {
  statusMatch: boolean;
  toolExactMatch: boolean;
  toolSimilarity: number;                 // 顺序 LCS / 较长序列
  toolSetSimilarity: number;              // 集合 Jaccard
  argsMatchRate: number | null;           // 双方都有参数哈希时可比
  sourceOverlap: number | null;           // 来源 URL 集合 Jaccard
  llmRequestDelta: number | null;
  tokensRatio: number | null;
  durationRatio: number | null;
  replyOverlap: number;                   // 字符 bigram Jaccard，仅作参考信号
  toolErrorDelta: number | null;
}

export interface ParityResult {
  human: BehaviorFingerprint;
  eval: BehaviorFingerprint;
  metrics: ParityMetrics;
  passed: boolean;
  reasons: string[];
  warnings: string[];
}

export const DEFAULT_PARITY_THRESHOLDS: ParityThresholds = {
  requireStatusMatch: true,
  minToolSimilarity: 0.8,
  // 参数内容受 LLM 采样影响（例如同一检索意图换一种 query 措辞）；默认只报告，不据此判失败。
  // 需要严格比较时由调用方设置 --min-args-match。
  minArgsMatchRate: null,
  maxLlmRequestDelta: null,
};

// ── 原始证据归一化 ──────────────────────────────────────────────────────────
export function normalizeHumanEvidence(raw: unknown): HumanEvidence {
  if (!raw || typeof raw !== "object") throw new Error("人类任务证据必须是对象");
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.tasks)) return { tasks: value.tasks as HumanTaskEvidence[], ...(Array.isArray(value.invocations) ? { invocations: value.invocations } : {}) };
  if (Array.isArray(value.events) || value.task) {
    return {
      tasks: [{ ...(value.task ? { task: value.task as HumanTaskEvidence["task"] } : {}), events: Array.isArray(value.events) ? value.events : [] }],
      ...(Array.isArray(value.invocations) ? { invocations: value.invocations } : {}),
    };
  }
  if (Array.isArray(raw)) return { tasks: [{ events: raw }] };
  throw new Error("无法识别人类任务证据结构（需要 {task,events} / {tasks:[...]} / events 数组）");
}

interface NormalizedEvent { type: string; payload: Record<string, unknown>; at: number }
function eventsOf(task: HumanTaskEvidence): NormalizedEvent[] {
  const events = Array.isArray(task.events) ? task.events : [];
  return events
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
    .map((event) => ({
      type: typeof event.type === "string" ? event.type : "",
      payload: event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {},
      at: typeof event.createdAt === "number" ? event.createdAt : 0,
    }))
    .sort((a, b) => a.at - b.at);
}

function collectSourceUrls(events: NormalizedEvent[]): string[] {
  const urls = new Set<string>();
  for (const event of events) {
    const list = event.payload.sourceUrls;
    if (Array.isArray(list)) for (const url of list) if (typeof url === "string" && /^https?:\/\//.test(url)) urls.add(normalizeUrl(url));
  }
  return [...urls].sort();
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (/token|key|auth|secret|signature/i.test(key)) parsed.searchParams.delete(key);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  } catch { return url; }
}

function invocationArgsHashes(raw: unknown[] | undefined): string[] | null {
  if (!raw?.length) return null;
  const rows = raw.map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
    .map((row) => ({
      name: typeof row.toolName === "string" ? row.toolName : typeof row.tool_name === "string" ? row.tool_name : "",
      hash: typeof row.argsHash === "string" ? row.argsHash : typeof row.args_hash === "string" ? row.args_hash : "",
      at: typeof row.startedAt === "number" ? row.startedAt : typeof row.started_at === "number" ? row.started_at : 0,
    }))
    .filter((row) => row.hash);
  if (!rows.length) return null;
  return rows.sort((a, b) => a.at - b.at).map((row) => row.hash);
}

export function fingerprintFromHuman(raw: unknown): BehaviorFingerprint {
  const evidence = normalizeHumanEvidence(raw);
  const tasks = (evidence.tasks ?? []).map((task, index) => ({ task, index }))
    .sort((a, b) => (a.task.task?.turnSeq ?? a.index) - (b.task.task?.turnSeq ?? b.index) || (a.task.task?.createdAt ?? 0) - (b.task.task?.createdAt ?? 0))
    .map((item) => item.task);
  const allEvents: NormalizedEvent[] = [];
  const toolSequence: string[] = [];
  let toolErrors = 0;
  let llmRequests = 0;
  for (const task of tasks) {
    const events = eventsOf(task);
    allEvents.push(...events);
    for (const event of events) {
      if (event.type === "llm.request") llmRequests++;
      if (event.type === "tool.called" && typeof event.payload.name === "string") toolSequence.push(event.payload.name);
      if (event.type === "tool.result" && event.payload.ok === false) toolErrors++;
    }
  }
  const last = tasks[tasks.length - 1]?.task;
  const tokens = tasks.reduce((sum, task) => sum + (typeof task.task?.usage?.tokens === "number" ? task.task.usage.tokens : 0), 0);
  const durationMs = tasks.reduce((sum, task) => {
    const created = task.task?.createdAt, updated = task.task?.updatedAt;
    return sum + (typeof created === "number" && typeof updated === "number" && updated >= created ? updated - created : 0);
  }, 0);
  return {
    source: "human",
    label: tasks.map((task) => task.task?.id).filter((id): id is string => typeof id === "string").join(",") || "human",
    status: typeof last?.status === "string" ? last.status : "unknown",
    toolSequence,
    toolArgsHashes: invocationArgsHashes(evidence.invocations),
    llmRequests: tasks.length ? llmRequests : null,
    toolErrors: tasks.length ? toolErrors : null,
    sourceUrls: collectSourceUrls(allEvents),
    tokens: tasks.length ? tokens : null,
    durationMs: tasks.length && durationMs > 0 ? durationMs : null,
    reply: typeof last?.result?.summary === "string" ? last.result.summary : typeof last?.error === "string" ? last.error : "",
    turns: Math.max(1, tasks.length),
  };
}

// 从一次 EvalRun + trace 文件构造评测侧指纹（parity CLI 使用）。
export function fingerprintFromEval(run: EvalRun, result: EvalResult, trace: EvalTrace): BehaviorFingerprint {
  const tools = Array.isArray(trace.tools) ? trace.tools : [];
  const events = Array.isArray(trace.events) ? trace.events : [];
  return {
    source: "eval",
    label: `${run.runId}:${result.caseId}`,
    status: String(result.status),
    toolSequence: tools.map((tool) => tool.name),
    toolArgsHashes: tools.map((tool) => sha256(canonicalArgs(tool.args ?? {}))),
    llmRequests: typeof trace.llm?.requests === "number" ? trace.llm.requests : null,
    toolErrors: tools.filter((tool) => tool.ok === false && !tool.approvalPending).length,
    sourceUrls: collectSourceUrls(events.map((event) => ({ type: event.type, payload: event.payload ?? {}, at: event.at ?? 0 }))),
    tokens: result.usage?.tokens ?? null,
    durationMs: result.durationMs ?? null,
    reply: typeof trace.finalOutput === "string" ? trace.finalOutput : result.replyPreview,
    turns: result.turnCount ?? Math.max(1, trace.turns?.length ?? 1),
  };
}

// ── 对比 ────────────────────────────────────────────────────────────────────
function lcsLength(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  }
  return dp[a.length][b.length];
}

function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a), setB = new Set(b);
  if (!setA.size && !setB.size) return 1;
  let intersection = 0;
  for (const item of setA) if (setB.has(item)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function bigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, "").replace(/[，,。.！!？?：:；;、（）()【】\[\]"'“”]/g, "").toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

export function compareBehavior(human: BehaviorFingerprint, evaluation: BehaviorFingerprint, thresholds: Partial<ParityThresholds> = {}): ParityResult {
  const limits: ParityThresholds = { ...DEFAULT_PARITY_THRESHOLDS, ...thresholds };
  const length = Math.max(human.toolSequence.length, evaluation.toolSequence.length);
  const toolSimilarity = length ? lcsLength(human.toolSequence, evaluation.toolSequence) / length : 1;
  const toolExactMatch = human.toolSequence.length === evaluation.toolSequence.length && toolSimilarity === 1;
  let argsMatchRate: number | null = null;
  if (human.toolArgsHashes && evaluation.toolArgsHashes) {
    // 按「同名工具的第 k 次出现」配对参数哈希：序列整体错位时仍能比较同一工具的调用参数。
    const evalIndices = new Map<string, number[]>();
    evaluation.toolSequence.forEach((name, index) => {
      const list = evalIndices.get(name) ?? [];
      list.push(index);
      evalIndices.set(name, list);
    });
    const used = new Map<string, number>();
    let total = 0;
    let matched = 0;
    human.toolSequence.forEach((name, index) => {
      const candidates = evalIndices.get(name);
      if (!candidates) return;
      const k = used.get(name) ?? 0;
      if (k >= candidates.length) return;
      used.set(name, k + 1);
      const evalIndex = candidates[k];
      total++;
      if (human.toolArgsHashes![index] === evaluation.toolArgsHashes![evalIndex]) matched++;
    });
    argsMatchRate = total > 0 ? matched / total : null;
  }
  const metrics: ParityMetrics = {
    statusMatch: human.status === evaluation.status,
    toolExactMatch,
    toolSimilarity,
    toolSetSimilarity: jaccard(human.toolSequence, evaluation.toolSequence),
    argsMatchRate,
    sourceOverlap: human.sourceUrls.length && evaluation.sourceUrls.length ? jaccard(human.sourceUrls, evaluation.sourceUrls) : null,
    llmRequestDelta: human.llmRequests !== null && evaluation.llmRequests !== null ? evaluation.llmRequests - human.llmRequests : null,
    tokensRatio: ratio(evaluation.tokens, human.tokens),
    durationRatio: ratio(evaluation.durationMs, human.durationMs),
    replyOverlap: jaccard(bigrams(human.reply), bigrams(evaluation.reply)),
    toolErrorDelta: human.toolErrors !== null && evaluation.toolErrors !== null ? evaluation.toolErrors - human.toolErrors : null,
  };
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (limits.requireStatusMatch && !metrics.statusMatch) reasons.push(`状态不一致：人类=${human.status}，评测=${evaluation.status}`);
  if (toolSimilarity < limits.minToolSimilarity) reasons.push(`工具序列相似度 ${(toolSimilarity * 100).toFixed(0)}% 低于门槛 ${(limits.minToolSimilarity * 100).toFixed(0)}%（人类 ${human.toolSequence.join("→") || "无"} / 评测 ${evaluation.toolSequence.join("→") || "无"}）`);
  else if (!toolExactMatch) warnings.push(`工具序列非精确一致（相似度 ${(toolSimilarity * 100).toFixed(0)}%，集合 ${(metrics.toolSetSimilarity * 100).toFixed(0)}%）：请结合逐轮上下文判断是模型采样差异还是真实行为差异`);
  if (limits.minArgsMatchRate !== null && argsMatchRate !== null && argsMatchRate < limits.minArgsMatchRate) reasons.push(`工具参数哈希一致率 ${(argsMatchRate * 100).toFixed(0)}% 低于门槛 ${(limits.minArgsMatchRate * 100).toFixed(0)}%`);
  if (limits.maxLlmRequestDelta !== null && metrics.llmRequestDelta !== null && Math.abs(metrics.llmRequestDelta) > limits.maxLlmRequestDelta) reasons.push(`LLM 请求次数差 ${metrics.llmRequestDelta} 超过 ±${limits.maxLlmRequestDelta}`);
  if (argsMatchRate === null) warnings.push("人类侧缺少工具参数哈希（invocations），仅比较工具名/顺序/状态/来源；可用 --human-file 提供 invocations 获得参数级对照");
  else if (argsMatchRate < 1 && limits.minArgsMatchRate === null) warnings.push(`工具参数哈希一致率 ${(argsMatchRate * 100).toFixed(0)}%（参数内容受模型采样影响，默认只报告不判失败；严格比较请设 --min-args-match）`);
  if (metrics.replyOverlap < 0.3) warnings.push(`回复文本重叠 ${(metrics.replyOverlap * 100).toFixed(0)}%（仅参考；LLM 采样非确定，不作为失败依据）`);
  return { human, eval: evaluation, metrics, passed: reasons.length === 0, reasons, warnings };
}

export function renderParity(parity: ParityResult): string {
  const m = parity.metrics;
  const pct = (value: number | null, digits = 0): string => value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
  const lines = [
    `[parity] ${parity.passed ? "PASS" : "FAIL"} 人类=${parity.human.label} 评测=${parity.eval.label}`,
    `  状态：人类=${parity.human.status} 评测=${parity.eval.status}（${m.statusMatch ? "一致" : "不一致"}）`,
    `  工具序列：相似度 ${pct(m.toolSimilarity)}、集合 ${pct(m.toolSetSimilarity)}、精确=${m.toolExactMatch ? "是" : "否"}`,
    `    人类：${parity.human.toolSequence.join(" → ") || "无"}`,
    `    评测：${parity.eval.toolSequence.join(" → ") || "无"}`,
    `  参数哈希一致率：${pct(m.argsMatchRate)}；来源重叠：${pct(m.sourceOverlap)}；LLM 请求差：${m.llmRequestDelta ?? "n/a"}`,
    `  用量：tokens 比 ${m.tokensRatio === null ? "n/a" : m.tokensRatio.toFixed(2)}、耗时比 ${m.durationRatio === null ? "n/a" : m.durationRatio.toFixed(2)}、工具错误差 ${m.toolErrorDelta ?? "n/a"}`,
    `  回复文本重叠：${pct(m.replyOverlap)}（参考信号，不参与判定）`,
  ];
  if (parity.reasons.length) lines.push(`  失败原因：${parity.reasons.join("；")}`);
  for (const warning of parity.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

// 读取 run 的结果 + trace 文件；trace 文件缺失时给出明确错误。
export function loadEvalFingerprint(run: EvalRun, caseId: string): BehaviorFingerprint {
  const result = run.results.find((item) => item.caseId === caseId) ?? run.results.find((item) => item.caseId.startsWith(caseId));
  if (!result) throw new Error(`运行 ${run.runId} 中没有用例 ${caseId}`);
  if (!result.tracePath) throw new Error(`用例 ${result.caseId} 没有 tracePath（旧运行或被跳过），无法做行为对照`);
  if (!fs.existsSync(result.tracePath)) throw new Error(`trace 文件不存在：${result.tracePath}`);
  const trace = JSON.parse(fs.readFileSync(result.tracePath, "utf8")) as EvalTrace;
  return fingerprintFromEval(run, result, trace);
}
