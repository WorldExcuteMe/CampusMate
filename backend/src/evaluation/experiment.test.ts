// experiment.ts 单测：manifest 指纹稳定性、gitInfo 降级形状、版本对比回归/修复、
// 以及回归 Gate 的通过路径与各类拒绝路径（绝对通过率、相对下降、holdout、硬门槛、预算）。
// 不依赖真实 git 状态（只断言字段存在与类型）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRuns, createManifest, evaluateGate, gitInfo } from "./experiment.ts";
import { sha256, stableStringify, suiteHash } from "./dataset.ts";
import { CAMPUS_SYSTEM } from "../core/system-prompt.ts";
import { CLOUD_TOOLS } from "../core/cloud-tools.ts";
import type {
  CategoryMetrics, EvalManifest, EvalMetrics, EvalResult, EvalResultStatus, EvalRun, EvalSuite, FailureCategory, TargetKind,
} from "./types.ts";

interface ResultOptions {
  category?: string;
  status?: EvalResultStatus;
  holdout?: boolean;
  exploratory?: boolean;
  failureCategory?: FailureCategory;
  durationMs?: number;
  costUsd?: number;
}

function result(caseId: string, passed: boolean, options: ResultOptions = {}): EvalResult {
  return {
    caseId,
    category: options.category ?? "research",
    difficulty: "easy",
    source: "fixed",
    ...(options.holdout ? { holdout: true } : {}),
    ...(options.exploratory ? { exploratory: true } : {}),
    target: "scripted",
    status: options.status ?? (passed ? "succeeded" : "failed"),
    passed,
    checks: [],
    ...(options.failureCategory ? { failureCategory: options.failureCategory } : {}),
    durationMs: options.durationMs ?? 100,
    usage: { tokens: 10, toolCalls: 1, costUsd: options.costUsd ?? 0.001 },
    replyPreview: `${caseId} 的回复摘要`,
    toolSequence: [],
  };
}

function scored(results: EvalResult[]): EvalResult[] {
  return results.filter((entry) => entry.status !== "skipped" && !entry.exploratory);
}

function metricsOf(results: EvalResult[]): EvalMetrics {
  const counted = scored(results);
  const passed = counted.filter((entry) => entry.passed).length;
  const byCategory: Record<string, CategoryMetrics> = {};
  for (const entry of results) {
    const metrics = byCategory[entry.category] ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 };
    metrics.total += 1;
    if (entry.status === "skipped") metrics.skipped += 1;
    else if (entry.passed) metrics.passed += 1;
    else metrics.failed += 1;
    byCategory[entry.category] = metrics;
  }
  for (const metrics of Object.values(byCategory)) {
    const denominator = metrics.total - metrics.skipped;
    metrics.passRate = denominator > 0 ? metrics.passed / denominator : 0;
  }
  return {
    total: results.length,
    passed,
    failed: counted.length - passed,
    skipped: results.filter((entry) => entry.status === "skipped").length,
    exploratory: results.filter((entry) => entry.exploratory).length,
    passRate: counted.length > 0 ? passed / counted.length : 0,
    byCategory,
    byDifficulty: {},
    avgDurationMs: counted.length > 0 ? counted.reduce((sum, entry) => sum + entry.durationMs, 0) / counted.length : 0,
    avgTokens: 0,
    totalTokens: 0,
    avgToolCalls: 0,
    totalCostUsd: counted.reduce((sum, entry) => sum + entry.usage.costUsd, 0),
    failureCategories: {},
    hardGateViolations: [],
  };
}

interface RunOptions {
  target?: TargetKind;
  label?: string;
  manifest?: Partial<EvalManifest>;
}

function makeRun(runId: string, results: EvalResult[], options: RunOptions = {}): EvalRun {
  const target = options.target ?? "scripted";
  const manifest: EvalManifest = {
    runId,
    target,
    suites: ["core"],
    caseCount: results.length,
    createdAt: "2026-01-01T00:00:00.000Z",
    git: { commit: "abc123", branch: "main", dirty: false },
    node: "v24.0.0",
    model: { providerId: "mock", displayName: "Mock", modelId: "mock-1", real: false },
    systemPromptHash: sha256("prompt"),
    toolsHash: sha256("tools"),
    datasetHashes: { core: sha256("suite") },
    concurrency: 2,
    offlineTools: true,
    ...options.manifest,
  };
  return {
    schemaVersion: 1,
    runId,
    ...(options.label !== undefined ? { label: options.label } : {}),
    target,
    suites: ["core"],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60000,
    manifest,
    metrics: metricsOf(results),
    results,
  };
}

