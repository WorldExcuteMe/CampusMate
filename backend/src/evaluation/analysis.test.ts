// analysis.ts 单测：失败聚类、勾选回退、校准抽样确定性、渲染行数与内容。
// 构造最小 EvalRun/EvalResult，不依赖真实数据集与模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRun, calibrationSample, renderAnalysis } from "./analysis.ts";
import type {
  CheckResult, EvalManifest, EvalMetrics, EvalResult, EvalResultStatus, EvalRun, FailureCategory,
} from "./types.ts";

const ALL_CATEGORIES: FailureCategory[] = [
  "planning_error", "tool_selection_error", "tool_argument_error", "context_missing", "execution_recovery",
  "evidence_missing", "evidence_hallucination", "safety_violation", "side_effect_error", "format_error",
  "task_incomplete", "budget_exceeded", "runtime_error", "response_quality",
];

function check(kind: CheckResult["kind"], passed: boolean, label = "", id = `${kind}-1`): CheckResult {
  return { id, kind, label, passed, required: true, detail: "" };
}

interface ResultOptions {
  category?: string;
  status?: EvalResultStatus;
  holdout?: boolean;
  exploratory?: boolean;
  failureCategory?: FailureCategory;
  checks?: CheckResult[];
  replyPreview?: string;
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
    checks: options.checks ?? [],
    ...(options.failureCategory ? { failureCategory: options.failureCategory } : {}),
    durationMs: 100,
    usage: { tokens: 10, toolCalls: 1, costUsd: 0.001 },
    replyPreview: options.replyPreview ?? `${caseId} 的回复摘要`,
    toolSequence: [],
  };
}

function zeroMetrics(): EvalMetrics {
  return {
    total: 0, passed: 0, failed: 0, skipped: 0, exploratory: 0, passRate: 0,
    byCategory: {}, byDifficulty: {}, avgDurationMs: 0, avgTokens: 0, totalTokens: 0,
    avgToolCalls: 0, totalCostUsd: 0, failureCategories: {}, hardGateViolations: [],
  };
}

function makeRun(runId: string, results: EvalResult[]): EvalRun {
  const manifest: EvalManifest = {
    runId,
    target: "scripted",
    suites: ["core"],
    caseCount: results.length,
    createdAt: "2026-01-01T00:00:00.000Z",
    git: { commit: "abc123", branch: "main", dirty: false },
    node: "v24.0.0",
    model: { providerId: "mock", displayName: "Mock", modelId: "mock-1", real: false },
    systemPromptHash: "a".repeat(64),
    toolsHash: "b".repeat(64),
    datasetHashes: { core: "c".repeat(64) },
    concurrency: 2,
    offlineTools: true,
  };
  return {
    schemaVersion: 1,
    runId,
    target: "scripted",
    suites: ["core"],
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60000,
    manifest,
    metrics: zeroMetrics(),
    results,
  };
}

test("analyzeRun 按 failureCategory 聚类，caseIds/failedChecks/hint 可执行", () => {
  const run = makeRun("run-1", [
    result("case-a", false, {
      failureCategory: "context_missing",
      checks: [check("tool_called", false, "注入个人上下文后才能搜索", "ctx-1")],
      replyPreview: "不知道你的学期安排",
    }),
    result("case-b", false, {
      failureCategory: "context_missing",
      checks: [check("tool_called", false, "注入个人上下文后才能搜索", "ctx-1")],
    }),
    result("case-c", false, {
      failureCategory: "tool_selection_error",
      checks: [check("tool_called", false, "应调用 save_to_inbox", "sel-1")],
    }),
    result("case-d", true),
  ]);
  const analysis = analyzeRun(run);
  assert.equal(analysis.runId, "run-1");
  assert.equal(analysis.totalFailures, 3);
  assert.equal(analysis.clusters.length, 2);

  const [first, second] = analysis.clusters;
  assert.equal(first.category, "context_missing");
  assert.equal(first.count, 2);
  assert.deepEqual(first.caseIds, ["case-a", "case-b"]);
  assert.ok(first.failedChecks.some((text) => text.includes("注入个人上下文")));
  assert.ok(first.hint.includes("上下文"));
  assert.equal(second.category, "tool_selection_error");
  assert.equal(second.count, 1);

  assert.ok(analysis.optimizations.length > 0);
  assert.ok(analysis.optimizations.some((text) => text.includes("上下文注入")));
  assert.ok(analysis.optimizations.every((text) => text.includes("[")));
  // 通过用例进入校准样本（默认优先非 holdout 通过用例）。
  assert.ok(analysis.calibrationSample.some((sample) => sample.caseId === "case-d"));
});

