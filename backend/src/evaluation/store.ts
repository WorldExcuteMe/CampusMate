// 评测运行产物存储：run 目录（manifest/results/traces/summary/report）+ index/latest 索引。
// 设计边界：
// - 运行产物默认落在仓库 .local/eval（gitignored），可用 EVAL_RUNS_DIR 覆盖；测试必须用临时目录。
// - 只做文件读写与引用解析，不做评测判定；报告渲染委托 reporter.ts（单向依赖，避免循环）。
// - index.json / latest.json 用「读-改-写 + 原子替换 + 失败重试一次」，不引入锁文件。
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RUNS_ROOT } from "./dataset.ts";
import { compactSummary, renderMarkdown } from "./reporter.ts";
import type {
  CategoryMetrics, CompactRunSummary, EvalManifest, EvalMetrics, EvalResult, EvalRun, EvalTrace,
  TargetKind,
} from "./types.ts";

// ── 路径 ────────────────────────────────────────────────────────────────────
export interface RunPaths {
  dir: string;
  manifest: string;
  results: string;
  report: string;
  summary: string;
  traces: string;
}

export function runsRoot(): string {
  const env = process.env.EVAL_RUNS_DIR;
  if (env && env.trim()) return env.trim();
  return DEFAULT_RUNS_ROOT;
}

function resolveRoot(opts?: { root?: string }): string {
  return path.resolve(opts?.root ?? runsRoot());
}

export function runPaths(dir: string): RunPaths {
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    results: path.join(dir, "results.json"),
    report: path.join(dir, "report.md"),
    summary: path.join(dir, "summary.json"),
    traces: path.join(dir, "traces"),
  };
}

// runId / 文件名安全化：保留 ASCII 字母数字、中文、点下划线连字符，其余替换成连字符。
// maxLength=0 表示不截断（runId 目录名必须完整，只有 createRunId 的片段才截断）。
function sanitizeName(input: string, maxLength = 0): string {
  let slug = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (maxLength > 0) {
    slug = slug.slice(0, maxLength).replace(/^[-._]+|[-._]+$/g, "");
  }
  return slug;
}

// caseId 用于 trace 文件名；损坏字符替换为下划线，保证跨平台可写。
function safeCaseId(caseId: string): string {
  const safe = String(caseId ?? "")
    .trim()
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return safe || "case";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// 形如 20261116-193012_api-memory_live基线_ab12cd；now 可注入以保证测试可复现。
export function createRunId(target: string, label?: string, now: number = Date.now()): string {
  const date = new Date(now);
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const parts = [stamp, sanitizeName(target, 24) || "target"];
  const labelSlug = label ? sanitizeName(label, 24) : "";
  if (labelSlug) parts.push(labelSlug);
  parts.push(randomBytes(3).toString("hex"));
  return parts.join("_");
}

// ── 通用 JSON 读写 ──────────────────────────────────────────────────────────
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

type JsonFallback<T> = T | (() => Promise<T> | T);

async function readJson<T>(file: string, fallback: JsonFallback<T>): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    // 文件缺失或 JSON 损坏都按 fallback 处理；损坏的索引不应阻断保存/加载。
    // fallback 支持函数形式，便于「索引损坏时扫描 run 目录重建」这类惰性兜底。
    return typeof fallback === "function" ? await (fallback as () => Promise<T> | T)() : fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// 先写临时文件再 rename，避免读到半截 JSON。
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

// 读-改-写：失败（含解析/写入异常）后等待一小段时间并重试一次；不使用锁文件。
async function updateJsonWithRetry<T>(file: string, fallback: JsonFallback<T>, mutate: (current: T) => T): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = await readJson<T>(file, fallback);
      const next = mutate(current);
      await writeJsonAtomic(file, next);
      return next;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`写入 ${file} 失败（已重试一次）：${message}`, { cause: lastError });
}

// ── 产物结构 ────────────────────────────────────────────────────────────────
// results.json 内容：结果数组 + 运行级字段（manifest 单独存，便于 loadRun 无损重建 EvalRun）。
interface RunDataFile {
  schemaVersion: 1;
  runId: string;
  label?: string;
  target: TargetKind;
  suites: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metrics: EvalMetrics;
  results: EvalResult[];
}