function makeSuite(id: string, caseId: string): EvalSuite {
  return {
    schemaVersion: 1,
    id,
    name: id,
    cases: [
      { id: caseId, category: "research", difficulty: "easy", source: "fixed", prompt: `任务 ${caseId}`, checks: [{ kind: "status", in: ["succeeded"] }] },
    ],
  };
}

function manifestInput(suites: EvalSuite[], overrides: Partial<Parameters<typeof createManifest>[0]> = {}): Parameters<typeof createManifest>[0] {
  return {
    runId: "run-1",
    label: "基线",
    target: "scripted",
    suites,
    caseCount: suites.reduce((sum, suite) => sum + suite.cases.length, 0),
    model: { providerId: "mock", displayName: "Mock", modelId: "mock-1", real: false },
    concurrency: 2,
    offlineTools: true,
    seed: 42,
    notes: ["首轮"],
    ...overrides,
  };
}

// ── Manifest ────────────────────────────────────────────────────────────────
test("createManifest 记录真实 prompt/工具/数据集指纹且稳定", () => {
  const suite = makeSuite("core", "case-a");
  const input = manifestInput([suite]);
  const first = createManifest(input);
  const second = createManifest(input);

  assert.equal(first.runId, "run-1");
  assert.equal(first.label, "基线");
  assert.deepEqual(first.suites, ["core"]);
  assert.equal(first.caseCount, 1);
  assert.equal(first.node, process.version);
  assert.ok(!Number.isNaN(Date.parse(first.createdAt)));
  assert.equal(first.offlineTools, true);
  assert.equal(first.seed, 42);
  assert.deepEqual(first.notes, ["首轮"]);
  assert.equal(first.systemPromptHash, sha256(CAMPUS_SYSTEM));
  assert.equal(
    first.toolsHash,
    sha256(stableStringify(CLOUD_TOOLS.map((tool) => ({ name: tool.function.name, parameters: tool.function.parameters })))),
  );
  assert.equal(first.datasetHashes.core, suiteHash(suite));
  assert.match(first.systemPromptHash, /^[0-9a-f]{64}$/);
  assert.match(first.toolsHash, /^[0-9a-f]{64}$/);

  // 相同输入 → 指纹一致（createdAt/git 可变化，不参与比较）。
  assert.deepEqual(first.datasetHashes, second.datasetHashes);
  assert.equal(first.systemPromptHash, second.systemPromptHash);
  assert.equal(first.toolsHash, second.toolsHash);

  // git 字段只断言类型/存在，不依赖真实仓库状态。
  assert.equal(typeof first.git.commit, "string");
  assert.equal(typeof first.git.branch, "string");
  assert.equal(typeof first.git.dirty, "boolean");
});

test("数据集内容变化会改变 datasetHashes", () => {
  const first = createManifest(manifestInput([makeSuite("core", "case-a")]));
  const second = createManifest(manifestInput([makeSuite("core", "case-b")]));
  assert.notEqual(first.datasetHashes.core, second.datasetHashes.core);
  assert.equal(second.datasetHashes.core, suiteHash(makeSuite("core", "case-b")));
});

test("gitInfo 返回 {commit,branch,dirty} 且不抛出", () => {
  const info = gitInfo();
  assert.equal(typeof info.commit, "string");
  assert.ok(info.commit.length > 0);
  assert.equal(typeof info.branch, "string");
  assert.ok(info.branch.length > 0);
  assert.equal(typeof info.dirty, "boolean");
});

