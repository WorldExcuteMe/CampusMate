// Evaluation Runner：并发调度、每用例隔离、超时兜底、指标聚合、运行产物落盘。
// 设计原则：Runner 不理解业务；业务判定在 checks/evaluator；执行通道在 targets。
import path from "node:path";
import fs from "node:fs/promises";
import { createRunId, saveRun, runsRoot as defaultRunsRoot, type RunPaths } from "./store.ts";
import { compactSummary } from "./reporter.ts";
import { evaluateCase } from "./evaluator.ts";
import { createManifest } from "./experiment.ts";
import type {
  CompactRunSummary, EvalCase, EvalMetrics, EvalObservation, EvalResult, EvalRun, EvalSuite,
  EvalTarget, RunOptions, TargetKind,
} from "./types.ts";
import { DEFAULT_BUDGET, type TaskStatus } from "../core/types.ts";

export interface RunEvaluationOutput {
  run: EvalRun;
  dir: string;
  paths: RunPaths;
  summary: CompactRunSummary;
}

// 用例声明的适用通道；未声明则全部适用。
export function appliesToTarget(c: EvalCase, target: TargetKind): boolean {
  if (target === "legacy") return true;
  return !c.tiers || c.tiers.includes(target);
}

export function skippedResult(c: EvalCase, target: TargetKind, reason: string): EvalResult {
  return {
    caseId: c.id, category: c.category, difficulty: c.difficulty, source: c.source,
    ...(c.holdout ? { holdout: true } : {}), ...(c.exploratory ? { exploratory: true } : {}),
    target, status: "skipped", passed: false, skippedReason: reason, checks: [],
    durationMs: 0, usage: { tokens: 0, toolCalls: 0, costUsd: 0 }, replyPreview: "", toolSequence: [],
  };
}

function errorObservation(c: EvalCase, target: TargetKind, message: string, durationMs: number): EvalObservation {
  const emptyTrace = {
    caseId: c.id, target, startedAt: Date.now() - durationMs, finishedAt: Date.now(),
    events: [], llm: { requests: 0, rounds: [], models: [], telemetry: [] }, tools: [], steps: [],
    finalStatus: "error", finalOutput: "", error: message,
  };
  return {
    case: c, target, status: "error" as const, reply: "", toolCalls: [], trace: emptyTrace,
    business: { inbox: [], opportunities: [], pendingApprovals: 0, artifacts: [], evidenceVerified: 0 },
    usage: { tokens: 0, toolCalls: 0, wallMs: durationMs, costUsd: 0 },
    durationMs, mock: false, error: message,
  };
}

// 有界并发；保持结果顺序与输入一致。
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runEvaluation(options: RunOptions): Promise<RunEvaluationOutput> {
  const { suites, target, concurrency, timeoutMs } = options;
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const runId = createRunId(target.kind, options.label, startedAtMs);
  const root = options.runsRoot ?? defaultRunsRoot();
  const runDir = path.join(root, runId);
  await fs.mkdir(path.join(runDir, "traces"), { recursive: true });
  await fs.mkdir(path.join(runDir, "case-results"), { recursive: true });

  await target.setup({
    concurrency, defaultTimeoutMs: timeoutMs, offlineTools: options.offlineTools, artifactsDir: path.join(runDir, "artifacts"),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.providerId ? { providerId: options.providerId } : {}),
    ...(options.useSession ? { useSession: true } : {}),
    ...(options.durableStore ? { durableStore: options.durableStore } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.resumeUserId ? { resumeUserId: options.resumeUserId } : {}),
    now,
  });
  const description = target.describe();
  const traces = new Map<string, EvalObservation["trace"]>();
  const jobs = suites.flatMap((suite) => suite.cases.map((c) => ({ suite, c })));

  const results = await mapPool(jobs, concurrency, async ({ c }) => {
    if (!appliesToTarget(c, target.kind)) return skippedResult(c, target.kind, `用例仅适用于 ${c.tiers?.join("/")} 通道`);
    const caseStarted = now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observation: EvalObservation;
    let timedOut = false;
    const timeoutPromise = new Promise<null>((resolve) => { timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(null); }, timeoutMs); });
    const runPromise = target.run(c, { timeoutMs, signal: controller.signal });
    void runPromise.catch(() => { /* race 之外的残留异常不进入主流程 */ });
    try {
      const raced = await Promise.race([runPromise, timeoutPromise]);
      if (raced === null || timedOut) {
        // A deadline is still a failure. Give cooperative cancellation one
        // bounded second to return already collected turns/evidence instead
        // of replacing a whole long conversation with an empty error trace.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        const partial = await Promise.race([runPromise.catch(() => null), new Promise<null>(resolve => { cleanupTimer = setTimeout(() => resolve(null), 1000); })]);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        const message = `评测超时（${timeoutMs}ms）；已请求取消`;
        observation = partial ? { ...partial, status: "error", error: message, trace: { ...partial.trace, finalStatus: "error", error: message } } : errorObservation(c, target.kind, message, now() - caseStarted);
      } else {
        observation = raced;
      }
    } catch (error) {
      observation = errorObservation(c, target.kind, `执行通道异常：${error instanceof Error ? error.message : String(error)}`, now() - caseStarted);
    } finally {
      if (timer) clearTimeout(timer);
    }
    traces.set(c.id, observation.trace);
    const evaluation = await evaluateCase(c, observation, options.judge);
    const failedRequired = evaluation.checks.filter((check) => check.required && !check.passed);
    const passed = evaluation.passed && observation.status !== "error";
    const result = {
      caseId: c.id, category: c.category, difficulty: c.difficulty, source: c.source,
      ...(c.holdout ? { holdout: true } : {}), ...(c.exploratory ? { exploratory: true } : {}),
      target: target.kind, status: observation.status, passed,
      checks: evaluation.checks,
      ...(passed ? {} : evaluation.failureCategory ? { failureCategory: evaluation.failureCategory } : {}),
      ...(passed ? {} : { failureReason: evaluation.failureReason ?? (failedRequired.map((check) => `${check.label}: ${check.detail}`).join("；") || observation.error || "未通过") }),
      durationMs: observation.durationMs,
      usage: { tokens: observation.usage.tokens, toolCalls: observation.usage.toolCalls, costUsd: observation.usage.costUsd },
      replyPreview: observation.reply.replace(/\s+/g, " ").slice(0, 600),
      tracePath: path.join(runDir, "traces", `${c.id}.json`),
      toolSequence: observation.toolCalls.map((call) => call.approvalPending ? `${call.name}(approval)` : call.ok ? call.name : `${call.name}(error)`),
      turnCount: observation.turns?.length ?? 1,
    } satisfies EvalResult;
    // Long sessions can take many minutes. Keep each completed case and its
    // business facts even if a later case or the parent process is interrupted.
    await fs.writeFile(result.tracePath, JSON.stringify(observation.trace, null, 2));
    await fs.writeFile(path.join(runDir, "case-results", `${c.id}.json`), JSON.stringify({ result, business: observation.business, turns: observation.turns?.map(turn => ({ turn: turn.turn, taskId: turn.taskId, status: turn.status, business: turn.business })) }, null, 2));
    await fs.appendFile(path.join(runDir, "progress.jsonl"), JSON.stringify({ caseId: c.id, passed, status: result.status, exploratory: Boolean(c.exploratory), durationMs: result.durationMs, failureCategory: result.failureCategory }) + "\n");
    return result;
  });

  const metrics = computeMetrics(results);
  const finishedAtMs = now();
  const run: EvalRun = {
    schemaVersion: 1, runId, target: target.kind,
    ...(options.label ? { label: options.label } : {}),
    suites: suites.map((suite) => suite.id),
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    manifest: createManifest({
      runId, ...(options.label ? { label: options.label } : {}), target: target.kind,
      suites, caseCount: jobs.length, concurrency, offlineTools: options.offlineTools,
      model: description.model ?? { real: false },
      ...(options.reasoning || options.providerId || options.useSession ? { entry: {
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        ...(options.providerId ? { providerId: options.providerId } : {}),
        ...(options.useSession ? { useSession: true } : {}),
      } } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      notes: description.notes,
    }),
    metrics, results,
  };
  const saved = await saveRun(run, traces, { root, runIdOverride: runId });
  const summary = compactSummary(run, { reportPath: saved.paths.report, resultsPath: saved.paths.results });
  await target.dispose();
  return { run, dir: saved.dir, paths: saved.paths, summary };
}

