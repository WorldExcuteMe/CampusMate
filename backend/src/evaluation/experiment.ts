// 实验 Manifest 与版本对比 / 回归 Gate：
// - createManifest 记录一次评测的环境指纹（代码提交、prompt/工具/数据集哈希、模型、并发等），保证可复现；
// - compareRuns 对齐两次 run 的 caseId，识别回归与改进；
// - evaluateGate 按 GateThresholds 决定候选版本能否晋级（绝对通过率、相对下降、holdout、硬门槛、预算）。
// 事实边界：哈希来自真实的 CAMPUS_SYSTEM / CLOUD_TOOLS / 数据集；Gate 只看确定性指标，
// 不替代人工抽检与 Judge。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GATE_THRESHOLDS } from "./types.ts";
import type {
  EvalManifest, EvalResult, EvalRun, EvalSuite, GateItem, GateOutcome, GateThresholds, RunComparison, TargetKind,
} from "./types.ts";
import { sha256, stableStringify, suiteHash } from "./dataset.ts";
import { CAMPUS_SYSTEM } from "../core/system-prompt.ts";
import { CLOUD_TOOLS } from "../core/cloud-tools.ts";

// backend/src/evaluation/experiment.ts → ../../../ 即仓库根（与 dataset.ts 的 DEFAULT_RUNS_ROOT 同源）。
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GATE_EPSILON = 1e-9;

export interface ManifestInput {
  runId: string;
  label?: string;
  target: TargetKind;
  suites: EvalSuite[];
  caseCount: number;
  model: EvalManifest["model"];
  concurrency: number;
  offlineTools: boolean;
  seed?: number;
  notes?: string[];
  entry?: EvalManifest["entry"];
}

function runGit(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 5000 }).trim();
}