export interface RunIndexEntry {
  runId: string;
  target: TargetKind;
  label?: string;
  suites: string[];
  passed: number;
  total: number;
  passRate: number;
  createdAt: string;
  dir: string;
}

export interface LatestRuns {
  latest: string | null;
  latestLive: string | null;
}

function entryFromRun(run: EvalRun, dir: string): RunIndexEntry {
  return {
    runId: run.runId,
    target: run.target,
    ...(run.label ? { label: run.label } : {}),
    suites: run.suites,
    passed: run.metrics.passed,
    // 与 passRate 同口径：只统计计分用例（排除 skipped/exploratory）。
    total: run.metrics.passed + run.metrics.failed,
    passRate: run.metrics.passRate,
    createdAt: run.manifest?.createdAt || run.startedAt,
    dir: path.resolve(dir),
  };
}

function sortEntriesDesc(entries: RunIndexEntry[]): RunIndexEntry[] {
  return [...entries].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || b.runId.localeCompare(a.runId));
}

// 兜底指标：仅在 results.json/summary.json 都缺 metrics 时使用。
function fallbackMetrics(results: EvalResult[]): EvalMetrics {
  const passed = results.filter((result) => result.passed).length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const exploratory = results.filter((result) => result.exploratory).length;
  const failed = results.length - passed - skipped;
  const denominator = results.length - skipped - exploratory;
  const byCategory: Record<string, CategoryMetrics> = {};
  const byDifficulty: Record<string, CategoryMetrics> = {};
  const failureCategories: Record<string, number> = {};
  let totalTokens = 0;
  let totalToolCalls = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  const bucket = (map: Record<string, CategoryMetrics>, key: string): CategoryMetrics => {
    const current = map[key] ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 };
    map[key] = current;
    return current;
  };
  for (const result of results) {
    for (const map of [bucket(byCategory, result.category), bucket(byDifficulty, result.difficulty)]) {
      map.total += 1;
      if (result.status === "skipped") map.skipped += 1;
      else if (result.passed) map.passed += 1;
      else map.failed += 1;
    }
    if (result.failureCategory) failureCategories[result.failureCategory] = (failureCategories[result.failureCategory] ?? 0) + 1;
    totalTokens += result.usage?.tokens ?? 0;
    totalToolCalls += result.usage?.toolCalls ?? 0;
    totalCostUsd += result.usage?.costUsd ?? 0;
    totalDurationMs += result.durationMs ?? 0;
  }
  for (const map of [byCategory, byDifficulty]) {
    for (const metrics of Object.values(map)) {
      const categoryDenominator = metrics.total - metrics.skipped;
      metrics.passRate = categoryDenominator > 0 ? metrics.passed / categoryDenominator : 0;
    }
  }
  const count = results.length || 1;
  return {
    total: results.length,
    passed,
    failed,
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

// ── 保存运行 ────────────────────────────────────────────────────────────────
export async function saveRun(
  run: EvalRun,
  traces: Map<string, EvalTrace>,
  opts: { root?: string; runIdOverride?: string } = {},
): Promise<{ dir: string; paths: RunPaths }> {
  const root = resolveRoot(opts);
  const runId = opts.runIdOverride?.trim() || run.runId;
  const dir = path.join(root, sanitizeName(runId) || "run");
  const paths = runPaths(dir);
  await ensureDir(paths.traces);

  // 统一持久化的 runId（runIdOverride 时 manifest/summary 里的 runId 也同步）。
  const baseRun: EvalRun = {
    ...run,
    runId,
    manifest: { ...run.manifest, runId },
  };

  // 逐用例写 trace；缺 trace（如 skipped）时写占位说明，保证 CLI 可解释而不崩溃。
  const resultsWithTrace: EvalResult[] = [];
  for (const result of baseRun.results) {
    const traceFile = path.join(paths.traces, `${safeCaseId(result.caseId)}.json`);
    const trace = traces.get(result.caseId);
    if (trace) {
      await writeJson(traceFile, { ...trace, caseId: result.caseId });
    } else {
      // 没拿到 trace：skipped 用例写跳过说明；已执行但缺 trace 的用例也写占位说明，不伪装成跳过。
      await writeJson(traceFile, {
        caseId: result.caseId,
        traceAvailable: false,
        skipped: result.status === "skipped",
        status: result.status,
        target: result.target,
        startedAt: baseRun.startedAt,
        finishedAt: baseRun.finishedAt,
        note: result.status === "skipped"
          ? "该用例未执行（skipped），此文件为跳过说明占位。"
          : "该用例没有产生 trace 记录，此文件为占位说明；可查看 results.json 与 report.md。",
        skippedReason: result.skippedReason ?? (result.status === "skipped" ? "未说明跳过原因" : undefined),
      });
    }
    // results.json / report 里的 tracePath 必须是绝对路径，便于工作 Agent 直接打开。
    resultsWithTrace.push({ ...result, tracePath: traceFile });
  }
  const savedRun: EvalRun = { ...baseRun, results: resultsWithTrace };

  // 先写运行产物，再更新索引；索引失败时抛错但产物仍在，便于重跑索引。
  await writeJson(paths.manifest, savedRun.manifest);
  const data: RunDataFile = {
    schemaVersion: 1,
    runId,
    ...(savedRun.label ? { label: savedRun.label } : {}),
    target: savedRun.target,
    suites: savedRun.suites,
    startedAt: savedRun.startedAt,
    finishedAt: savedRun.finishedAt,
    durationMs: savedRun.durationMs,
    metrics: savedRun.metrics,
    results: resultsWithTrace,
  };
  await writeJson(paths.results, data);
  await writeFile(paths.report, renderMarkdown(savedRun), "utf8");
  await writeJson(paths.summary, compactSummary(savedRun, { reportPath: paths.report, resultsPath: paths.results }));

  // index.json：按 createdAt 倒序维护（同一 runId 覆盖旧条目，避免重复）。
  // 索引缺失/损坏时用「扫描 run 目录」兜底，避免重建索引时丢掉历史记录。
  const entry = entryFromRun(savedRun, paths.dir);
  const indexEntries = await updateJsonWithRetry<RunIndexEntry[]>(
    path.join(root, "index.json"),
    () => scanRunDirs(root),
    (current) => {
      const list = Array.isArray(current) ? current.filter((item) => item && item.runId !== entry.runId) : [];
      list.push(entry);
      return sortEntriesDesc(list);
    },
  );

  // latest.json：latest = 最近一次（createdAt 最新）的 run；latestLive = 最近的 live run。
  const latestEntry = indexEntries[0] ?? entry;
  const latestLiveEntry = indexEntries.find((item) => item.target === "live") ?? null;
  await updateJsonWithRetry<LatestRuns>(path.join(root, "latest.json"), { latest: null, latestLive: null }, () => ({
    latest: latestEntry.runId,
    latestLive: latestLiveEntry?.runId ?? null,
  }));

  return { dir: paths.dir, paths };
}

// ── 载入运行 ────────────────────────────────────────────────────────────────
async function loadRunFromDir(dir: string): Promise<EvalRun> {
  const absDir = path.resolve(dir);
  const manifest = await readJson<EvalManifest | null>(path.join(absDir, "manifest.json"), null);
  const rawResults = await readJson<RunDataFile | EvalResult[] | null>(path.join(absDir, "results.json"), null);
  const summary = await readJson<CompactRunSummary | null>(path.join(absDir, "summary.json"), null);
  const data = rawResults && !Array.isArray(rawResults) ? rawResults : null;
  const results: EvalResult[] = Array.isArray(rawResults) ? rawResults : data?.results ?? [];
  if (!manifest && !data && !summary) {
    throw new Error(`不是评测运行目录（缺少 manifest.json / results.json）：${absDir}`);
  }
  const runId = data?.runId ?? manifest?.runId ?? summary?.runId ?? path.basename(absDir);
  const label = data?.label ?? manifest?.label ?? summary?.label;
  const manifestFinal: EvalManifest = manifest ?? {
    runId,
    ...(label ? { label } : {}),
    target: data?.target ?? summary?.target ?? "scripted",
    suites: data?.suites ?? summary?.suites ?? [],
    caseCount: results.length,
    createdAt: data?.startedAt ?? new Date(0).toISOString(),
    git: { commit: "unknown", branch: "unknown", dirty: false },
    node: process.version,
    model: { real: false },
    systemPromptHash: "",
    toolsHash: "",
    datasetHashes: {},
    concurrency: 1,
    offlineTools: true,
  };
  const metrics = data?.metrics ?? summary?.metrics ?? fallbackMetrics(results);
  return {
    schemaVersion: 1,
    runId,
    ...(label ? { label } : {}),
    target: data?.target ?? manifestFinal.target,
    suites: data?.suites ?? manifestFinal.suites,
    startedAt: data?.startedAt ?? manifestFinal.createdAt,
    finishedAt: data?.finishedAt ?? manifestFinal.createdAt,
    durationMs: data?.durationMs ?? 0,
    manifest: manifestFinal,
    metrics,
    results,
  };
}

async function scanRunDirs(root: string): Promise<RunIndexEntry[]> {
  const entries: RunIndexEntry[] = [];
  let dirs: Array<{ name: string }> = [];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => ({ name: item.name }));
  } catch {
    return [];
  }
  for (const item of dirs) {
    try {
      const run = await loadRunFromDir(path.join(root, item.name));
      entries.push(entryFromRun(run, path.join(root, item.name)));
    } catch {
      // 非 run 目录（或损坏）跳过，索引重建不应因此失败。
    }
  }
  return sortEntriesDesc(entries);
}