// ── compareRuns ─────────────────────────────────────────────────────────────
test("compareRuns 识别回归/修复/新增/删除，且排除 skipped 与 exploratory", () => {
  const baseline = makeRun("base", [
    result("case-a", true, { category: "planning" }),
    result("case-b", true, { category: "planning" }),
    result("case-c", false, { category: "research", failureCategory: "evidence_missing" }),
    result("case-removed", true, { category: "research" }),
  ]);
  const candidate = makeRun("cand", [
    result("case-a", true, { category: "planning" }),
    result("case-b", false, { category: "planning", failureCategory: "task_incomplete" }),
    result("case-c", true, { category: "research" }),
    result("case-new", false, { category: "research", failureCategory: "runtime_error" }),
    result("case-skipped", false, { status: "skipped" }),
    result("case-explore", false, { exploratory: true, category: "planning" }),
  ], {
    label: "候选",
    manifest: { model: { providerId: "mock", displayName: "Mock", modelId: "mock-2", real: false }, concurrency: 4 },
  });

  const comparison = compareRuns(baseline, candidate);
  assert.equal(comparison.baselineRunId, "base");
  assert.equal(comparison.candidateRunId, "cand");
  assert.equal(comparison.candidateLabel, "候选");
  assert.deepEqual(comparison.regressions, ["case-b"]);
  assert.deepEqual(comparison.improvements, ["case-c"]);
  assert.deepEqual(comparison.newCases, ["case-new"]);
  assert.deepEqual(comparison.removedCases, ["case-removed"]);

  // 口径：skipped/exploratory 不计入 overall 与 byCategory。
  assert.equal(comparison.overall.baseline, 0.75);
  assert.equal(comparison.overall.candidate, 0.5);
  assert.equal(comparison.overall.delta, -0.25);
  assert.equal(comparison.byCategory.planning.baseline, 1);
  assert.equal(comparison.byCategory.planning.candidate, 0.5);
  assert.equal(comparison.byCategory.research.baseline, 0.5);
  assert.equal(comparison.byCategory.research.candidate, 0.5);

  // manifestDiff 只记录变化字段。
  assert.deepEqual(comparison.manifestDiff.model, { baseline: "mock-1", candidate: "mock-2" });
  assert.deepEqual(comparison.manifestDiff.concurrency, { baseline: 2, candidate: 4 });
  assert.equal(comparison.manifestDiff.target, undefined);
  assert.equal(comparison.manifestDiff.systemPromptHash, undefined);
});

test("compareRuns manifestDiff 覆盖 prompt/工具/数据集/target 变化", () => {
  const baseline = makeRun("base", [result("case-a", true)]);
  const candidate = makeRun("cand", [result("case-a", true)], {
    target: "api-memory",
    manifest: { systemPromptHash: sha256("new-prompt"), toolsHash: sha256("new-tools"), datasetHashes: { core: sha256("new-suite") } },
  });
  const comparison = compareRuns(baseline, candidate);
  assert.ok(comparison.manifestDiff.systemPromptHash);
  assert.ok(comparison.manifestDiff.toolsHash);
  assert.ok(comparison.manifestDiff.datasetHashes);
  assert.deepEqual(comparison.manifestDiff.target, { baseline: "scripted", candidate: "api-memory" });
});

// ── evaluateGate ────────────────────────────────────────────────────────────
function passingRun(runId: string, caseCount = 12, category = "research"): EvalRun {
  const results: EvalResult[] = [];
  for (let i = 0; i < caseCount; i++) results.push(result(`case-${i}`, true, { category }));
  return makeRun(runId, results);
}

test("evaluateGate 所有门槛满足 → 通过，items 给出 baseline/candidate/delta/ok/detail", () => {
  const baseline = passingRun("base");
  const candidate = passingRun("cand");
  const holdout = passingRun("holdout", 5);
  const outcome = evaluateGate(candidate, baseline, { holdout });

  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.reasons, []);
  assert.ok(outcome.items.length > 0);
  assert.ok(outcome.items.every((item) => item.ok));
  for (const item of outcome.items) {
    assert.equal(typeof item.name, "string");
    assert.ok("baseline" in item);
    assert.ok("candidate" in item);
    assert.ok("delta" in item);
    assert.equal(typeof item.ok, "boolean");
    assert.equal(typeof item.detail, "string");
  }
  const minPass = outcome.items.find((item) => item.name === "minPassRate");
  assert.ok(minPass);
  assert.equal(minPass.baseline, 1);
  assert.equal(minPass.candidate, 1);
  assert.equal(minPass.delta, 0);
  assert.ok(outcome.items.some((item) => item.name === "holdout"));
  assert.ok(outcome.items.some((item) => item.name === "maxPassRateDrop"));
});

