// 评测报告器：把 EvalRun 渲染成 Markdown 报告、紧凑摘要与单行用例结果。
// 设计边界：本模块只做「事实渲染」，不做判定；判定由 evaluator/checks 负责。
// 输出优先给工作 Agent 与 CLI 直接阅读：紧凑摘要 ≤25 行、完整报告用 Markdown 表格。
import type {
  CategoryMetrics, CheckResult, CompactRunSummary, EvalMetrics, EvalResult, EvalRun,
} from "./types.ts";

// 紧凑摘要里最多保留的失败条数（避免把 summary.json 撑得过大）。
const MAX_SUMMARY_FAILURES = 20;
// 控制台摘要最多逐条展示的失败数（保证总行数 ≤25）。
const MAX_CONSOLE_FAILURES = 10;
// 报告里回复片段/原因的最大展示长度（完整内容在 trace 文件里）。
const MAX_REASON_CHARS = 400;
const MAX_REPLY_PREVIEW_CHARS = 500;

// ── 格式化工具（全部确定性、无本地化依赖）──────────────────────────────────
function fmtPct(rate: number): string {
  if (!Number.isFinite(rate)) return "0.0%";
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded}ms` : `${(rounded / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(4)}`;
}

function fmtInt(n: number): string {
  return String(Math.round(Number.isFinite(n) ? n : 0));
}

function truncate(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// 失败检查的可读标签：优先 label，其次 id，最后 kind；带上 kind 便于 Agent 定位。
function describeCheck(check: CheckResult): string {
  const name = check.label?.trim() || check.id?.trim() || check.kind;
  return name === check.kind ? `[${check.kind}]` : `${name}[${check.kind}]`;
}

function failedChecksOf(result: EvalResult): CheckResult[] {
  return (result.checks ?? []).filter((check) => !check.passed);
}

// 兼容 metrics.byCategory 缺失（例如手工构造的 run）时从 results 兜底统计。
function categoryMetricsOf(run: EvalRun): Record<string, CategoryMetrics> {
  const fromMetrics = run.metrics?.byCategory ?? {};
  if (Object.keys(fromMetrics).length) return fromMetrics;
  return groupMetrics(run.results, (result) => result.category);
}

function difficultyMetricsOf(run: EvalRun): Record<string, CategoryMetrics> {
  const fromMetrics = run.metrics?.byDifficulty ?? {};
  if (Object.keys(fromMetrics).length) return fromMetrics;
  return groupMetrics(run.results, (result) => result.difficulty);
}

function groupMetrics(results: EvalResult[], keyOf: (result: EvalResult) => string): Record<string, CategoryMetrics> {
  const out: Record<string, CategoryMetrics> = {};
  for (const result of results) {
    const key = keyOf(result) || "unknown";
    const bucket = out[key] ?? { total: 0, passed: 0, failed: 0, skipped: 0, passRate: 0 };
    bucket.total += 1;
    if (result.status === "skipped") bucket.skipped += 1;
    else if (result.passed) bucket.passed += 1;
    else bucket.failed += 1;
    out[key] = bucket;
  }
  for (const bucket of Object.values(out)) {
    const denominator = bucket.total - bucket.skipped;
    bucket.passRate = denominator > 0 ? bucket.passed / denominator : 0;
  }
  return out;
}

function sortedEntries<T>(record: Record<string, T>, compare: (a: [string, T], b: [string, T]) => number = () => 0): Array<[string, T]> {
  return Object.entries(record).sort(compare);
}

// ── 紧凑摘要 ────────────────────────────────────────────────────────────────
export function compactSummary(run: EvalRun, paths: { reportPath?: string; resultsPath?: string } = {}): CompactRunSummary {
  const failures: CompactRunSummary["failures"] = [];
  for (const result of run.results) {
    if (result.passed || result.status === "skipped") continue;
    const failed = failedChecksOf(result);
    const failedDetails = failed.map((check) => check.detail?.trim()).filter((detail): detail is string => Boolean(detail));
    const reason = result.failureReason?.trim() || failedDetails.join("；") || "未提供失败原因";
    failures.push({
      caseId: result.caseId,
      category: result.category,
      ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
      reason: truncate(reason, MAX_REASON_CHARS),
      failedChecks: failed.map(describeCheck),
      toolSequence: result.toolSequence ?? [],
      ...(result.tracePath ? { tracePath: result.tracePath } : {}),
      ...(result.exploratory ? { exploratory: true } : {}),
    });
    if (failures.length >= MAX_SUMMARY_FAILURES) break;
  }
  return {
    runId: run.runId,
    ...(run.label ? { label: run.label } : {}),
    target: run.target,
    suites: run.suites,
    // metrics 缺失分类/难度分组时按 results 兜底，保证下游控制台仍能展示类别通过率。
    metrics: hasGroupedMetrics(run.metrics) ? run.metrics : {
      ...run.metrics,
      byCategory: groupMetrics(run.results, (result) => result.category),
      byDifficulty: groupMetrics(run.results, (result) => result.difficulty),
    },
    failures,
    ...(paths.reportPath ? { reportPath: paths.reportPath } : {}),
    ...(paths.resultsPath ? { resultsPath: paths.resultsPath } : {}),
  };
}

function hasGroupedMetrics(metrics: EvalMetrics | undefined): boolean {
  return Boolean(metrics && metrics.byCategory && Object.keys(metrics.byCategory).length);
}

// ── 控制台紧凑摘要（≤25 行）────────────────────────────────────────────────
export function renderConsoleSummary(summary: CompactRunSummary): string {
  const metrics = summary.metrics;
  const lines: string[] = [];
  lines.push(`评测运行 ${summary.runId}${summary.label ? `（label=${summary.label}）` : ""}`);
  lines.push(`目标通道=${summary.target}  套件=${summary.suites.join(",") || "-"}`);
  lines.push(
    `用例=${metrics.total} 通过=${metrics.passed} 失败=${metrics.failed} 跳过=${metrics.skipped} ` +
    `探索性=${metrics.exploratory} 通过率=${fmtPct(metrics.passRate)}`,
  );
  lines.push(
    `平均耗时=${fmtMs(metrics.avgDurationMs)} 平均工具=${metrics.avgToolCalls.toFixed(1)} ` +
    `总 tokens=${fmtInt(metrics.totalTokens)} 总成本=${fmtCost(metrics.totalCostUsd)}`,
  );

  // 类别通过率压成一行，避免类别多时行数失控。
  const categories = sortedEntries(categoryMetricsOfSummary(summary.metrics));
  lines.push(`按类别：${categories.length
    ? categories.map(([name, cm]) => `${name} ${cm.passed}/${cm.total}(${fmtPct(cm.passRate)})`).join(" | ")
    : "-"}`);

  // 失败簇（按失败类别计数）。
  const clusters = sortedEntries(summary.metrics?.failureCategories ?? {}, (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push(`失败簇：${clusters.length ? clusters.map(([name, count]) => `${name}=${count}`).join(" | ") : "无"}`);

  const countedFailures = summary.failures.filter((failure) => !failure.exploratory);
  const exploratoryFailures = summary.failures.filter((failure) => failure.exploratory);
  if (!countedFailures.length) {
    lines.push("失败用例：无");
  } else {
    const shown = countedFailures.slice(0, MAX_CONSOLE_FAILURES);
    lines.push(`失败用例（显示 ${shown.length}/${countedFailures.length} 条，完整见报告）：`);
    for (const failure of shown) {
      lines.push(
        `  ❌ ${failure.caseId} 失败类别=${failure.failureCategory ?? "unknown"} ` +
        `失败检查=${failure.failedChecks.join("; ") || "无"} ` +
        `工具序列=${failure.toolSequence.join(" → ") || "无"}`,
      );
    }
    if (countedFailures.length > shown.length) {
      lines.push(`  … 其余 ${countedFailures.length - shown.length} 条失败见报告`);
    }
  }
  if (exploratoryFailures.length) {
    const shown = exploratoryFailures.slice(0, 5).map((failure) => `${failure.caseId}(${failure.failureCategory ?? "unknown"})`);
    lines.push(`探索性/负样本失败（不计分，共 ${exploratoryFailures.length} 条）：${shown.join(" , ")}${exploratoryFailures.length > shown.length ? " …" : ""}`);
  }
  lines.push(`报告：${summary.reportPath ?? "（未提供）"}`);
  lines.push(`结果：${summary.resultsPath ?? "（未提供）"}`);
  // 行数上限保护：正常路径 ≤21 行；这里再兜底截断，保证契约 ≤25 行。
  return lines.length > 25 ? lines.slice(0, 25).join("\n") : lines.join("\n");
}

function categoryMetricsOfSummary(metrics: EvalMetrics): Record<string, CategoryMetrics> {
  return metrics?.byCategory ?? {};
}

// ── 单行用例结果 ────────────────────────────────────────────────────────────
export function renderCaseLine(result: EvalResult): string {
  const checks = result.checks ?? [];
  const failed = failedChecksOf(result);
  const icon = result.status === "skipped" ? "⏭" : result.passed ? "✅" : "❌";
  const parts = [
    `${icon} ${result.caseId}`,
    `[${result.category}]`,
    `状态=${result.status}`,
    `检查=${checks.length - failed.length}/${checks.length}`,
    `耗时=${fmtMs(result.durationMs)}`,
  ];
  if (result.failureCategory) parts.push(`失败类别=${result.failureCategory}`);
  if (result.status === "skipped") parts.push(`跳过原因=${truncate(result.skippedReason ?? "未说明", 80)}`);
  else if (failed.length) parts.push(`失败检查=${failed.map(describeCheck).join("; ")}`);
  return parts.join(" ");
}

// ── 完整 Markdown 报告 ─────────────────────────────────────────────────────
export function renderMarkdown(run: EvalRun): string {
  const metrics = run.metrics;
  const manifest = run.manifest;
  const failures = run.results.filter((result) => !result.passed && result.status !== "skipped");
  const skipped = run.results.filter((result) => result.status === "skipped");
  const passed = run.results.filter((result) => result.passed);
  const lines: string[] = [];

  lines.push(`# CampusMate 评测报告 · ${run.runId}`, "");
  lines.push(
    `> 目标通道 \`${run.target}\` · 套件 \`${run.suites.join(", ") || "-"}\` · ` +
    `用例 ${metrics.total} 个 · 通过率 ${fmtPct(metrics.passRate)}`,
  );
  lines.push("");
  lines.push(`- 运行标签：${run.label ?? "（无）"}`);
  lines.push(`- 开始时间：${run.startedAt}`);
  lines.push(`- 结束时间：${run.finishedAt}`);
  lines.push(`- 总耗时：${fmtMs(run.durationMs)}`);
  lines.push("");

  // ── manifest 摘要 ──
  lines.push("## 运行清单", "");
  lines.push("| 项 | 值 |", "| --- | --- |");
  lines.push(`| 目标通道 | \`${manifest.target}\` |`);
  lines.push(`| 套件 | ${manifest.suites.map((suite) => `\`${suite}\``).join(", ") || "-"} |`);
  lines.push(`| 用例数 | ${manifest.caseCount} |`);
  lines.push(`| 创建时间 | ${manifest.createdAt} |`);
  lines.push(`| Node | \`${manifest.node}\` |`);
  lines.push(`| Git 提交 | \`${manifest.git.commit}\` |`);
  lines.push(`| Git 分支 | \`${manifest.git.branch}\` |`);
  lines.push(`| 工作区 | ${manifest.git.dirty ? "有未提交改动" : "干净"} |`);
  lines.push(`| 模型供应商 | ${manifest.model.providerId ?? "-"} |`);
  lines.push(`| 模型显示名 | ${manifest.model.displayName ?? "-"} |`);
  lines.push(`| 模型 ID | ${manifest.model.modelId ?? "-"} |`);
  lines.push(`| 真实模型 | ${manifest.model.real ? "是" : "否（脚本/Mock）"} |`);
  lines.push(`| 系统提示词哈希 | \`${manifest.systemPromptHash || "-"}\` |`);
  lines.push(`| 工具清单哈希 | \`${manifest.toolsHash || "-"}\` |`);
  const datasetHashes = Object.entries(manifest.datasetHashes ?? {});
  lines.push(`| 数据集哈希 | ${datasetHashes.length
    ? datasetHashes.map(([name, hash]) => `\`${name}=${hash}\``).join("<br>")
    : "-"} |`);
  lines.push(`| 并发度 | ${manifest.concurrency} |`);
  lines.push(`| 离线工具 | ${manifest.offlineTools ? "是" : "否"} |`);
  lines.push(`| 随机种子 | ${manifest.seed ?? "-"} |`);
  if (manifest.notes?.length) lines.push(`| 备注 | ${manifest.notes.join("；")} |`);
  lines.push("");

  // ── 总体指标表 ──
  lines.push("## 总体指标", "");
  lines.push("| 指标 | 数值 |", "| --- | --- |");
  lines.push(`| 用例总数 | ${metrics.total} |`);
  lines.push(`| 通过 | ${metrics.passed} |`);
  lines.push(`| 失败 | ${metrics.failed} |`);
  lines.push(`| 跳过 | ${metrics.skipped} |`);
  lines.push(`| 探索性 | ${metrics.exploratory} |`);
  lines.push(`| 通过率（排除跳过/探索性） | ${fmtPct(metrics.passRate)} |`);
  lines.push(`| 平均耗时 | ${fmtMs(metrics.avgDurationMs)} |`);
  lines.push(`| 平均 tokens | ${fmtInt(metrics.avgTokens)} |`);
  lines.push(`| 总 tokens | ${fmtInt(metrics.totalTokens)} |`);
  lines.push(`| 平均工具调用 | ${metrics.avgToolCalls.toFixed(1)} |`);
  lines.push(`| 总成本 | ${fmtCost(metrics.totalCostUsd)} |`);
  lines.push(`| 硬门槛违规 | ${metrics.hardGateViolations?.length ? metrics.hardGateViolations.join("；") : "无"} |`);
  lines.push("");

  // ── 分类表 ──
  lines.push("## 分类通过率", "");
  lines.push("| 类别 | 总数 | 通过 | 失败 | 跳过 | 通过率 |", "| --- | --- | --- | --- | --- | --- |");
  const categoryRows = sortedEntries(categoryMetricsOf(run));
  if (categoryRows.length) {
    for (const [name, bucket] of categoryRows) {
      lines.push(`| ${name} | ${bucket.total} | ${bucket.passed} | ${bucket.failed} | ${bucket.skipped} | ${fmtPct(bucket.passRate)} |`);
    }
  } else {
    lines.push("| - | 0 | 0 | 0 | 0 | - |");
  }
  lines.push("");

  // ── 难度表 ──
  lines.push("## 难度分布", "");
  lines.push("| 难度 | 总数 | 通过 | 失败 | 跳过 | 通过率 |", "| --- | --- | --- | --- | --- | --- |");
  const difficultyRows = sortedEntries(difficultyMetricsOf(run));
  if (difficultyRows.length) {
    for (const [name, bucket] of difficultyRows) {
      lines.push(`| ${name} | ${bucket.total} | ${bucket.passed} | ${bucket.failed} | ${bucket.skipped} | ${fmtPct(bucket.passRate)} |`);
    }
  } else {
    lines.push("| - | 0 | 0 | 0 | 0 | - |");
  }
  lines.push("");

  // ── 失败簇统计 ──
  const clusterRows = sortedEntries(metrics.failureCategories ?? {}, (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push("## 失败簇统计", "");
  lines.push("| 失败类别 | 数量 |", "| --- | --- |");
  if (clusterRows.length) {
    for (const [name, count] of clusterRows) lines.push(`| ${name} | ${count} |`);
  } else {
    lines.push("| 无 | 0 |");
  }
  lines.push("");

  // ── 失败明细 ──
  lines.push(`## 失败用例（${failures.length}）`, "");
  if (!failures.length) {
    lines.push("本轮没有失败用例。", "");
  } else {
    failures.forEach((result, index) => {
      lines.push(`### ${index + 1}. \`${result.caseId}\``);
      lines.push("");
      lines.push(`- 类别：${result.category}`);
      lines.push(`- 难度：${result.difficulty}`);
      lines.push(`- 来源：${result.source}`);
      lines.push(`- 目标通道：${result.target}`);
      lines.push(`- 失败类别：${result.failureCategory ?? "未分类"}`);
      lines.push(`- 失败原因：${truncate(result.failureReason ?? "未提供", MAX_REASON_CHARS)}`);
      lines.push(`- 耗时：${fmtMs(result.durationMs)}`);
      lines.push(`- 工具序列：${result.toolSequence?.length ? `\`${result.toolSequence.join(" → ")}\`` : "（无工具调用）"}`);
      lines.push(`- Trace：${result.tracePath ? `\`${result.tracePath}\`` : "（无 trace 路径）"}`);
      lines.push(`- 失败检查：`);
      const failed = failedChecksOf(result);
      if (failed.length) {
        for (const check of failed) {
          lines.push(`  - ${describeCheck(check)}${check.required ? "（required）" : "（可选）"}：${truncate(check.detail ?? "无细节", MAX_REASON_CHARS)}`);
        }
      } else {
        lines.push("  - （无失败检查记录，见失败原因）");
      }
      const preview = truncate(result.replyPreview ?? "", MAX_REPLY_PREVIEW_CHARS);
      lines.push(`- 回复片段：`);
      lines.push(`  > ${preview || "（空）"}`);
      lines.push("");
    });
  }

  // ── 通过清单 ──
  lines.push(`## 通过用例（${passed.length}）`, "");
  if (!passed.length) lines.push("（无）", "");
  else {
    for (const result of passed) lines.push(`- ${renderCaseLine(result)}`);
    lines.push("");
  }

  // ── 跳过用例 ──
  if (skipped.length) {
    lines.push(`## 跳过用例（${skipped.length}）`, "");
    for (const result of skipped) lines.push(`- ${renderCaseLine(result)}`);
    lines.push("");
  }

  return lines.join("\n");
}