async function readIndex(root: string): Promise<RunIndexEntry[]> {
  const index = await readJson<RunIndexEntry[] | null>(path.join(root, "index.json"), null);
  if (Array.isArray(index) && index.length) {
    return sortEntriesDesc(index.filter((item): item is RunIndexEntry => Boolean(item && typeof item.runId === "string")));
  }
  return scanRunDirs(root);
}

export async function listRuns(opts: { root?: string } = {}): Promise<RunIndexEntry[]> {
  return readIndex(resolveRoot(opts));
}

// ── 引用解析（同步，供 loadRun / CLI 复用）─────────────────────────────────
function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function isDirectorySync(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function readEntryFromDirSync(dir: string): RunIndexEntry | null {
  try {
    const manifest = readJsonSync<EvalManifest | null>(path.join(dir, "manifest.json"), null);
    const rawResults = readJsonSync<RunDataFile | EvalResult[] | null>(path.join(dir, "results.json"), null);
    const summary = readJsonSync<CompactRunSummary | null>(path.join(dir, "summary.json"), null);
    const data = rawResults && !Array.isArray(rawResults) ? rawResults : null;
    const results: EvalResult[] = Array.isArray(rawResults) ? rawResults : data?.results ?? [];
    const runId = data?.runId ?? manifest?.runId ?? summary?.runId;
    if (!runId) return null;
    const metrics = data?.metrics ?? summary?.metrics;
    const total = metrics?.total ?? results.length;
    const passed = metrics?.passed ?? results.filter((result) => result.passed).length;
    return {
      runId,
      target: data?.target ?? manifest?.target ?? summary?.target ?? "scripted",
      ...(data?.label ?? manifest?.label ?? summary?.label ? { label: data?.label ?? manifest?.label ?? summary?.label } : {}),
      suites: data?.suites ?? manifest?.suites ?? summary?.suites ?? [],
      passed,
      total,
      passRate: metrics?.passRate ?? (total > 0 ? passed / total : 0),
      createdAt: manifest?.createdAt ?? data?.startedAt ?? "",
      dir: path.resolve(dir),
    };
  } catch {
    return null;
  }
}

function indexSync(root: string): RunIndexEntry[] {
  const index = readJsonSync<RunIndexEntry[] | null>(path.join(root, "index.json"), null);
  if (Array.isArray(index) && index.length) {
    return sortEntriesDesc(index.filter((item): item is RunIndexEntry => Boolean(item && typeof item.runId === "string")));
  }
  const entries: RunIndexEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
  } catch {
    return [];
  }
  for (const name of names) {
    const entry = readEntryFromDirSync(path.join(root, name));
    if (entry) entries.push(entry);
  }
  return sortEntriesDesc(entries);
}

