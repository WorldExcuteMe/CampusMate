// store.test.ts —— 运行产物存储单测：保存/加载/latest/前缀与 label 解析/索引更新/损坏恢复。
// 所有用例都使用 mkdtemp 临时目录，绝不写仓库 .local。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { DEFAULT_RUNS_ROOT } from "./dataset.ts";
import {
  createRunId, listRuns, loadRun, resolveRunDir, runPaths, runsRoot, saveRun,
} from "./store.ts";
import type { RunIndexEntry } from "./store.ts";
import type {
  CategoryMetrics, CheckResult, CompactRunSummary, EvalManifest, EvalMetrics, EvalResult, EvalRun,
  EvalTrace, TargetKind,
} from "./types.ts";

// ── 测试夹具 ────────────────────────────────────────────────────────────────
async function tmpRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "campusmate-eval-store-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function makeCheck(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    id: "status-1",
    kind: "status",
    label: "任务状态",
    passed: true,
    required: true,
    detail: "status=succeeded 命中",
    ...overrides,
  };
}

function makeResult(caseId: string, passed: boolean, overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    caseId,
    category: "planning",
    difficulty: "medium",
    source: "fixed",
    target: "scripted",
    status: passed ? "succeeded" : "failed",
    passed,
    checks: [makeCheck({ passed })],
    durationMs: passed ? 120 : 340,
    usage: { tokens: passed ? 100 : 200, toolCalls: 2, costUsd: 0.001 },
    replyPreview: passed ? "已保存到收件箱" : "抱歉，无法完成",
    toolSequence: passed ? ["save_to_inbox"] : ["web_search", "save_to_inbox"],
    ...(passed ? {} : { failureCategory: "tool_selection_error", failureReason: "期望调用 save_to_inbox，实际未调用" }),
    ...overrides,
  };
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
  opts: { label?: string; target?: TargetKind; createdAt?: string; suites?: string[] } = {},
): EvalRun {
  const target = opts.target ?? "scripted";
  const suites = opts.suites ?? ["baseline"];
  const createdAt = opts.createdAt ?? "2026-11-16T11:30:00.000Z";
  const manifest: EvalManifest = {
    runId,
    ...(opts.label ? { label: opts.label } : {}),
    target,
    suites,
    caseCount: results.length,
    createdAt,
    git: { commit: "abc1234deadbeef", branch: "feature/eval", dirty: false },
    node: "v24.21.0",
    model: { providerId: "stub", displayName: "脚本模型", modelId: "scripted-v1", real: false },
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
    suites,
    startedAt: createdAt,
    finishedAt: createdAt,
    durationMs: 460,
    manifest,
    metrics: makeMetrics(results),
    results,
  };
}

function makeTrace(caseId: string, overrides: Partial<EvalTrace> = {}): EvalTrace {
  return {
    caseId,
    target: "scripted",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    events: [{ seq: 1, type: "task.succeeded", payload: {}, at: 1_700_000_000_500 }],
    llm: { requests: 1, rounds: [{ round: 1, toolCalls: 1, finishReason: "stop" }], models: ["scripted-v1"], telemetry: [] },
    tools: [{ seq: 1, name: "save_to_inbox", args: { title: "测试" }, ok: true, resultPreview: "ok" }],
    steps: [{ kind: "act", title: "保存到收件箱" }],
    finalStatus: "succeeded",
    finalOutput: "已保存到收件箱",
    ...overrides,
  };
}

// ── 根目录 / runId / 路径 ──────────────────────────────────────────────────
test("runsRoot 优先 EVAL_RUNS_DIR，否则使用 DEFAULT_RUNS_ROOT", () => {
  const original = process.env.EVAL_RUNS_DIR;
  try {
    delete process.env.EVAL_RUNS_DIR;
    assert.equal(runsRoot(), DEFAULT_RUNS_ROOT);
    process.env.EVAL_RUNS_DIR = "C:\\temp\\eval-runs";
    assert.equal(runsRoot(), "C:\\temp\\eval-runs");
    process.env.EVAL_RUNS_DIR = "   ";
    assert.equal(runsRoot(), DEFAULT_RUNS_ROOT);
  } finally {
    if (original === undefined) delete process.env.EVAL_RUNS_DIR;
    else process.env.EVAL_RUNS_DIR = original;
  }
});

