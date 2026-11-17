// reporter.test.ts —— 报告器单测：单行渲染、紧凑摘要、控制台 ≤25 行、Markdown 内容。
// 只用临时内存数据，不触碰真实运行目录。
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactSummary, renderCaseLine, renderConsoleSummary, renderMarkdown } from "./reporter.ts";
import type {
  CategoryMetrics, CheckResult, EvalManifest, EvalMetrics, EvalResult, EvalRun, TargetKind,
} from "./types.ts";

function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: "tool-called-1",
    kind: "tool_called",
    label: "调用 save_to_inbox",
    passed: true,
    required: true,
    detail: "实际调用 1 次",
    ...overrides,
  };
}

function makeResult(caseId: string, passed: boolean, overrides: Partial<EvalResult> = {}): EvalResult {
  const result: EvalResult = {
    caseId,
    category: "planning",
    difficulty: "medium",
    source: "fixed",
    target: "scripted",
    status: passed ? "succeeded" : "failed",
    passed,
    checks: [
      makeCheck({ passed }),
      makeCheck({ id: "reply-includes-2", kind: "reply_includes", label: "回复包含“已保存”", passed, detail: passed ? "命中关键词：已保存" : "未命中关键词：已保存" }),
    ],
    durationMs: passed ? 120 : 340,
    usage: { tokens: passed ? 100 : 200, toolCalls: passed ? 2 : 3, costUsd: 0.001 },
    replyPreview: passed ? "已保存到收件箱，截止时间周五。" : "抱歉，无法完成：save_to_inbox 未执行。",
    toolSequence: passed ? ["save_to_inbox"] : ["web_search", "save_to_inbox"],
    ...(passed
      ? {}
      : {
        failureCategory: "tool_selection_error",
        failureReason: "期望调用 save_to_inbox，实际未调用",
      }),
    ...overrides,
  };
  return result;
}

function makeMetrics(results: EvalResult[]): EvalMetrics {
  const emptyBucket = (): CategoryMetrics => ({ total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 });
  const byCategory: Record<string, CategoryMetrics> = {};
  const byDifficulty: Record<string, CategoryMetrics> = {};
  const failureCategories: Record<string, number> = {};
  let totalTokens = 0;
  let totalToolCalls = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  for (const result of results) {
    const categoryBucket = byCategory[result.category] ?? (byCategory[result.category] = emptyBucket());
    const difficultyBucket = byDifficulty[result.difficulty] ?? (byDifficulty[result.difficulty] = emptyBucket());
    for (const bucket of [categoryBucket, difficultyBucket]) {
      bucket.total += 1;
      if (result.status === "skipped") bucket.skipped += 1;
      else if (result.passed) bucket.passed += 1;
      else bucket.failed += 1;
    }
    if (result.failureCategory) failureCategories[result.failureCategory] = (failureCategories[result.failureCategory] ?? 0) + 1;
    totalTokens += result.usage.tokens;
    totalToolCalls += result.usage.toolCalls;
    totalCostUsd += result.usage.costUsd;
    totalDurationMs += result.durationMs;
  }
  for (const map of [byCategory, byDifficulty]) {
    for (const bucket of Object.values(map)) {
      const denominator = bucket.total - bucket.skipped;
      bucket.passRate = denominator > 0 ? bucket.passed / denominator : 0;
    }
  }
  const passed = results.filter((result) => result.passed).length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const exploratory = results.filter((result) => result.exploratory).length;
  const denominator = results.length - skipped - exploratory;
  const count = results.length || 1;
  return {
    total: results.length,
    passed,
    failed: results.length - passed - skipped,
    skipped,
    exploratory,
    passRate: denominator > 0 ? passed / denominator : 0,
    byCategory,
    byDifficulty,
    avgDurationMs: totalDurationMs / count,
    avgTokens: totalTokens / count,
    totalTokens,
    avgToolCalls: totalToolCalls / count,
    totalCostUsd,
    failureCategories,
    hardGateViolations: [],
  };
}

function makeRun(
  runId: string,
  results: EvalResult[],
  opts: { label?: string; target?: TargetKind; createdAt?: string } = {},
): EvalRun {
  const target = opts.target ?? "scripted";
  const createdAt = opts.createdAt ?? "2026-11-16T11:30:00.000Z";
  const manifest: EvalManifest = {
    runId,
    ...(opts.label ? { label: opts.label } : {}),
    target,
    suites: ["baseline"],
    caseCount: results.length,
    createdAt,
    git: { commit: "abc1234deadbeef", branch: "feature/eval", dirty: false },
    node: "v24.21.0",
    model: { providerId: "stub", displayName: "脚本模型", modelId: "scripted-v1", baseUrlHost: "localhost", real: false },
    systemPromptHash: "system-prompt-hash-001",
    toolsHash: "tools-hash-002",
    datasetHashes: { baseline: "dataset-hash-003" },
    concurrency: 2,
    offlineTools: true,
    seed: 42,
  };
  return {
    schemaVersion: 1,
    runId,
    ...(opts.label ? { label: opts.label } : {}),
    target,
    suites: ["baseline"],
    startedAt: createdAt,
    finishedAt: createdAt,
    durationMs: 460,
    manifest,
    metrics: makeMetrics(results),
    results,
  };
}