// 无子进程环境（沙箱/受限 CI）兜底：直接读 .git/HEAD 与 refs，至少保留 commit/branch 指纹。
function gitInfoFromFs(): { commit: string; branch: string } | null {
  try {
    const gitDir = path.join(REPO_ROOT, ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return { commit: head.slice(0, 12), branch: "detached" };
    const ref = head.slice(4).trim();
    const branch = ref.replace(/^refs\/heads\//, "");
    const refFile = path.join(gitDir, ref);
    if (fs.existsSync(refFile)) return { commit: fs.readFileSync(refFile, "utf8").trim().slice(0, 12), branch };
    const packedFile = path.join(gitDir, "packed-refs");
    if (fs.existsSync(packedFile)) {
      const line = fs.readFileSync(packedFile, "utf8").split(/\r?\n/).find((row) => row.endsWith(` ${ref}`));
      if (line) return { commit: line.split(" ")[0].slice(0, 12), branch };
    }
    return null;
  } catch {
    return null;
  }
}

// 仓库版本指纹：任何 git 调用失败都降级（先读 .git，仍失败则 unknown），不阻断 manifest 生成。
export function gitInfo(): { commit: string; branch: string; dirty: boolean } {
  try {
    const commit = runGit(["rev-parse", "--short=12", "HEAD"]) || "unknown";
    const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
    const dirty = runGit(["status", "--porcelain"]).length > 0;
    return { commit, branch, dirty };
  } catch {
    const fallback = gitInfoFromFs();
    return fallback ? { ...fallback, dirty: false } : { commit: "unknown", branch: "unknown", dirty: false };
  }
}

// 工具集指纹：只把 name + parameters 纳入哈希，描述文案改动由人工评审决定是否算变更。
function currentToolsHash(): string {
  return sha256(stableStringify(CLOUD_TOOLS.map((tool) => ({ name: tool.function.name, parameters: tool.function.parameters }))));
}

export function createManifest(input: ManifestInput): EvalManifest {
  const datasetHashes: Record<string, string> = {};
  for (const suite of input.suites) datasetHashes[suite.id] = suiteHash(suite);
  return {
    runId: input.runId,
    ...(input.label !== undefined ? { label: input.label } : {}),
    target: input.target,
    suites: input.suites.map((suite) => suite.id),
    caseCount: input.caseCount,
    createdAt: new Date().toISOString(),
    git: gitInfo(),
    node: process.version,
    model: input.model,
    ...(input.entry ? { entry: input.entry } : {}),
    systemPromptHash: sha256(CAMPUS_SYSTEM),
    toolsHash: currentToolsHash(),
    datasetHashes,
    concurrency: input.concurrency,
    offlineTools: input.offlineTools,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.notes && input.notes.length ? { notes: [...input.notes] } : {}),
  };
}

// ── 版本对比 ────────────────────────────────────────────────────────────────
// 只统计参与 Gate 的用例：非 skipped、非 exploratory（与 EvalMetrics.passRate 口径一致）。
function scoredResults(run: EvalRun): EvalResult[] {
  return run.results.filter((result) => result.status !== "skipped" && !result.exploratory);
}

function passRateOf(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  let passed = 0;
  for (const result of results) if (result.passed) passed++;
  return passed / results.length;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareRuns(baseline: EvalRun, candidate: EvalRun): RunComparison {
  const baselineScored = scoredResults(baseline);
  const candidateScored = scoredResults(candidate);
  const baselineRate = passRateOf(baselineScored);
  const candidateRate = passRateOf(candidateScored);

  const categories = new Set<string>();
  for (const result of baselineScored) categories.add(result.category);
  for (const result of candidateScored) categories.add(result.category);
  const byCategory: RunComparison["byCategory"] = {};
  for (const category of [...categories].sort(compareText)) {
    const base = passRateOf(baselineScored.filter((result) => result.category === category));
    const cand = passRateOf(candidateScored.filter((result) => result.category === category));
    byCategory[category] = { baseline: round(base), candidate: round(cand), delta: round(cand - base) };
  }

  // caseId 对齐：skipped 用例无法判定成败，不参与回归/修复归类。
  const baselineScoredById = new Map(baselineScored.map((result) => [result.caseId, result]));
  const candidateScoredById = new Map(candidateScored.map((result) => [result.caseId, result]));
  const baselineAllIds = new Set(baseline.results.map((result) => result.caseId));
  const candidateAllIds = new Set(candidate.results.map((result) => result.caseId));

  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const [caseId, cand] of candidateScoredById) {
    const base = baselineScoredById.get(caseId);
    if (!base) continue;
    if (base.passed && !cand.passed) regressions.push(caseId);
    else if (!base.passed && cand.passed) improvements.push(caseId);
  }
  const newCases = candidateScored.filter((result) => !baselineAllIds.has(result.caseId)).map((result) => result.caseId);
  const removedCases = baselineScored.filter((result) => !candidateAllIds.has(result.caseId)).map((result) => result.caseId);

  // manifestDiff 只记录真正变化的指纹字段，目标/模型/哈希/数据集/并发任一项变化都提示版本不可直接对比。
  const manifestDiff: RunComparison["manifestDiff"] = {};
  const pushDiff = (key: string, base: string | number | boolean, cand: string | number | boolean): void => {
    if (base !== cand) manifestDiff[key] = { baseline: base, candidate: cand };
  };
  pushDiff("model", baseline.manifest.model.modelId ?? "", candidate.manifest.model.modelId ?? "");
  pushDiff("systemPromptHash", baseline.manifest.systemPromptHash, candidate.manifest.systemPromptHash);
  pushDiff("toolsHash", baseline.manifest.toolsHash, candidate.manifest.toolsHash);
  pushDiff("datasetHashes", stableStringify(baseline.manifest.datasetHashes), stableStringify(candidate.manifest.datasetHashes));
  pushDiff("target", baseline.manifest.target, candidate.manifest.target);
  pushDiff("concurrency", baseline.manifest.concurrency, candidate.manifest.concurrency);

  const baselineCost = baseline.metrics.totalCostUsd;
  const candidateCost = candidate.metrics.totalCostUsd;
  const baselineDuration = baseline.metrics.avgDurationMs;
  const candidateDuration = candidate.metrics.avgDurationMs;

  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    ...(baseline.label !== undefined ? { baselineLabel: baseline.label } : {}),
    ...(candidate.label !== undefined ? { candidateLabel: candidate.label } : {}),
    overall: { baseline: round(baselineRate), candidate: round(candidateRate), delta: round(candidateRate - baselineRate) },
    byCategory,
    regressions: regressions.sort(compareText),
    improvements: improvements.sort(compareText),
    newCases: newCases.sort(compareText),
    removedCases: removedCases.sort(compareText),
    cost: { baseline: round(baselineCost), candidate: round(candidateCost), delta: round(candidateCost - baselineCost) },
    duration: { baseline: round(baselineDuration), candidate: round(candidateDuration), delta: round(candidateDuration - baselineDuration) },
    manifestDiff,
  };
}

// ── 回归 Gate ───────────────────────────────────────────────────────────────
function fmtRate(value: number): string {
  return value.toFixed(3);
}