test("createRunId 用可注入 now 生成稳定时间戳并清理危险字符", () => {
  const now = new Date(2026, 10, 16, 19, 30, 12).getTime();
  const id = createRunId("api-memory", "Live 基线/回归", now);
  assert.ok(id.startsWith("20261116-193012_api-memory_live"), `实际 runId=${id}`);
  assert.match(id, /_[0-9a-f]{6}$/);
  assert.match(id, /^[a-z0-9\u4e00-\u9fa5._-]+$/);
  assert.ok(!id.includes("/"));
  assert.ok(!id.includes("\\"));

  const noLabel = createRunId("scripted", undefined, now);
  assert.match(noLabel, /^20261116-193012_scripted_[0-9a-f]{6}$/);

  // 危险字符（路径分隔符/上跳）必须被清洗掉。
  const weird = createRunId("..\\bad target", "../", now);
  assert.ok(!weird.includes("\\"), weird);
  assert.ok(!weird.includes("/"), weird);
  assert.ok(!weird.includes(".."), weird);
  assert.ok(weird.startsWith("20261116-193012_bad-target_"), weird);
});

test("runPaths 拼接完整产物路径", () => {
  const dir = path.join(tmpdir(), "campusmate-eval-runpaths");
  const paths = runPaths(dir);
  assert.equal(paths.dir, dir);
  assert.equal(paths.manifest, path.join(dir, "manifest.json"));
  assert.equal(paths.results, path.join(dir, "results.json"));
  assert.equal(paths.report, path.join(dir, "report.md"));
  assert.equal(paths.summary, path.join(dir, "summary.json"));
  assert.equal(paths.traces, path.join(dir, "traces"));
});

// ── saveRun ────────────────────────────────────────────────────────────────
test("saveRun 写全产物、回填绝对 tracePath，并更新 index/latest", async (t) => {
  const root = await tmpRoot(t);
  const passed = makeResult("case-ok", true);
  const failed = makeResult("case-bad", false);
  const run = makeRun("20261116-193012_scripted_demo_ab12cd", [passed, failed]);
  const traces = new Map<string, EvalTrace>([
    [passed.caseId, makeTrace(passed.caseId)],
    [failed.caseId, makeTrace(failed.caseId, { finalStatus: "failed" })],
  ]);
  const { dir, paths } = await saveRun(run, traces, { root });

  assert.equal(dir, path.join(root, run.runId));
  for (const file of [paths.manifest, paths.results, paths.report, paths.summary]) {
    assert.ok(existsSync(file), `缺少产物：${file}`);
  }

  const data = await readJsonFile<{ runId: string; target: string; suites: string[]; metrics: EvalMetrics; results: EvalResult[] }>(paths.results);
  assert.equal(data.runId, run.runId);
  assert.equal(data.target, "scripted");
  assert.deepEqual(data.suites, ["baseline"]);
  assert.equal(data.results.length, 2);
  for (const result of data.results) {
    assert.ok(result.tracePath, "results.json 必须回填 tracePath");
    assert.ok(path.isAbsolute(result.tracePath), `tracePath 必须是绝对路径：${result.tracePath}`);
    assert.equal(result.tracePath, path.join(paths.traces, `${result.caseId}.json`));
    assert.ok(existsSync(result.tracePath));
  }

  // trace 文件内容为 { caseId, ...trace }。
  const traceFile = await readJsonFile<{ caseId: string; finalStatus: string; tools: Array<{ name: string }> }>(data.results[0].tracePath!);
  assert.equal(traceFile.caseId, "case-ok");
  assert.equal(traceFile.finalStatus, "succeeded");
  assert.equal(traceFile.tools[0].name, "save_to_inbox");

  // report.md / summary.json 内容。
  const report = await readFile(paths.report, "utf8");
  assert.match(report, /# CampusMate 评测报告/);
  assert.match(report, /case-ok/);
  assert.match(report, /case-bad/);
  const summary = await readJsonFile<CompactRunSummary>(paths.summary);
  assert.equal(summary.runId, run.runId);
  assert.equal(summary.reportPath, paths.report);
  assert.equal(summary.resultsPath, paths.results);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].caseId, "case-bad");
  assert.equal(summary.failures[0].tracePath, data.results[1].tracePath);

  // index.json 条目。
  const index = await readJsonFile<RunIndexEntry[]>(path.join(root, "index.json"));
  assert.equal(index.length, 1);
  assert.equal(index[0].runId, run.runId);
  assert.equal(index[0].dir, dir);
  assert.equal(index[0].target, "scripted");
  assert.deepEqual(index[0].suites, ["baseline"]);
  assert.equal(index[0].passed, 1);
  assert.equal(index[0].total, 2);
  assert.equal(index[0].createdAt, run.manifest.createdAt);

  // latest.json。
  const latest = await readJsonFile<{ latest: string | null; latestLive: string | null }>(path.join(root, "latest.json"));
  assert.equal(latest.latest, run.runId);
  assert.equal(latest.latestLive, null);

  // loadRun("latest") 无损往返。
  const loaded = await loadRun("latest", { root });
  assert.equal(loaded.runId, run.runId);
  assert.equal(loaded.metrics.passRate, run.metrics.passRate);
  assert.equal(loaded.results.length, 2);
  assert.equal(loaded.results[0].tracePath, data.results[0].tracePath);
  assert.equal(loaded.manifest.model.modelId, "scripted-v1");
  assert.equal(loaded.manifest.git.commit, "abc1234deadbeef");
  assert.equal(loaded.manifest.systemPromptHash, "system-prompt-hash-001");
});

