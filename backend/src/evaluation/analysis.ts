// 失败分析：把一次 EvalRun 的失败结果按 FailureCategory 聚类，产出规则化、可执行的优化建议，
// 并给出确定性的校准样本（优先 holdout 之外的通过用例，供人工 / 独立 Judge 复核）。
// 事实边界：纯规则分析，不调用模型、不臆造根因；建议只映射到真实可改点
// （system prompt / context 注入 / tool 描述 / recovery / 预算 / 证据门控）。
import type { CheckResult, EvalResult, EvalRun, FailureCategory } from "./types.ts";

export interface FailureCluster {
  category: FailureCategory;
  count: number;
  caseIds: string[];
  failedChecks: string[];
  hint: string;
}

export interface FailureAnalysis {
  runId: string;
  totalFailures: number;
  clusters: FailureCluster[];
  optimizations: string[];
  calibrationSample: Array<{ caseId: string; category: string; replyPreview: string; failedChecks: string[] }>;
}

interface CategoryGuidance {
  hint: string;
  optimizations: string[];
}

const DEFAULT_SAMPLE_SIZE = 5;
const DEFAULT_SAMPLE_SEED = 42;
const MAX_OPTIMIZATIONS = 8;
const MAX_RENDER_LINES = 80;

// 每个 FailureCategory 的规则化定位与可执行建议：hint 说明去改哪里，optimizations 给出具体动作。
// 全部为确定性文本，不依赖模型生成，便于工作 Agent 直接照做。
const GUIDANCE: Record<FailureCategory, CategoryGuidance> = {
  planning_error: {
    hint: "规划错误：检查 system prompt 是否要求先列步骤与验收标准再调工具，以及工具顺序依赖（如先 web_search 再 web_fetch）是否被 plan 正确处理。",
    optimizations: [
      "system prompt：计划阶段先输出步骤清单与验收标准，再进入工具调用。",
      "计划校验：对 tool_order 类失败在 summarize 前重排步骤，最多重试一次。",
    ],
  },
  tool_selection_error: {
    hint: "工具选择错误：核对工具 description 与 scope 门控（toolNames 白名单）是否覆盖该场景，且同类工具用途区分清晰。",
    optimizations: [
      "tool 描述：在 description 写清适用/不适用场景与参数示例，减少误选。",
      "scope 门控：检查 toolNames 白名单是否漏配必需工具，或暴露了易混淆的同类工具。",
    ],
  },
  tool_argument_error: {
    hint: "工具参数错误：在 parameters 中补全必填字段与格式示例（日期 YYYY-MM-DD、sourceUrl 必须是官网），并在调用前做参数预校验。",
    optimizations: [
      "tool 描述：为关键参数补格式示例与取值约束（日期、URL、枚举）。",
      "调用前校验：拦截缺必填/格式错误的参数，把错误回传给模型自我修正。",
    ],
  },
  context_missing: {
    hint: "上下文注入缺失：检查 personalContext 注入顺序与裁剪预算，确认用户身份、学期、日程与固定时钟在首轮请求前已进入上下文。",
    optimizations: [
      "上下文注入：在 context-builder 中把 personalContext（身份/学期/日程/now）放在用户消息之前注入，避免被裁剪。",
      "预算：为上下文保留 token 配额，长历史优先摘要而不是整体截断。",
    ],
  },
  execution_recovery: {
    hint: "执行恢复不足：检查工具 transient 失败的 retry/backoff 与步骤重试策略，失败后应降级继续而不是直接放弃。",
    optimizations: [
      "recovery：对 tool_transient/rate_limit 按指数退避重试，把失败工具结果转成可继续的 observation。",
      "system prompt：要求模型在工具报错后说明降级方案，不伪造成功。",
    ],
  },
  evidence_missing: {
    hint: "证据缺失：核对证据门控与 web_fetch → sourceId → 文档引用链，外部事实必须先抓到官方来源再写。",
    optimizations: [
      "证据门控：最终答复前逐个检查外部事实是否关联 web_fetch 返回的 sourceId，缺证据时标注不确定。",
      "工具流程：要求先 web_search 再 web_fetch 官方来源，禁止只依据搜索摘要下结论。",
    ],
  },
  evidence_hallucination: {
    hint: "证据幻觉：检查是否接受模型自报 VERIFIED 或自编 sourceId；只允许 web_fetch 返回的真实来源与正文摘录。",
    optimizations: [
      "证据门控：只认 web_fetch 返回的 sourceId，自填来源一律判为未核验并降级。",
      "system prompt：明确禁止编造来源、日期、结果与 VERIFIED，无法核验时写未核实。",
    ],
  },
  safety_violation: {
    hint: "安全违规：核对写操作授权门控（仅用户明确要求才写、写前预览）与危险工具/私网访问拦截是否生效。",
    optimizations: [
      "授权门控：写工具调用前校验用户是否明确要求，预览阶段不得落库。",
      "安全策略：terminal/私网/元数据访问保持拒绝，并把拒绝原因回传给模型。",
    ],
  },
  side_effect_error: {
    hint: "副作用错误：核对 save_to_inbox / save_opportunity 的字段映射、去重键（标题+截止+地点）与评测数据隔离。",
    optimizations: [
      "写入校验：保存前按 title+deadline+location 去重，保存后回读确认。",
      "数据隔离：评测固定使用 MemoryStore，避免污染真实库。",
    ],
  },
  format_error: {
    hint: "输出格式错误：检查 system prompt 中摘要长度/要点数量/Markdown 骨架与 reply_includes、reply_regex 的硬性格式是否一致。",
    optimizations: [
      "system prompt：固定「时效结论 + ≤6 条要点 + 可点击来源」的输出骨架。",
      "检查对齐：把 reply_includes/reply_regex 要求写进提示词与示例，避免格式漂移。",
    ],
  },
  task_incomplete: {
    hint: "任务未完成：检查完成判定（status/certificate）与工具步数预算，确认是提前退出还是预算耗尽。",
    optimizations: [
      "完成判定：summarize 前对照 acceptance/checks 清单逐项确认，未达标继续执行。",
      "预算：长任务拆成可交付阶段并适当提高 maxToolCalls，避免中途耗尽。",
    ],
  },
  budget_exceeded: {
    hint: "预算超限：检查 maxToolCalls / maxTokens / maxDurationMs 与重复搜索、重复抓取，优先压工具轮次与上下文体积。",
    optimizations: [
      "预算：对重复 web_search/web_fetch 做缓存与去重，减少无效轮次。",
      "上下文：压缩历史消息与工具结果摘要，降低 token 消耗。",
    ],
  },
  runtime_error: {
    hint: "运行时错误：检查 provider HTTP 超时、模型输出解析与错误分类（transport/rate_limit/invalid_model_output），补超时与重试。",
    optimizations: [
      "运行时：为 provider 请求设置超时与重试，按错误分类降级模型。",
      "可观测性：保留失败 tracePath 用于复现。",
    ],
  },
  response_quality: {
    hint: "回复质量不足：检查摘要是否先给结论、是否区分已核实/未核实、是否覆盖用户每个子问题。",
    optimizations: [
      "system prompt：要求先给结论再列证据，明确区分已核实事实与未核实项。",
      "Judge：为 response_quality 补充 rubric 维度（相关性/完整性/谨慎性）。",
    ],
  },
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 检查项的可读标识：优先 label，缺失时退回 id/kind，便于报告直接展示。
function checkLabel(check: CheckResult): string {
  const label = (check.label ?? "").trim();
  if (label) return `${check.kind}(${label})`;
  return check.id || check.kind;
}

function failedCheckLabels(result: EvalResult): string[] {
  const labels = new Set<string>();
  for (const check of result.checks) if (!check.passed) labels.add(checkLabel(check));
  return [...labels].sort(compareText);
}

// failureCategory 缺失时的确定性回退：按失败检查类型推断，避免失败被丢弃。
function inferFailureCategory(result: EvalResult): FailureCategory {
  if (result.status === "error") return "runtime_error";
  const failedKinds = new Set(result.checks.filter((c) => !c.passed).map((c) => c.kind));
  if (failedKinds.has("pending_approval") || failedKinds.has("no_write") || failedKinds.has("tool_not_called")) return "safety_violation";
  if (failedKinds.has("evidence_verified") || failedKinds.has("web_source_cited")) return "evidence_missing";
  if (failedKinds.has("max_tool_calls") || failedKinds.has("max_tokens") || failedKinds.has("max_duration_ms")) return "budget_exceeded";
  if (failedKinds.has("tool_called")) return "tool_selection_error";
  if (failedKinds.has("tool_order")) return "planning_error";
  if (failedKinds.has("no_tool_errors")) return "execution_recovery";
  if (failedKinds.has("inbox_saved") || failedKinds.has("opportunity_saved")) return "side_effect_error";
  if (failedKinds.has("status") || failedKinds.has("certificate")) return "task_incomplete";
  if (failedKinds.has("reply_includes") || failedKinds.has("reply_regex")) return "format_error";
  if (failedKinds.has("reply_excludes")) return "safety_violation";
  if (failedKinds.has("judge")) return "response_quality";
  if (failedKinds.has("runtime")) return "runtime_error";
  return "task_incomplete";
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return DEFAULT_SAMPLE_SEED;
  return Math.trunc(seed) >>> 0;
}

// 轻量确定性 PRNG（mulberry32）：同一 seed 必得同一序列，便于抽样结果复现。
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 先按 caseId 排序再洗牌，保证抽样与输入 results 顺序无关。
function seededShuffle(items: EvalResult[], random: () => number): EvalResult[] {
  const out = [...items].sort((a, b) => compareText(a.caseId, b.caseId));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// 确定性伪随机抽样：按「非 holdout 通过 → 非 holdout 其他 → holdout」分层，层内用 seed 洗牌。
// 这样人工 / 独立 Judge 校准默认优先看未参与调参的通过用例，holdout 只在样本不足时补足。
export function calibrationSample(run: EvalRun, size: number, seed = DEFAULT_SAMPLE_SEED): EvalResult[] {
  const limit = Math.max(0, Math.floor(Number.isFinite(size) ? size : 0));
  if (limit === 0) return [];
  const tiers: EvalResult[][] = [[], [], [], []];
  for (const result of run.results) {
    if (result.status === "skipped") continue;
    if (result.passed && !result.holdout && !result.exploratory) tiers[0].push(result);
    else if (result.passed && !result.holdout) tiers[1].push(result);
    else if (!result.holdout) tiers[2].push(result);
    else tiers[3].push(result);
  }
  const random = mulberry32(normalizeSeed(seed));
  const picked: EvalResult[] = [];
  for (const tier of tiers) {
    if (picked.length >= limit) break;
    for (const result of seededShuffle(tier, random)) {
      if (picked.length >= limit) break;
      picked.push(result);
    }
  }
  return picked;
}

export function analyzeRun(run: EvalRun, opts: { sampleSize?: number } = {}): FailureAnalysis {
  const failures = run.results.filter((result) => !result.passed && result.status !== "skipped");
  const grouped = new Map<FailureCategory, EvalResult[]>();
  for (const result of failures) {
    const category = result.failureCategory ?? inferFailureCategory(result);
    const bucket = grouped.get(category);
    if (bucket) bucket.push(result);
    else grouped.set(category, [result]);
  }
  const clusters: FailureCluster[] = [...grouped.entries()]
    .map(([category, results]) => ({
      category,
      count: results.length,
      caseIds: [...new Set(results.map((result) => result.caseId))].sort(compareText),
      failedChecks: [...new Set(results.flatMap(failedCheckLabels))].sort(compareText),
      hint: GUIDANCE[category].hint,
    }))
    .sort((a, b) => b.count - a.count || compareText(a.category, b.category));

  // 建议按失败簇大小排序去重，每类最多取若干条，保证报告紧凑可执行。
  const optimizations: string[] = [];
  const seenTips = new Set<string>();
  for (const cluster of clusters) {
    for (const tip of GUIDANCE[cluster.category].optimizations) {
      if (seenTips.has(tip)) continue;
      seenTips.add(tip);
      optimizations.push(`[${cluster.category} ×${cluster.count}] ${tip}`);
      if (optimizations.length >= MAX_OPTIMIZATIONS) break;
    }
    if (optimizations.length >= MAX_OPTIMIZATIONS) break;
  }

  const sampleSize = Math.max(0, Math.floor(opts.sampleSize ?? DEFAULT_SAMPLE_SIZE));
  const samples = calibrationSample(run, sampleSize).map((result) => ({
    caseId: result.caseId,
    category: result.category,
    replyPreview: result.replyPreview,
    failedChecks: failedCheckLabels(result),
  }));

  return {
    runId: run.runId,
    totalFailures: failures.length,
    clusters,
    optimizations,
    calibrationSample: samples,
  };
}

function oneLine(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// 紧凑纯文本：头部给结论，中部给失败簇与可执行建议，尾部给人工校准样本；≤80 行。
export function renderAnalysis(analysis: FailureAnalysis): string {
  const lines: string[] = [];
  lines.push(`# 失败分析：${analysis.runId}`);
  lines.push(`总失败用例：${analysis.totalFailures}；失败簇：${analysis.clusters.length}`);
  if (analysis.clusters.length === 0) {
    lines.push("未发现失败用例。");
  } else {
    lines.push("", "## 失败簇");
    for (const cluster of analysis.clusters) {
      lines.push(`- ${cluster.category} ×${cluster.count}：${truncate(oneLine(cluster.caseIds.join(", ")), 160)}`);
      lines.push(`  failedChecks：${truncate(oneLine(cluster.failedChecks.join("；")) || "（由状态/证书判定）", 180)}`);
      lines.push(`  hint：${truncate(oneLine(cluster.hint), 220)}`);
    }
  }
  lines.push("", "## 优化建议");
  if (analysis.optimizations.length === 0) lines.push("- 无失败，暂无优化项。");
  else for (let i = 0; i < analysis.optimizations.length; i++) lines.push(`${i + 1}. ${truncate(oneLine(analysis.optimizations[i]), 220)}`);
  lines.push("", `## 校准样本（${analysis.calibrationSample.length}）`);
  if (analysis.calibrationSample.length === 0) {
    lines.push("- 无可用样本（skipped 用例不参与抽检）。");
  } else {
    for (const sample of analysis.calibrationSample) {
      lines.push(`- ${sample.caseId}（${sample.category}）：${truncate(oneLine(sample.replyPreview) || "（空回复）", 120)}`);
    }
  }
  if (lines.length > MAX_RENDER_LINES) {
    lines.length = MAX_RENDER_LINES - 1;
    lines.push(`...（超过 ${MAX_RENDER_LINES} 行已截断，完整数据见 analysis JSON）`);
  }
  return lines.join("\n");
}