function recentRunLines(entries: RunIndexEntry[]): string {
  const recent = entries.slice(0, 5);
  if (!recent.length) return "  （暂无运行记录）";
  return recent
    .map((entry) => `  - ${entry.runId}  target=${entry.target}${entry.label ? `  label=${entry.label}` : ""}  通过率=${(entry.passRate * 100).toFixed(1)}%`)
    .join("\n");
}

function lookupError(message: string): Error {
  const error = new Error(message);
  error.name = "EvalRunNotFoundError";
  return error;
}

function resolveRefSync(root: string, refRaw: string): string {
  const ref = String(refRaw ?? "").trim();
  const entries = indexSync(root);
  const hint = "提示：ref 可用 latest / latest-live / 完整 runId / runId 唯一前缀 / 唯一 label / 直接目录路径。";
  const notFound = (reason: string): Error => lookupError(
    `未找到评测运行：${refRaw}\n根目录：${root}\n${reason}\n最近运行（最多 5 个）：\n${recentRunLines(entries)}\n${hint}`,
  );

  if (!ref) throw notFound("判定原因：ref 为空。");

  // 1) latest / latest-live 关键字。
  if (ref === "latest" || ref === "latest-live") {
    const latest = readJsonSync<Partial<LatestRuns> | null>(path.join(root, "latest.json"), null);
    const wanted = ref === "latest"
      ? (typeof latest?.latest === "string" ? latest.latest : null)
      : (typeof latest?.latestLive === "string" ? latest.latestLive : null);
    if (wanted) {
      const entry = entries.find((item) => item.runId === wanted);
      if (entry) return path.resolve(entry.dir);
      const fallbackDir = path.join(root, sanitizeName(wanted) || "run");
      if (isDirectorySync(fallbackDir)) return fallbackDir;
      throw notFound(`判定原因：latest.json 指向的 run 目录不存在（${wanted}）。`);
    }
    // latest 缺记录时退回索引里 createdAt 最新的一条（latest-live 必须有 live 记录）。
    if (ref === "latest" && entries.length) return path.resolve(entries[0].dir);
    throw notFound(ref === "latest"
      ? "判定原因：还没有任何运行记录。"
      : "判定原因：还没有 live 通道运行（latest.json 的 latestLive 为 null）。");
  }

  // 2) 直接目录路径（绝对/相对均可）。
  const direct = path.resolve(process.cwd(), ref);
  if (isDirectorySync(direct)) return direct;

  // 3) 完整 runId 精确匹配。
  const exact = entries.find((entry) => entry.runId === ref);
  if (exact) return path.resolve(exact.dir);

  // 4) runId 唯一前缀。
  const prefixMatches = entries.filter((entry) => entry.runId.startsWith(ref));
  if (prefixMatches.length === 1) return path.resolve(prefixMatches[0].dir);
  if (prefixMatches.length > 1) {
    throw lookupError(
      `runId 前缀不唯一：${ref} 匹配到 ${prefixMatches.length} 个运行\n` +
      `${prefixMatches.map((entry) => `  - ${entry.runId}`).join("\n")}\n请提供更长的前缀或完整 runId。`,
    );
  }

  // 5) label 唯一匹配。
  const labelMatches = entries.filter((entry) => entry.label === ref);
  if (labelMatches.length === 1) return path.resolve(labelMatches[0].dir);
  if (labelMatches.length > 1) {
    throw lookupError(
      `label 不唯一：${ref} 匹配到 ${labelMatches.length} 个运行\n` +
      `${labelMatches.map((entry) => `  - ${entry.runId}`).join("\n")}\n请改用 runId 指定。`,
    );
  }

  // 6) 根目录下同名目录（索引缺失但目录存在）。
  const namedDir = path.join(root, sanitizeName(ref) || "run");
  if (isDirectorySync(namedDir)) return namedDir;

  throw notFound("判定原因：runId / 前缀 / label / 目录路径均未匹配。");
}

export function resolveRunDir(ref: string, opts: { root?: string } = {}): string {
  return resolveRefSync(resolveRoot(opts), ref);
}

export async function loadRun(ref: string, opts: { root?: string } = {}): Promise<EvalRun> {
  const dir = resolveRunDir(ref, opts);
  return loadRunFromDir(dir);
}