// ── renderCaseLine ─────────────────────────────────────────────────────────
test("renderCaseLine 输出状态/检查计数/耗时与失败检查", () => {
  const passedLine = renderCaseLine(makeResult("case-ok", true));
  assert.match(passedLine, /✅/);
  assert.match(passedLine, /case-ok/);
  assert.match(passedLine, /状态=succeeded/);
  assert.match(passedLine, /检查=2\/2/);
  assert.match(passedLine, /耗时=120ms/);

  const failedLine = renderCaseLine(makeResult("case-bad", false));
  assert.match(failedLine, /❌/);
  assert.match(failedLine, /case-bad/);
  assert.match(failedLine, /失败类别=tool_selection_error/);
  assert.match(failedLine, /失败检查=.*调用 save_to_inbox/);
  assert.match(failedLine, /tool_called/);
  assert.match(failedLine, /耗时=340ms/);

  const skippedLine = renderCaseLine(makeResult("case-skip", false, { status: "skipped", checks: [], skippedReason: "通道不适用" }));
  assert.match(skippedLine, /⏭/);
  assert.match(skippedLine, /跳过原因=通道不适用/);
});

// ── compactSummary ─────────────────────────────────────────────────────────
test("compactSummary 聚合失败用例并保留检查/工具序列/trace 路径；skipped 不算失败", () => {
  const failed = makeResult("case-bad", false, { tracePath: "C:\\runs\\x\\traces\\case-bad.json" });
  const skipped = makeResult("case-skip", false, { status: "skipped", checks: [], skippedReason: "通道不适用" });
  const run = makeRun("run-1", [makeResult("case-ok", true), failed, skipped], { label: "demo" });

  const summary = compactSummary(run, { reportPath: "C:\\runs\\x\\report.md", resultsPath: "C:\\runs\\x\\results.json" });
  assert.equal(summary.runId, "run-1");
  assert.equal(summary.label, "demo");
  assert.equal(summary.target, "scripted");
  assert.deepEqual(summary.suites, ["baseline"]);
  assert.equal(summary.failures.length, 1);
  const item = summary.failures[0];
  assert.equal(item.caseId, "case-bad");
  assert.equal(item.category, "planning");
  assert.equal(item.failureCategory, "tool_selection_error");
  assert.match(item.reason, /期望调用 save_to_inbox/);
  assert.equal(item.failedChecks.length, 2);
  assert.ok(item.failedChecks.some((label) => label.includes("调用 save_to_inbox") && label.includes("tool_called")));
  assert.deepEqual(item.toolSequence, ["web_search", "save_to_inbox"]);
  assert.equal(item.tracePath, "C:\\runs\\x\\traces\\case-bad.json");
  assert.equal(summary.reportPath, "C:\\runs\\x\\report.md");
  assert.equal(summary.resultsPath, "C:\\runs\\x\\results.json");
  assert.equal(summary.metrics.passed, 1);
});

test("compactSummary 失败最多保留 20 条；无 label 时不输出 label 字段", () => {
  const results: EvalResult[] = [];
  for (let i = 0; i < 25; i++) results.push(makeResult(`case-fail-${i}`, false));
  const summary = compactSummary(makeRun("run-many", results));
  assert.equal(summary.failures.length, 20);
  assert.equal(summary.failures[0].caseId, "case-fail-0");
  assert.equal(summary.failures[19].caseId, "case-fail-19");
  assert.equal("label" in summary, false);
  assert.equal("reportPath" in summary, false);
});

// ── renderConsoleSummary ───────────────────────────────────────────────────
test("renderConsoleSummary ≤25 行且包含通过率/失败簇/失败检查/工具序列/产物路径", () => {
  const results: EvalResult[] = [];
  for (let i = 0; i < 30; i++) results.push(makeResult(`case-fail-${i}`, false));
  for (let i = 0; i < 5; i++) results.push(makeResult(`case-ok-${i}`, true));
  const run = makeRun("run-console", results, { label: "console" });
  const summary = compactSummary(run, { reportPath: "C:\\runs\\console\\report.md", resultsPath: "C:\\runs\\console\\results.json" });
  const text = renderConsoleSummary(summary);
  const lines = text.split("\n");
  assert.ok(lines.length <= 25, `控制台摘要必须 ≤25 行，实际 ${lines.length} 行`);
  assert.match(text, /评测运行 run-console/);
  assert.match(text, /通过率=/);
  assert.match(text, /失败簇：.*tool_selection_error=30/);
  assert.match(text, /case-fail-0/);
  assert.match(text, /失败类别=tool_selection_error/);
  assert.match(text, /失败检查=.*tool_called/);
  assert.match(text, /工具序列=web_search → save_to_inbox/);
  assert.match(text, /报告：C:\\runs\\console\\report\.md/);
  assert.match(text, /结果：C:\\runs\\console\\results\.json/);
  // 20 条摘要里控制台只逐条展示 10 条，其余折叠。
  assert.match(text, /其余 10 条失败见报告/);
});