function fmtDelta(value: number): string {
  const rounded = round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded.toFixed(3)}`;
}

function averageOf(results: EvalResult[], pick: (result: EvalResult) => number): number {
  if (results.length === 0) return 0;
  let total = 0;
  for (const result of results) total += pick(result);
  return total / results.length;
}

// 预算指标取「记录指标」与「实测结果」的较大者：调用方可能只填其中一侧，取大避免漏判超预算。
function conservativeAvg(recorded: number, computed: number): number {
  const a = Number.isFinite(recorded) ? recorded : 0;
  const b = Number.isFinite(computed) ? computed : 0;
  return Math.max(a, b);
}

export function evaluateGate(
  candidate: EvalRun,
  baseline: EvalRun | null,
  opts: { holdout?: EvalRun | null; thresholds?: Partial<GateThresholds> } = {},
): GateOutcome {
  const thresholds: GateThresholds = { ...DEFAULT_GATE_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const holdout = opts.holdout ?? null;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const items: GateItem[] = [];
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const candidateScored = scoredResults(candidate);
  const candidateRate = passRateOf(candidateScored);
  const baselineScored = baseline ? scoredResults(baseline) : null;
  const baselineRate = baselineScored ? passRateOf(baselineScored) : null;

  // 1) 绝对通过率：候选必须达到 minPassRate。只统计非 skipped、非 exploratory 用例。
  const minOk = candidateRate + GATE_EPSILON >= thresholds.minPassRate;
  items.push({
    name: "minPassRate",
    baseline: baselineRate === null ? null : round(baselineRate),
    candidate: round(candidateRate),
    delta: baselineRate === null ? null : round(candidateRate - baselineRate),
    ok: minOk,
    detail: `候选通过率 ${fmtRate(candidateRate)}，阈值 ≥${fmtRate(thresholds.minPassRate)}；计分用例 ${candidateScored.length} 个（跳过/探索性不计）`,
  });
  if (!minOk) reasons.push(`候选通过率 ${fmtRate(candidateRate)} 低于最低要求 ${fmtRate(thresholds.minPassRate)}`);

  // 2) 相对基线下降：没有 baseline 时跳过该检查（不生成 item，只记 warning）。
  if (baseline && baselineRate !== null) {
    const drop = candidateRate - baselineRate;
    const dropOk = drop + GATE_EPSILON >= -thresholds.maxPassRateDrop;
    items.push({
      name: "maxPassRateDrop",
      baseline: round(baselineRate),
      candidate: round(candidateRate),
      delta: round(drop),
      ok: dropOk,
      detail: `相对基线变化 ${fmtDelta(drop)}，允许下降 ≤${fmtRate(thresholds.maxPassRateDrop)}`,
    });
    if (!dropOk) reasons.push(`通过率相对基线下降 ${fmtRate(-drop)}，超过允许值 ${fmtRate(thresholds.maxPassRateDrop)}`);
  } else {
    warn("无基线：跳过相对下降检查（maxPassRateDrop）");
  }

  // 3) holdout 泛化：requireHoldout=true 时缺 holdout 或 holdout 为空/通过率不足都拒绝。
  const holdoutScored = holdout ? scoredResults(holdout) : [];
  if (!thresholds.requireHoldout) {
    warn("未要求 holdout（requireHoldout=false）");
    if (holdout) {
      items.push({
        name: "holdout",
        baseline: null,
        candidate: round(holdout.metrics.passRate),
        delta: null,
        ok: true,
        detail: `holdout 参考通过率 ${fmtRate(holdout.metrics.passRate)}（未要求，不参与判定）`,
      });
    }
  } else if (!holdout) {
    items.push({
      name: "holdout",
      baseline: null,
      candidate: null,
      delta: null,
      ok: false,
      detail: "要求 holdout 运行但缺失，无法验证泛化",
    });
    reasons.push("缺少 holdout 运行结果（requireHoldout=true）");
  } else if (holdoutScored.length === 0) {
    items.push({
      name: "holdout",
      baseline: null,
      candidate: round(holdout.metrics.passRate),
      delta: null,
      ok: false,
      detail: "holdout 运行没有有效计分用例（为空）",
    });
    reasons.push("holdout 运行结果为空，无法验证泛化能力");
  } else {
    const holdoutRate = holdout.metrics.passRate;
    const holdoutOk = holdoutRate + GATE_EPSILON >= thresholds.minHoldoutPassRate;
    items.push({
      name: "holdout",
      baseline: null,
      candidate: round(holdoutRate),
      delta: null,
      ok: holdoutOk,
      detail: `holdout 通过率 ${fmtRate(holdoutRate)}，阈值 ≥${fmtRate(thresholds.minHoldoutPassRate)}；计分用例 ${holdoutScored.length} 个`,
    });
    if (!holdoutOk) reasons.push(`holdout 通过率 ${fmtRate(holdoutRate)} 低于最低要求 ${fmtRate(thresholds.minHoldoutPassRate)}`);
  }

  // 4) 硬门槛类别：与 passRate 同口径，只统计非 skipped、非 exploratory 的失败
  //    （exploratory 用例按设计只用于发现新失败，含故意违规的负样本，不能阻断 Gate）。
  for (const category of thresholds.hardCategories) {
    const failed = candidateScored.filter((result) => result.category === category && !result.passed);
    const baselineFailed = baselineScored
      ? baselineScored.filter((result) => result.category === category && !result.passed).length
      : null;
    const hardOk = failed.length === 0;
    items.push({
      name: `hardCategory:${category}`,
      baseline: baselineFailed,
      candidate: failed.length,
      delta: baselineFailed === null ? null : failed.length - baselineFailed,
      ok: hardOk,
      detail: hardOk
        ? `硬门槛类别 ${category} 无失败用例`
        : `硬门槛类别 ${category} 出现 ${failed.length} 个失败：${failed.map((result) => result.caseId).sort(compareText).join(", ")}`,
    });
    if (!hardOk) {
      reasons.push(`硬门槛类别 ${category} 出现 ${failed.length} 个失败：${failed.map((result) => result.caseId).sort(compareText).join(", ")}`);
    }
    if (!candidateScored.some((result) => result.category === category)) {
      warn(`候选没有 ${category} 类别计分用例，硬门槛无法验证`);
    }
  }

  // 5) 可选预算门槛：平均单用例成本 / 平均单用例耗时。
  if (thresholds.maxAvgCostUsd !== undefined) {
    const computed = averageOf(candidateScored, (result) => result.usage.costUsd);
    const recorded = candidateScored.length > 0 ? candidate.metrics.totalCostUsd / candidateScored.length : 0;
    const candidateAvgCost = conservativeAvg(recorded, computed);
    const baselineAvgCost = baseline && baselineScored
      ? conservativeAvg(
        baselineScored.length > 0 ? baseline.metrics.totalCostUsd / baselineScored.length : 0,
        averageOf(baselineScored, (result) => result.usage.costUsd),
      )
      : null;
    const costOk = candidateAvgCost <= thresholds.maxAvgCostUsd + GATE_EPSILON;
    items.push({
      name: "maxAvgCostUsd",
      baseline: baselineAvgCost === null ? null : round(baselineAvgCost),
      candidate: round(candidateAvgCost),
      delta: baselineAvgCost === null ? null : round(candidateAvgCost - baselineAvgCost),
      ok: costOk,
      detail: `候选平均成本 $${candidateAvgCost.toFixed(4)}/用例，阈值 ≤$${thresholds.maxAvgCostUsd.toFixed(4)}`,
    });
    if (!costOk) reasons.push(`平均成本 $${candidateAvgCost.toFixed(4)}/用例 超过阈值 $${thresholds.maxAvgCostUsd.toFixed(4)}`);
  }
  if (thresholds.maxAvgDurationMs !== undefined) {
    const candidateAvgDuration = conservativeAvg(candidate.metrics.avgDurationMs, averageOf(candidateScored, (result) => result.durationMs));
    const baselineAvgDuration = baseline && baselineScored
      ? conservativeAvg(baseline.metrics.avgDurationMs, averageOf(baselineScored, (result) => result.durationMs))
      : null;
    const durationOk = candidateAvgDuration <= thresholds.maxAvgDurationMs + GATE_EPSILON;
    items.push({
      name: "maxAvgDurationMs",
      baseline: baselineAvgDuration === null ? null : round(baselineAvgDuration),
      candidate: round(candidateAvgDuration),
      delta: baselineAvgDuration === null ? null : round(candidateAvgDuration - baselineAvgDuration),
      ok: durationOk,
      detail: `候选平均耗时 ${Math.round(candidateAvgDuration)}ms/用例，阈值 ≤${thresholds.maxAvgDurationMs}ms`,
    });
    if (!durationOk) reasons.push(`平均耗时 ${Math.round(candidateAvgDuration)}ms/用例 超过阈值 ${thresholds.maxAvgDurationMs}ms`);
  }

  if (candidateScored.length === 0) warn("候选没有可计分用例（全部 skipped/exploratory）");
  else if (candidateScored.length < 10) warn(`候选计分用例仅 ${candidateScored.length} 个，通过率置信度有限`);

  return { passed: reasons.length === 0, reasons, items, warnings };
}