test("saveRun 对缺失 trace 的用例写占位说明且不崩溃（skipped 与已执行两种）", async (t) => {
  const root = await tmpRoot(t);
  const executed = makeResult("case-executed-no-trace", true);
  const skipped = makeResult("case-skip", false, {
    status: "skipped",
    checks: [],
    skippedReason: "该通道不适用",
    replyPreview: "",
  });
  const run = makeRun("20261116-193012_scripted_skip_ab12cd", [executed, skipped]);
  const { paths } = await saveRun(run, new Map(), { root });

  const skippedTrace = path.join(paths.traces, "case-skip.json");
  assert.ok(existsSync(skippedTrace));
  const placeholder = await readJsonFile<{ caseId: string; skipped: boolean; skippedReason: string; note: string }>(skippedTrace);
  assert.equal(placeholder.caseId, "case-skip");
  assert.equal(placeholder.skipped, true);
  assert.match(placeholder.skippedReason, /该通道不适用/);
  assert.match(placeholder.note, /跳过说明占位/);

  const executedTrace = path.join(paths.traces, "case-executed-no-trace.json");
  assert.ok(existsSync(executedTrace));
  const executedPlaceholder = await readJsonFile<{ skipped: boolean; traceAvailable: boolean; note: string }>(executedTrace);
  assert.equal(executedPlaceholder.skipped, false);
  assert.equal(executedPlaceholder.traceAvailable, false);
  assert.match(executedPlaceholder.note, /占位说明/);

  const data = await readJsonFile<{ results: EvalResult[] }>(paths.results);
  assert.equal(data.results[0].tracePath, executedTrace);
  assert.equal(data.results[1].tracePath, skippedTrace);
  const loaded = await loadRun("latest", { root });
  assert.equal(loaded.results[1].status, "skipped");
  assert.equal(loaded.results[1].skippedReason, "该通道不适用");
});

test("saveRun 的 runIdOverride 决定目录名并回写 manifest/runId", async (t) => {
  const root = await tmpRoot(t);
  const run = makeRun("run-original", [makeResult("case-a", true)]);
  const { dir, paths } = await saveRun(run, new Map(), { root, runIdOverride: "run-override-001" });
  assert.equal(dir, path.join(root, "run-override-001"));
  const manifest = await readJsonFile<EvalManifest>(paths.manifest);
  assert.equal(manifest.runId, "run-override-001");
  const loaded = await loadRun("run-override-001", { root });
  assert.equal(loaded.runId, "run-override-001");
  assert.equal(loaded.manifest.runId, "run-override-001");
});

test("同一 runId 重复保存只保留一条索引条目", async (t) => {
  const root = await tmpRoot(t);
  const run = makeRun("run-repeat", [makeResult("case-a", true)]);
  await saveRun(run, new Map(), { root });
  await saveRun(run, new Map(), { root });
  const index = await readJsonFile<RunIndexEntry[]>(path.join(root, "index.json"));
  assert.equal(index.length, 1);
  assert.equal(index[0].runId, "run-repeat");
});