test("failureCategory 缺失时按失败检查/状态推断类别", () => {
  const run = makeRun("run-infer", [
    result("case-evidence", false, { checks: [check("evidence_verified", false)] }),
    result("case-error", false, { status: "error" }),
    result("case-status", false, { checks: [check("status", false)] }),
  ]);
  const analysis = analyzeRun(run);
  const categories = new Set(analysis.clusters.map((cluster) => cluster.category));
  assert.ok(categories.has("evidence_missing"));
  assert.ok(categories.has("runtime_error"));
  assert.ok(categories.has("task_incomplete"));
  assert.equal(analysis.totalFailures, 3);
});

test("skipped 不计入失败；exploratory 失败仍纳入分析", () => {
  const run = makeRun("run-skips", [
    result("case-skip", false, { status: "skipped", failureCategory: "runtime_error" }),
    result("case-explore", false, { exploratory: true, failureCategory: "format_error" }),
    result("case-ok", true),
  ]);
  const analysis = analyzeRun(run);
  assert.equal(analysis.totalFailures, 1);
  assert.deepEqual(analysis.clusters.map((cluster) => cluster.category), ["format_error"]);
});

test("全部 FailureCategory 都有非空 hint 与至少一条规则化建议", () => {
  for (const category of ALL_CATEGORIES) {
    const analysis = analyzeRun(makeRun(`run-${category}`, [result(`case-${category}`, false, { failureCategory: category })]));
    assert.equal(analysis.clusters.length, 1, `未聚类：${category}`);
    assert.ok(analysis.clusters[0].hint.length >= 20, `hint 过短：${category}`);
    assert.ok(analysis.optimizations.length >= 1, `缺少建议：${category}`);
    assert.ok(analysis.optimizations[0].includes(category), `建议未标注类别：${category}`);
  }
});

test("calibrationSample 同 seed 确定，且优先非 holdout 通过用例", () => {
  const run = makeRun("run-sample", [
    result("pass-1", true),
    result("pass-2", true),
    result("pass-3", true),
    result("pass-holdout", true, { holdout: true }),
    result("fail-1", false, { failureCategory: "task_incomplete" }),
  ]);
  const first = calibrationSample(run, 3, 7);
  const second = calibrationSample(run, 3, 7);
  assert.deepEqual(first.map((entry) => entry.caseId), second.map((entry) => entry.caseId));
  assert.deepEqual(new Set(first.map((entry) => entry.caseId)), new Set(["pass-1", "pass-2", "pass-3"]));

  // holdout 只在非 holdout 样本不足时补足，且排在最后。
  const all = calibrationSample(run, 10, 7);
  assert.equal(all.length, 5);
  const holdoutIndex = all.findIndex((entry) => entry.caseId === "pass-holdout");
  assert.equal(holdoutIndex, 4);
  assert.ok(all.slice(0, 4).every((entry) => !entry.holdout));

  // 默认 seed 也保持确定性。
  assert.deepEqual(
    calibrationSample(run, 2).map((entry) => entry.caseId),
    calibrationSample(run, 2).map((entry) => entry.caseId),
  );
});

test("renderAnalysis 为紧凑纯文本（≤80 行）且含失败簇/建议/样本", () => {
  const run = makeRun("run-render", [
    result("case-a", false, {
      failureCategory: "evidence_missing",
      checks: [check("evidence_verified", false, "必须有可核验来源")],
      replyPreview: "见官网\n（未附来源）",
    }),
    result("case-b", true, { replyPreview: "已给出来源链接" }),
  ]);
  const text = renderAnalysis(analyzeRun(run));
  const lines = text.split("\n");
  assert.ok(lines.length <= 80, `渲染行数 ${lines.length} 超过 80`);
  assert.ok(text.includes("evidence_missing"));
  assert.ok(text.includes("优化建议"));
  assert.ok(text.includes("校准样本（2）"));
  assert.ok(text.includes("evidence_verified"));
  assert.ok(text.includes("见官网 （未附来源）") || lines.some((line) => line.includes("见官网")));
  for (const line of lines) assert.ok(!line.includes("\n"));
});

test("无失败时输出空簇与空建议，渲染给出明确结论", () => {
  const analysis = analyzeRun(makeRun("run-clean", [result("case-ok", true), result("case-ok-2", true)]));
  assert.equal(analysis.totalFailures, 0);
  assert.deepEqual(analysis.clusters, []);
  assert.deepEqual(analysis.optimizations, []);
  assert.equal(analysis.calibrationSample.length, 2);
  const text = renderAnalysis(analysis);
  assert.ok(text.includes("未发现失败用例"));
  assert.ok(text.split("\n").length <= 80);
});

test("analyzeRun 的 sampleSize 控制校准样本数量", () => {
  const run = makeRun("run-size", [result("a", true), result("b", true), result("c", true), result("d", true)]);
  assert.equal(analyzeRun(run, { sampleSize: 2 }).calibrationSample.length, 2);
  assert.equal(analyzeRun(run).calibrationSample.length, 4);
  assert.equal(analyzeRun(run, { sampleSize: 0 }).calibrationSample.length, 0);
});