test("evaluateGate 绝对通过率不足 → 拒绝并给出中文原因", () => {
  const candidate = makeRun("cand", [result("a", true), result("b", false), result("c", false)]);
  const baseline = passingRun("base", 3);
  const outcome = evaluateGate(candidate, baseline, { holdout: passingRun("holdout", 3) });
  assert.equal(outcome.passed, false);
  assert.ok(outcome.reasons.some((reason) => reason.includes("通过率")));
  const item = outcome.items.find((entry) => entry.name === "minPassRate");
  assert.ok(item && item.ok === false);
});

test("evaluateGate 通过率相对基线下降超限 → 拒绝", () => {
  const baseline = passingRun("base", 10);
  const results = [result("case-0", false)];
  for (let i = 1; i < 10; i++) results.push(result(`case-${i}`, true));
  const candidate = makeRun("cand", results);
  const outcome = evaluateGate(candidate, baseline, { holdout: passingRun("holdout", 5) });
  assert.equal(outcome.passed, false);
  assert.ok(outcome.reasons.some((reason) => reason.includes("下降")));
  const item = outcome.items.find((entry) => entry.name === "maxPassRateDrop");
  assert.ok(item && item.ok === false);
  assert.ok((item.delta ?? 0) < 0);
});

test("evaluateGate 无 baseline 时跳过相对下降检查", () => {
  const candidate = passingRun("cand", 9);
  const outcome = evaluateGate(candidate, null, { holdout: passingRun("holdout", 3) });
  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.reasons, []);
  assert.equal(outcome.items.some((item) => item.name === "maxPassRateDrop"), false);
  assert.ok(outcome.warnings.some((warning) => warning.includes("无基线")));
});

test("evaluateGate requireHoldout 且缺 holdout → 拒绝", () => {
  const outcome = evaluateGate(passingRun("cand"), null);
  assert.equal(outcome.passed, false);
  assert.ok(outcome.reasons.some((reason) => reason.includes("holdout")));
  const item = outcome.items.find((entry) => entry.name === "holdout");
  assert.ok(item && item.ok === false);
});

test("evaluateGate requireHoldout=false 且无 holdout → 通过", () => {
  const outcome = evaluateGate(passingRun("cand"), null, { thresholds: { requireHoldout: false } });
  assert.equal(outcome.passed, true);
  assert.equal(outcome.items.some((item) => item.name === "holdout"), false);
  assert.ok(outcome.warnings.some((warning) => warning.includes("未要求 holdout")));
});

test("evaluateGate holdout 为空 → 拒绝（即使 minHoldoutPassRate=0）", () => {
  const emptyHoldout = makeRun("holdout", []);
  const outcome = evaluateGate(passingRun("cand"), null, {
    holdout: emptyHoldout,
    thresholds: { minHoldoutPassRate: 0, requireHoldout: true },
  });
  assert.equal(outcome.passed, false);
  assert.ok(outcome.reasons.some((reason) => reason.includes("为空")));
});

test("evaluateGate holdout 通过率低于阈值 → 拒绝", () => {
  const holdout = makeRun("holdout", [
    result("h-a", true), result("h-b", true), result("h-c", false), result("h-d", false),
  ]);
  const outcome = evaluateGate(passingRun("cand"), null, { holdout });
  assert.equal(outcome.passed, false);
  assert.ok(outcome.reasons.some((reason) => reason.includes("holdout 通过率")));
  const item = outcome.items.find((entry) => entry.name === "holdout");
  assert.ok(item && item.ok === false);
  assert.equal(item.candidate, 0.5);
});

test("evaluateGate 硬门槛类别出现失败 → 拒绝（即使总通过率达标）", () => {
  const results = [result("case-security", false, { category: "security", failureCategory: "safety_violation" })];
  for (let i = 0; i < 11; i++) results.push(result(`case-${i}`, true));
  const outcome = evaluateGate(makeRun("cand", results), null, { holdout: passingRun("holdout", 5) });
  assert.equal(outcome.passed, false);
  assert.ok(outcome.reasons.some((reason) => reason.includes("硬门槛") && reason.includes("security")));
  const item = outcome.items.find((entry) => entry.name === "hardCategory:security");
  assert.ok(item && item.ok === false);
  assert.equal(item.candidate, 1);
});

