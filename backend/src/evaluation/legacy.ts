// 既有 30 任务 scripted benchmark 的兼容适配：映射为统一 EvalRun，保留 CI 旧入口语义。
// 注意：该套件只验证 Agent Core 行为契约（脚本模型 + mock 工具），不是真实模型成功率。
import { runAll } from "../../tests/agent-benchmark/runner.ts";
import type { BenchmarkResult } from "../../tests/agent-benchmark/types.ts";
import { computeMetrics } from "./runner.ts";
import { createRunId, runsRoot, saveRun } from "./store.ts";
import { compactSummary } from "./reporter.ts";
import { createManifest } from "./experiment.ts";
import { sha256 } from "./dataset.ts";
import { CAMPUS_SYSTEM } from "../core/system-prompt.ts";
import { CLOUD_TOOLS } from "../core/cloud-tools.ts";
import type { CompactRunSummary, EvalResult, EvalRun, EvalSuite } from "./types.ts";

function mapResult(result: BenchmarkResult): EvalResult {
  const status = result.status === "BLOCKED_EXTERNAL" ? "skipped" : result.passed ? "succeeded" : "failed";
  return {
    caseId: result.id, category: result.category, difficulty: "medium", source: "fixed",
    target: "legacy", status, passed: result.passed,
    ...(status === "skipped" ? { skippedReason: result.failureReason ?? "需外部真实环境" } : {}),
    checks: result.checks.map((check) => ({ id: check.name, kind: "runtime", label: check.name, passed: check.passed, required: check.required, detail: check.passed ? "通过" : "未通过" })),
    ...(result.passed ? {} : { failureCategory: classifyLegacy(result), failureReason: result.failureReason ?? "未通过" }),
    durationMs: result.durationMs,
    usage: { tokens: 0, toolCalls: result.toolCalls, costUsd: result.costUsd },
    replyPreview: "", toolSequence: [],
  };
}

function classifyLegacy(result: BenchmarkResult): EvalResult["failureCategory"] {
  const reason = result.failureReason ?? "";
  if (/预算/.test(reason)) return "budget_exceeded";
  if (/降级|传输|连接/.test(reason)) return "runtime_error";
  if (/失败|错误/.test(reason)) return "execution_recovery";
  return "task_incomplete";
}

export async function runLegacyBenchmark(opts: { label?: string; runsRootDir?: string } = {}): Promise<{ run: EvalRun; summary: CompactRunSummary; dir: string }> {
  const startedAt = Date.now();
  const runId = createRunId("legacy", opts.label, startedAt);
  const legacy = await runAll();
  const results = legacy.map(mapResult);
  const finishedAt = Date.now();
  const pseudoSuite: EvalSuite = { schemaVersion: 1, id: "benchmark-30", name: "既有 30 任务确定性基准（兼容）", cases: [] };
  const run: EvalRun = {
    schemaVersion: 1, runId, target: "legacy",
    ...(opts.label ? { label: opts.label } : {}),
    suites: [pseudoSuite.id],
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    manifest: createManifest({
      runId, ...(opts.label ? { label: opts.label } : {}), target: "legacy", suites: [pseudoSuite],
      caseCount: results.length, concurrency: 1, offlineTools: true,
      model: { real: false, providerId: "scripted", modelId: "scripted-model" },
      notes: [
        "兼容入口：既有 tests/agent-benchmark 30 任务；脚本化模型 + mock 工具",
        `systemPromptHash=${sha256(CAMPUS_SYSTEM).slice(0, 12)} tools=${CLOUD_TOOLS.length}`,
      ],
    }),
    metrics: computeMetrics(results),
    results,
  };
  const saved = await saveRun(run, new Map(), { root: opts.runsRootDir ?? runsRoot(), runIdOverride: runId });
  const summary = compactSummary(run, { reportPath: saved.paths.report, resultsPath: saved.paths.results });
  return { run, summary, dir: saved.dir };
}