// ── latest / latest-live ───────────────────────────────────────────────────
test("latest 指向最近运行的 run，latest-live 指向最近的 live 运行", async (t) => {
  const root = await tmpRoot(t);
  const scripted = makeRun("run-scripted-1", [makeResult("case-a", true)], { createdAt: "2026-11-16T01:00:00.000Z" });
  const live = makeRun(
    "run-live-1",
    [makeResult("case-b", true, { target: "live", category: "live" })],
    { target: "live", createdAt: "2026-11-16T02:00:00.000Z" },
  );
  const newer = makeRun("run-scripted-2", [makeResult("case-c", true)], { createdAt: "2026-11-16T03:00:00.000Z" });
  await saveRun(scripted, new Map(), { root });
  await saveRun(live, new Map(), { root });
  await saveRun(newer, new Map(), { root });

  assert.equal((await loadRun("latest", { root })).runId, newer.runId);
  assert.equal((await loadRun("latest-live", { root })).runId, live.runId);

  const latest = await readJsonFile<{ latest: string | null; latestLive: string | null }>(path.join(root, "latest.json"));
  assert.equal(latest.latest, newer.runId);
  assert.equal(latest.latestLive, live.runId);
  assert.equal(resolveRunDir("latest", { root }), path.join(root, newer.runId));
  assert.equal(resolveRunDir("latest-live", { root }), path.join(root, live.runId));
});

test("没有 live 运行时 latest-live 给出清晰错误", async (t) => {
  const root = await tmpRoot(t);
  const run = makeRun("run-scripted-only", [makeResult("case-a", true)]);
  await saveRun(run, new Map(), { root });
  await assert.rejects(loadRun("latest-live", { root }), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /未找到评测运行：latest-live/);
    assert.match(message, /live/);
    return true;
  });
});

// ── loadRun 引用解析 ───────────────────────────────────────────────────────
test("loadRun 支持完整 runId / 唯一前缀 / 唯一 label / 目录路径", async (t) => {
  const root = await tmpRoot(t);
  const runA = makeRun(
    "20261116-193012_scripted_alpha_aaaaaa",
    [makeResult("case-a", true)],
    { label: "alpha", createdAt: "2026-11-16T01:00:00.000Z" },
  );
  const runB = makeRun(
    "20261116-193013_scripted_beta_bbbbbb",
    [makeResult("case-b", false)],
    { label: "beta", createdAt: "2026-11-16T02:00:00.000Z" },
  );
  const savedA = await saveRun(runA, new Map(), { root });
  await saveRun(runB, new Map(), { root });

  assert.equal((await loadRun(runA.runId, { root })).runId, runA.runId);
  assert.equal((await loadRun("20261116-193012", { root })).runId, runA.runId);
  assert.equal((await loadRun("beta", { root })).runId, runB.runId);
  assert.equal((await loadRun(savedA.dir, { root })).runId, runA.runId);
  assert.equal((await loadRun(path.relative(process.cwd(), savedA.dir), { root })).runId, runA.runId);
  assert.equal(resolveRunDir(runB.runId, { root }), path.join(root, runB.runId));
});

test("loadRun 前缀/label 不唯一时报错并列出候选", async (t) => {
  const root = await tmpRoot(t);
  const runA = makeRun("20261116-193012_scripted_alpha_aaaaaa", [makeResult("case-a", true)], { label: "same", createdAt: "2026-11-16T01:00:00.000Z" });
  const runB = makeRun("20261116-193013_scripted_beta_bbbbbb", [makeResult("case-b", true)], { label: "same", createdAt: "2026-11-16T02:00:00.000Z" });
  await saveRun(runA, new Map(), { root });
  await saveRun(runB, new Map(), { root });

  await assert.rejects(loadRun("20261116-19301", { root }), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /前缀不唯一/);
    assert.match(message, new RegExp(runA.runId));
    assert.match(message, new RegExp(runB.runId));
    return true;
  });
  await assert.rejects(loadRun("same", { root }), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /label 不唯一/);
    assert.match(message, new RegExp(runA.runId));
    assert.match(message, new RegExp(runB.runId));
    return true;
  });
});

test("loadRun 找不到时报告根目录与最近运行", async (t) => {
  const root = await tmpRoot(t);
  const run = makeRun("run-recent", [makeResult("case-a", true)]);
  await saveRun(run, new Map(), { root });

  await assert.rejects(loadRun("no-such-run", { root }), (error: unknown) => {
    const message = (error as Error).message;
    assert.match(message, /未找到评测运行：no-such-run/);
    assert.match(message, /最近运行/);
    assert.match(message, new RegExp(run.runId));
    assert.match(message, /latest/);
    return true;
  });
});