test("renderConsoleSummary 无失败时给出明确提示且 ≤25 行", () => {
  const summary = compactSummary(makeRun("run-clean", [makeResult("case-a", true), makeResult("case-b", true)]));
  const text = renderConsoleSummary(summary);
  assert.ok(text.split("\n").length <= 25);
  assert.match(text, /失败用例：无/);
  assert.match(text, /失败簇：无/);
  assert.match(text, /报告：（未提供）/);
});

// ── renderMarkdown ─────────────────────────────────────────────────────────
test("renderMarkdown 包含 manifest 摘要、指标表、分类/难度表、失败明细与通过清单", () => {
  const failed = makeResult("case-bad", false, {
    tracePath: "C:\\runs\\markdown\\traces\\case-bad.json",
    replyPreview: "无法完成：save_to_inbox 未执行，原因是工具选择错误。",
  });
  const run = makeRun("run-markdown", [makeResult("case-ok", true), failed]);
  const markdown = renderMarkdown(run);
  assert.match(markdown, /^# CampusMate 评测报告 · run-markdown/m);
  // manifest 摘要：模型/通道/git/哈希。
  assert.match(markdown, /scripted-v1/);
  assert.match(markdown, /目标通道 \| `scripted`/);
  assert.match(markdown, /abc1234deadbeef/);
  assert.match(markdown, /feature\/eval/);
  assert.match(markdown, /system-prompt-hash-001/);
  assert.match(markdown, /tools-hash-002/);
  assert.match(markdown, /baseline=dataset-hash-003/);
  // 指标表/分类表/难度表。
  assert.match(markdown, /## 总体指标/);
  assert.match(markdown, /\| 用例总数 \| 2 \|/);
  assert.match(markdown, /## 分类通过率/);
  assert.match(markdown, /\| planning \| 2 \| 1 \| 1 \| 0 \| 50\.0% \|/);
  assert.match(markdown, /## 难度分布/);
  assert.match(markdown, /\| medium \|/);
  // 失败明细：检查、工具序列、回复片段、trace 路径。
  assert.match(markdown, /## 失败用例（1）/);
  assert.match(markdown, /`case-bad`/);
  assert.match(markdown, /失败类别：tool_selection_error/);
  assert.match(markdown, /web_search → save_to_inbox/);
  assert.match(markdown, /C:\\runs\\markdown\\traces\\case-bad\.json/);
  assert.match(markdown, /回复片段/);
  assert.match(markdown, /无法完成：save_to_inbox 未执行/);
  assert.match(markdown, /失败检查/);
  assert.match(markdown, /（required）/);
  // 通过清单。
  assert.match(markdown, /## 通过用例（1）/);
  assert.match(markdown, /case-ok/);
  assert.match(markdown, /✅ case-ok/);
});

test("renderMarkdown 无失败时给出提示，并渲染跳过用例", () => {
  const skipped = makeResult("case-skip", false, {
    status: "skipped",
    checks: [],
    skippedReason: "该通道不支持此用例",
    replyPreview: "",
  });
  const run = makeRun("run-no-failure", [makeResult("case-ok", true), skipped]);
  const markdown = renderMarkdown(run);
  assert.match(markdown, /本轮没有失败用例/);
  assert.match(markdown, /## 跳过用例（1）/);
  assert.match(markdown, /跳过原因=该通道不支持此用例/);
  // skipped 不计入失败。
  assert.match(markdown, /## 失败用例（0）/);
});

test("renderMarkdown/控制台在 byCategory 缺失时从 results 兜底统计", () => {
  const results = [makeResult("case-a", true), makeResult("case-b", false)];
  const run = makeRun("run-fallback", results);
  const metricsWithoutGroups: EvalMetrics = { ...run.metrics, byCategory: {}, byDifficulty: {} };
  const fallbackRun: EvalRun = { ...run, metrics: metricsWithoutGroups };
  const markdown = renderMarkdown(fallbackRun);
  assert.match(markdown, /\| planning \| 2 \| 1 \| 1 \| 0 \| 50\.0% \|/);
  assert.match(markdown, /\| medium \|/);
  const text = renderConsoleSummary(compactSummary(fallbackRun));
  assert.match(text, /按类别：planning 1\/2\(50\.0%\)/);
});