export function computeMetrics(results: EvalResult[]): EvalMetrics {
  const counted = results.filter((r) => r.status !== "skipped" && !r.exploratory);
  const pushed = counted.filter((r) => r.passed);
  const rate = (rows: EvalResult[]) => rows.length ? rows.filter((r) => r.passed).length / rows.length : 0;
  const group = (key: (r: EvalResult) => string): Record<string, EvalMetrics["byCategory"][string]> => {
    const map: Record<string, EvalMetrics["byCategory"][string]> = {};
    for (const row of results) {
      // 与 passRate 同口径：skipped 与 exploratory 不进入类别通过率（探索性失败单列展示）。
      if (row.status === "skipped" || row.exploratory) continue;
      const name = key(row);
      const item = map[name] ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 };
      item.total++;
      if (row.passed) item.passed++; else item.failed++;
      item.passRate = item.total ? item.passed / item.total : 0;
      map[name] = item;
    }
    return map;
  };
  const failureCategories: Record<string, number> = {};
  for (const row of counted) if (!row.passed) {
    const name = row.failureCategory ?? "runtime_error";
    failureCategories[name] = (failureCategories[name] ?? 0) + 1;
  }
  const hardGateViolations: string[] = [];
  for (const row of results) {
    if (row.status === "skipped" || row.passed || row.exploratory) continue;
    if (["security", "evidence"].includes(row.category)) hardGateViolations.push(`${row.caseId}:${row.failureCategory ?? "unknown"}`);
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  return {
    total: results.length,
    passed: pushed.length,
    failed: counted.length - pushed.length,
    skipped: results.filter((r) => r.status === "skipped").length,
    exploratory: results.filter((r) => r.exploratory && r.status !== "skipped").length,
    passRate: rate(counted),
    byCategory: group((r) => r.category),
    byDifficulty: group((r) => r.difficulty),
    avgDurationMs: counted.length ? sum(counted.map((r) => r.durationMs)) / counted.length : 0,
    avgTokens: counted.length ? sum(counted.map((r) => r.usage.tokens)) / counted.length : 0,
    totalTokens: sum(results.map((r) => r.usage.tokens)),
    avgToolCalls: counted.length ? sum(counted.map((r) => r.usage.toolCalls)) / counted.length : 0,
    totalCostUsd: sum(results.map((r) => r.usage.costUsd)),
    failureCategories,
    hardGateViolations,
  };
}

// 默认预算给 live 通道用（CLI 可覆盖）。
export const EVAL_DEFAULT_BUDGET = DEFAULT_BUDGET;
export type { EvalSuite, TaskStatus };