test("evaluateGate 硬门槛与 passRate 同口径：纯 exploratory 失败不拒绝，非 exploratory 失败必须拒绝", () => {
  // 数据集中 security 负样本（SEC-003/SEC-006）标 exploratory:true 且按设计必失败，不应阻断 Gate。
  const exploratoryOnly = [
    ...passingRun("x", 10).results,
    result("case-explore-security", false, { exploratory: true, category: "security", failureCategory: "safety_violation" }),
  ];
  const allowed = evaluateGate(makeRun("cand", exploratoryOnly), null, { holdout: passingRun("holdout", 5) });
  assert.equal(allowed.passed, true, `exploratory 负样本不应拒绝 Gate：${allowed.reasons.join("；")}`);
  const hardItem = allowed.items.find((item) => item.name === "hardCategory:security");
  assert.ok(hardItem && hardItem.ok === true);
  assert.equal(hardItem.candidate, 0);
  assert.ok(allowed.warnings.some((warning) => warning.includes("security") && warning.includes("硬门槛无法验证")));

  // 同一硬门槛类别下的正式（非 exploratory）失败必须拒绝。
  const formalFailure = [
    result("case-security", false, { category: "security", failureCategory: "safety_violation" }),
    ...passingRun("x", 11).results,
  ];
  const rejected = evaluateGate(makeRun("cand", formalFailure), null, { holdout: passingRun("holdout", 5) });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.reasons.some((reason) => reason.includes("硬门槛") && reason.includes("security") && reason.includes("case-security")));
  assert.equal(rejected.items.find((item) => item.name === "hardCategory:security")?.ok, false);
});

test("evaluateGate 可选成本/耗时门槛：超限拒绝、满足通过", () => {
  const slow = makeRun("slow", passingRun("x", 4).results.map((entry) => ({ ...entry, durationMs: 2000, usage: { ...entry.usage, costUsd: 0.02 } })));
  const exceeded = evaluateGate(slow, null, {
    holdout: passingRun("holdout", 3),
    thresholds: { requireHoldout: true, maxAvgCostUsd: 0.01, maxAvgDurationMs: 1000 },
  });
  assert.equal(exceeded.passed, false);
  assert.ok(exceeded.reasons.some((reason) => reason.includes("成本")));
  assert.ok(exceeded.reasons.some((reason) => reason.includes("耗时")));
  assert.equal(exceeded.items.find((item) => item.name === "maxAvgCostUsd")?.ok, false);
  assert.equal(exceeded.items.find((item) => item.name === "maxAvgDurationMs")?.ok, false);

  const withinBudget = evaluateGate(slow, null, {
    holdout: passingRun("holdout", 3),
    thresholds: { requireHoldout: true, maxAvgCostUsd: 0.05, maxAvgDurationMs: 3000 },
  });
  assert.equal(withinBudget.passed, true);
  assert.equal(withinBudget.items.find((item) => item.name === "maxAvgCostUsd")?.ok, true);
  assert.equal(withinBudget.items.find((item) => item.name === "maxAvgDurationMs")?.ok, true);
});

test("evaluateGate 支持 thresholds 部分覆盖默认值", () => {
  const candidate = makeRun("cand", [result("a", true), result("b", true), result("c", false), result("d", false)]);
  const rejectedByDefault = evaluateGate(candidate, null, { holdout: passingRun("holdout", 3) });
  assert.equal(rejectedByDefault.passed, false);

  const relaxed = evaluateGate(candidate, null, {
    thresholds: { minPassRate: 0.5, requireHoldout: false, maxPassRateDrop: 0.5 },
  });
  assert.equal(relaxed.passed, true);
});

test("evaluateGate 通过率只统计非 skipped、非 exploratory 用例", () => {
  const results = [
    ...passingRun("x", 9).results,
    result("case-skip", false, { status: "skipped" }),
    result("case-explore", false, { exploratory: true }),
  ];
  const outcome = evaluateGate(makeRun("cand", results), null, { holdout: passingRun("holdout", 3) });
  assert.equal(outcome.passed, true);
  const item = outcome.items.find((entry) => entry.name === "minPassRate");
  assert.ok(item && item.candidate === 1);
  assert.ok(outcome.warnings.some((warning) => warning.includes("计分用例仅 9")));
});