test("空根目录：listRuns 返回空数组，loadRun 提示还没有运行记录", async (t) => {
  const root = await tmpRoot(t);
  assert.deepEqual(await listRuns({ root }), []);
  await assert.rejects(loadRun("latest", { root }), /还没有任何运行记录/);
});

// ── index 排序 / listRuns ──────────────────────────────────────────────────
test("index.json 按 createdAt 倒序排列，latest 取其中最新一条", async (t) => {
  const root = await tmpRoot(t);
  const older = makeRun("run-a-older", [makeResult("case-a", true)], { createdAt: "2026-11-16T01:00:00.000Z" });
  const newest = makeRun("run-b-newest", [makeResult("case-b", true)], { createdAt: "2026-11-16T03:00:00.000Z" });
  const middle = makeRun("run-c-middle", [makeResult("case-c", true)], { createdAt: "2026-11-16T02:00:00.000Z" });
  // 故意用「老→新→中」的保存顺序，验证按 createdAt 而不是保存顺序排序。
  await saveRun(older, new Map(), { root });
  await saveRun(newest, new Map(), { root });
  await saveRun(middle, new Map(), { root });

  const index = await readJsonFile<RunIndexEntry[]>(path.join(root, "index.json"));
  assert.deepEqual(index.map((entry) => entry.runId), ["run-b-newest", "run-c-middle", "run-a-older"]);

  const runs = await listRuns({ root });
  assert.deepEqual(runs.map((entry) => entry.runId), ["run-b-newest", "run-c-middle", "run-a-older"]);
  assert.equal(runs[0].createdAt, "2026-11-16T03:00:00.000Z");
  assert.equal(runs[0].dir, path.join(root, "run-b-newest"));
  const latest = await readJsonFile<{ latest: string | null }>(path.join(root, "latest.json"));
  assert.equal(latest.latest, "run-b-newest");
  assert.equal((await loadRun("latest", { root })).runId, "run-b-newest");
});

// ── 损坏 / 缺失索引的恢复 ─────────────────────────────────────────────────
test("index/latest 损坏时 saveRun 仍成功并重建有效索引", async (t) => {
  const root = await tmpRoot(t);
  await writeFile(path.join(root, "index.json"), "这不是 JSON", "utf8");
  await writeFile(path.join(root, "latest.json"), "{broken", "utf8");
  const run = makeRun("run-corrupt-recovery", [makeResult("case-a", true)]);
  const { paths } = await saveRun(run, new Map(), { root });

  const index = await readJsonFile<RunIndexEntry[]>(path.join(root, "index.json"));
  assert.equal(index.length, 1);
  assert.equal(index[0].runId, run.runId);
  const latest = await readJsonFile<{ latest: string | null }>(path.join(root, "latest.json"));
  assert.equal(latest.latest, run.runId);
  assert.equal((await loadRun("latest", { root })).runId, run.runId);
  assert.equal((await loadRun(run.runId, { root })).results[0].tracePath, path.join(paths.traces, "case-a.json"));
});

test("index/latest 缺失时 listRuns/loadRun 通过扫描 run 目录恢复", async (t) => {
  const root = await tmpRoot(t);
  const run = makeRun("run-scan-recovery", [makeResult("case-a", true), makeResult("case-b", false)]);
  await saveRun(run, new Map(), { root });
  await rm(path.join(root, "index.json"), { force: true });
  await rm(path.join(root, "latest.json"), { force: true });

  const runs = await listRuns({ root });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, run.runId);
  assert.equal(runs[0].total, 2);
  assert.equal(runs[0].passed, 1);
  assert.equal((await loadRun("latest", { root })).runId, run.runId);
  assert.equal((await loadRun(run.runId, { root })).runId, run.runId);
  assert.equal(resolveRunDir(run.runId, { root }), path.join(root, run.runId));
});

test("results.json 手工写成纯数组时 loadRun 仍可读取（兼容模式）", async (t) => {
  const root = await tmpRoot(t);
  const run = makeRun("run-legacy-results", [makeResult("case-a", true)]);
  const { paths } = await saveRun(run, new Map(), { root });
  const data = await readJsonFile<{ results: EvalResult[] }>(paths.results);
  await writeFile(paths.results, JSON.stringify(data.results, null, 2), "utf8");

  const loaded = await loadRun(run.runId, { root });
  assert.equal(loaded.runId, run.runId);
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.results[0].caseId, "case-a");
});
