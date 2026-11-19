// Headless Agent Evaluation CLI —— 工作 Agent 的唯一评测入口（无需浏览器/Computer Use）。
// 用法见 docs/EVALUATION_SYSTEM.md；所有子命令输出紧凑文本，--json 输出机器可读结构。
import "../src/load-env.ts";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadSuites, listSuites, suiteStats } from "../src/evaluation/dataset.ts";
import { runEvaluation } from "../src/evaluation/runner.ts";
import { listRuns, loadRun, resolveRunDir, runPaths } from "../src/evaluation/store.ts";
import { compactSummary, renderConsoleSummary, renderMarkdown } from "../src/evaluation/reporter.ts";
import { analyzeRun, renderAnalysis } from "../src/evaluation/analysis.ts";
import { compareRuns, evaluateGate } from "../src/evaluation/experiment.ts";
import { ScriptedTarget } from "../src/evaluation/targets/scripted.ts";
import { ApiTarget } from "../src/evaluation/targets/api.ts";
import { parseSourceBindings } from "../src/evaluation/targets/source-binding.ts";
import { runLegacyBenchmark } from "../src/evaluation/legacy.ts";
import { validateBlueprint, writeGeneratedSuite, type Blueprint } from "../src/evaluation/generator.ts";
import { LlmJudge } from "../src/evaluation/judge.ts";
import { compareBehavior, fingerprintFromHuman, loadEvalFingerprint, renderParity, type ParityThresholds } from "../src/evaluation/parity.ts";
import { DeepSeekTransport } from "../src/core/llm.ts";
import type { EvalSuite, EvalTarget, GateThresholds } from "../src/evaluation/types.ts";

const USAGE = `CampusMate Headless Evaluation CLI

  node scripts/eval.ts run       [--suite <id|path>]... [--case <caseId>]... [--target scripted|api-memory|live|legacy]
                                 [--concurrency N] [--timeout-ms N] [--label text] [--seed N]
                                 [--reasoning auto|minimal|low|medium|high|xhigh|max] [--provider <id>] [--session]
                                 [--store memory|pglite --store-dir <dir>] [--resume-session <id|last> [--resume-user <uid>]]
                                 [--source-eval-config <file> --allow-private-model-data]
                                 [--holdout] [--offline] [--judge] [--runs dir] [--json] [--quiet] [--allow-failures]
  node scripts/eval.ts validate  [--suite <id|path>]...
  node scripts/eval.ts list      [--runs dir] [--json]
  node scripts/eval.ts report    [--run latest] [--runs dir] [--markdown] [--json]
  node scripts/eval.ts analyze   [--run latest] [--sample N] [--runs dir] [--json]
  node scripts/eval.ts compare   --baseline <run> --candidate <run> [--runs dir] [--json]
  node scripts/eval.ts gate      [--candidate <run>] [--run latest] [--baseline <run>]
                                 [--holdout-run <run>] [--threshold <json>] [--runs dir] [--json]
  node scripts/eval.ts gen       --blueprint <file> --out <file> [--json]
  node scripts/eval.ts parity    --eval <run> --case <caseId> [--human-file <json> | --human-task <id>...
                                 | --human-session <id>] [--token <jwt>] [--base-url <url>]
                                 [--min-tool-sim 0.8] [--min-args-match 0.8] [--allow-status-diff]
                                 [--runs dir] [--json]
  node scripts/eval.ts runs      [--runs dir] [--json]
  node scripts/eval.ts help

  通道：scripted=毫秒级确定性核心回归；api-memory=HTTP+Worker+内存库（脚本模型）；
        live=真实模型+真实工具+内存库（不写云端数据库，无浏览器）；legacy=既有 30 任务基准。
  留出集：--holdout 才会加载 backend/evaluation/holdout/。
  Judge：--judge 启用独立 LLM 评分（需 backend/.env LLM_API_KEY；每个用例额外 1 次模型调用；
         仅用例声明 judge.minScore 时作为硬性检查，否则只作参考信号）。
  对话级：--reasoning/--provider/--session 让评测入口与人类聊天一致；多轮用例自动创建真实 session。
  Parity：把人类在真实聊天框产生的任务事件与评测 trace 做结构化对照（状态/工具序列/参数哈希/来源/用量）。`;

function fail(message: string): void {
  console.error(`[eval] ${message}`);
  process.exitCode = 1;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultConcurrency(target: string): number {
  return target === "live" ? 1 : target === "api-memory" ? 2 : 4;
}

function defaultTimeout(target: string): number {
  return target === "live" ? 420_000 : target === "api-memory" ? 120_000 : 60_000;
}

function filterHoldout(suites: EvalSuite[], include: boolean): EvalSuite[] {
  if (include) return suites;
  return suites
    .map((suite) => ({ ...suite, cases: suite.cases.filter((c) => !c.holdout) }))
    .filter((suite) => suite.cases.length > 0);
}

function suiteRefs(values: Record<string, unknown>): string[] {
  const refs = Array.isArray(values.suite) ? (values.suite as string[]) : [];
  return refs.length ? refs : ["all"];
}

function runsRoot(values: Record<string, unknown>): string | undefined {
  return typeof values.runs === "string" ? values.runs : undefined;
}

// 持久化评测库（--store pglite）与两阶段会话恢复（--resume-session [last]）解析。
// 只影响显式传参的运行；默认仍为内存库，行为不变。
interface DurableCliOptions {
  durableStore?: { kind: "pglite"; dataDir: string };
  resumeSessionId?: string;
  resumeUserId?: string;
}

function resolveDurableOptions(values: Record<string, unknown>, targetName: string): DurableCliOptions | { error: string } {
  const store = typeof values.store === "string" ? values.store : "memory";
  if (!["memory", "pglite"].includes(store)) return { error: `--store 必须为 memory|pglite（收到 ${store}）` };
  const resume = values["resume-session"];
  const explicitUser = typeof values["resume-user"] === "string" ? values["resume-user"] : undefined;
  if (store === "memory") {
    if (resume !== undefined || explicitUser !== undefined) return { error: "--resume-session/--resume-user 需要 --store pglite" };
    return {};
  }
  if (!["api-memory", "live"].includes(targetName)) return { error: "--store pglite 仅支持 api-memory/live 通道" };
  const rawDir = typeof values["store-dir"] === "string" ? values["store-dir"].trim() : "";
  if (!rawDir) return { error: "--store pglite 需要 --store-dir <dir>" };
  const dataDir = path.resolve(rawDir);
  let handoff: { sessionId?: string; userId?: string } | undefined;
  try { handoff = JSON.parse(fs.readFileSync(path.join(dataDir, "durable-session.json"), "utf8")) as { sessionId?: string; userId?: string }; } catch { handoff = undefined; }
  let resumeSessionId: string | undefined;
  let resumeUserId: string | undefined;
  if (resume !== undefined) {
    const requested = String(resume).trim();
    if (requested === "last" || requested === "auto") {
      if (!handoff?.sessionId) return { error: "--resume-session last：durable store 尚无 durable-session.json（先跑阶段A）" };
      resumeSessionId = handoff.sessionId;
    } else if (requested) {
      resumeSessionId = requested;
    } else {
      return { error: "--resume-session 需要会话 id 或 last" };
    }
    resumeUserId = explicitUser ?? (handoff?.sessionId === resumeSessionId ? handoff.userId : undefined);
    if (!resumeUserId) return { error: "--resume-session 需要 --resume-user <uuid>（durable store 中没有匹配的交接信息）" };
  } else if (explicitUser !== undefined) {
    return { error: "--resume-user 需要同时提供 --resume-session" };
  }
  return {
    durableStore: { kind: "pglite", dataDir },
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(resumeUserId ? { resumeUserId } : {}),
  };
}

async function cmdRun(values: Record<string, unknown>): Promise<void> {
  const targetName = typeof values.target === "string" ? values.target : "scripted";
  if (!["scripted", "api-memory", "live", "legacy"].includes(targetName)) return fail(`未知通道：${targetName}`);
  const durable = resolveDurableOptions(values, targetName);
  if ("error" in durable) return fail(durable.error);
  const includeHoldout = values.holdout === true;
  const refs = suiteRefs(values);
  if (includeHoldout) refs.push("all-holdout");
  let suites = filterHoldout(loadSuites(refs), includeHoldout);
  const caseFilters = Array.isArray(values.case) ? (values.case as string[]) : [];
  if (caseFilters.length) {
    suites = suites
      .map((suite) => ({ ...suite, cases: suite.cases.filter((c) => caseFilters.some((f) => c.id === f || c.id.startsWith(f))) }))
      .filter((suite) => suite.cases.length > 0);
    if (!suites.length) return fail(`--case 未匹配到用例：${caseFilters.join(",")}`);
  }
  if (!suites.length) return fail("没有可运行的用例（是否全部为 holdout？加 --holdout 才会运行）");
  const label = typeof values.label === "string" ? values.label : undefined;
  if (targetName === "legacy") {
    const { summary } = await runLegacyBenchmark({ ...(label ? { label } : {}), ...(runsRoot(values) ? { runsRootDir: runsRoot(values) } : {}) });
    if (values.json === true) console.log(JSON.stringify(summary, null, 2));
    else console.log(renderConsoleSummary(summary));
    process.exitCode = summary.metrics.failed > 0 && values["allow-failures"] !== true ? 1 : 0;
    return;
  }
  if (targetName === "live" && !process.env.LLM_API_KEY) {
    return fail("live 通道需要 backend/.env 配置 LLM_API_KEY（真实模型）；或用 --target api-memory 做脚本化集成评测");
  }
  const concurrency = num(values.concurrency as string | undefined, defaultConcurrency(targetName));
  const timeoutMs = num(values["timeout-ms"] as string | undefined, defaultTimeout(targetName));
  // scripted/api-memory 默认离线（外部工具必须有夹具）；live 默认真实网络，--offline 可强制离线。
  const offlineTools = targetName === "live" ? values.offline === true : true;
  const reasoning = typeof values.reasoning === "string" ? values.reasoning : undefined;
  if (reasoning && !["auto", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning)) return fail("--reasoning 必须为 auto|minimal|low|medium|high|xhigh|max");
  const providerId = typeof values.provider === "string" ? values.provider : undefined;
  const useSession = values.session === true;
  // 可选独立 Judge：默认关闭；显式 --judge 时每个用例追加 1 次独立模型评分。
  let judge;
  if (values.judge === true) {
    if (!process.env.LLM_API_KEY) return fail("--judge 需要 backend/.env 配置 LLM_API_KEY");
    judge = new LlmJudge(new DeepSeekTransport({
      apiKey: process.env.LLM_API_KEY,
      ...(process.env.LLM_BASE_URL ? { baseUrl: process.env.LLM_BASE_URL } : {}),
      ...(process.env.LLM_MODEL ? { model: process.env.LLM_MODEL } : {}),
      maxRetries: 1,
      timeoutMs: 90_000,
    }));
  }
  const linkedSourceChecks = suites.some(suite => suite.cases.some(c => c.context?.sourceFixture ||
    c.checks.some(check => check.kind === "source_complete" || check.kind === "timetable_preview")));
  let sourceBindings;
  if (typeof values["source-eval-config"] === "string") {
    if (targetName !== "live" || values.offline === true || values["allow-private-model-data"] !== true || !runsRoot(values))
      return fail("真实私有来源需要 live 通道、显式 --allow-private-model-data 与指定的本地 --runs 证据目录");
    try {
      sourceBindings = parseSourceBindings(JSON.parse(fs.readFileSync(values["source-eval-config"], "utf8").replace(/^\uFEFF/, "")),
        new Set(suites.flatMap(suite => suite.cases.filter(c => !c.context?.sourceFixture).map(c => c.id))));
    } catch (error) {
      return fail(error instanceof SyntaxError ? "无法解析真实来源配置" : error instanceof Error && "code" in error ? "无法读取真实来源配置" : String(error instanceof Error ? error.message : "真实来源配置无效"));
    }
  }
  const target: EvalTarget = targetName === "scripted" ? new ScriptedTarget() :
    new ApiTarget(targetName === "live" ? "live" : "script", linkedSourceChecks || Boolean(sourceBindings?.size), sourceBindings);
  const output = await runEvaluation({
    suites, target, concurrency, timeoutMs, offlineTools,
    ...(label ? { label } : {}),
    ...(judge ? { judge } : {}),
    ...(reasoning ? { reasoning: reasoning as "auto" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } : {}),
    ...(providerId ? { providerId } : {}),
    ...(useSession ? { useSession: true } : {}),
    ...(values.seed !== undefined ? { seed: num(values.seed as string, 1) } : {}),
    ...(runsRoot(values) ? { runsRoot: runsRoot(values) } : {}),
    ...durable,
    holdoutRun: includeHoldout,
  });
  if (values.json === true) console.log(JSON.stringify(output.summary, null, 2));
  else if (values.quiet === true) console.log(`[eval] ${output.run.runId} passRate=${(output.run.metrics.passRate * 100).toFixed(1)}% (${output.run.metrics.passed}/${output.run.metrics.passed + output.run.metrics.failed}) 报告=${output.paths.report}`);
  else {
    console.log(renderConsoleSummary(output.summary));
    if (durable.durableStore) {
      try {
        const handoff = JSON.parse(fs.readFileSync(path.join(output.dir, "durable-session.json"), "utf8")) as { sessionId?: string; userId?: string; caseId?: string };
        console.log(`[eval] durable store=${durable.durableStore.dataDir}`);
        console.log(`[eval] durable session=${handoff.sessionId} owner=${handoff.userId} case=${handoff.caseId}`);
        console.log(`[eval] durable handoff=${path.join(output.dir, "durable-session.json")}`);
      } catch {
        console.log(`[eval] durable store=${durable.durableStore.dataDir}（本次运行未产生会话交接文件；单轮且未启用 --session 时正常）`);
      }
    }
  }
  if (values.json !== true && output.run.metrics.passed + output.run.metrics.failed === 0) {
    const exploratory = output.run.results.filter(result => result.exploratory && result.status !== "skipped");
    console.log(`[eval] 无固定计分用例：探索性已执行${exploratory.length}条，其中通过${exploratory.filter(result => result.passed).length}、失败${exploratory.filter(result => !result.passed).length}；其余可能被通道过滤。探索结果不作为固定集通过率，耗时/用量请查逐例记录。`);
  }
  process.exitCode = output.run.metrics.failed > 0 && values["allow-failures"] !== true ? 1 : 0;
}

async function cmdValidate(values: Record<string, unknown>): Promise<void> {
  const refs = suiteRefs(values);
  let ok = 0;
  for (const ref of refs) {
    try { const suite = loadSuites([ref])[0]; const stats = suiteStats(suite); ok++; console.log(`[eval] OK ${suite.id}（${suite.name}）cases=${stats.total} categories=${Object.keys(stats.byCategory).join(",")} scripted=${stats.scripted} holdout=${stats.holdout}`); }
    catch (error) { fail(`${ref}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (ok === 0) process.exitCode = 1;
}

async function cmdList(values: Record<string, unknown>): Promise<void> {
  const suites = listSuites();
  const runs = await listRuns({ ...(runsRoot(values) ? { root: runsRoot(values) } : {}) });
  if (values.json === true) { console.log(JSON.stringify({ suites, runs }, null, 2)); return; }
  console.log("[eval] 数据集：");
  for (const suite of suites) console.log(`  ${suite.holdout ? "H" : " "} ${suite.id}  cases=${suite.caseCount}  ${suite.path}`);
  console.log("[eval] 运行历史（最近 10）：");
  for (const run of runs.slice(0, 10)) console.log(`  ${run.runId}  target=${run.target} pass=${run.passed}/${run.total} (${(run.passRate * 100).toFixed(1)}%) suites=${run.suites.join(",")}`);
}

async function cmdReport(values: Record<string, unknown>): Promise<void> {
  const ref = typeof values.run === "string" ? values.run : "latest";
  const root = runsRoot(values) ? { root: runsRoot(values)! } : {};
  const run = await loadRun(ref, root);
  if (values.json === true) { console.log(JSON.stringify(compactSummary(run, pathsOf(ref, root)), null, 2)); return; }
  console.log(values.markdown === true ? renderMarkdown(run) : renderConsoleSummary(compactSummary(run, pathsOf(ref, root))));
}

function pathsOf(ref: string, root: { root?: string }): { reportPath?: string; resultsPath?: string } {
  try { const paths = runPaths(resolveRunDir(ref, root)); return { reportPath: paths.report, resultsPath: paths.results }; }
  catch { return {}; }
}

async function cmdAnalyze(values: Record<string, unknown>): Promise<void> {
  const run = await loadRun(typeof values.run === "string" ? values.run : "latest", { ...(runsRoot(values) ? { root: runsRoot(values) } : {}) });
  const analysis = analyzeRun(run, { sampleSize: num(values.sample as string | undefined, 5) });
  if (values.json === true) { console.log(JSON.stringify(analysis, null, 2)); return; }
  console.log(renderAnalysis(analysis));
}

async function cmdCompare(values: Record<string, unknown>): Promise<void> {
  if (typeof values.baseline !== "string" || typeof values.candidate !== "string") return fail("compare 需要 --baseline 与 --candidate");
  const root = runsRoot(values) ? { root: runsRoot(values)! } : {};
  const baseline = await loadRun(values.baseline, root);
  const candidate = await loadRun(values.candidate, root);
  const comparison = compareRuns(baseline, candidate);
  if (values.json === true) { console.log(JSON.stringify(comparison, null, 2)); return; }
  console.log(`[eval] baseline=${comparison.baselineRunId} candidate=${comparison.candidateRunId}`);
  console.log(`[eval] 通过率 ${(comparison.overall.baseline * 100).toFixed(1)}% → ${(comparison.overall.candidate * 100).toFixed(1)}% (${signed(comparison.overall.delta)})`);
  console.log(`[eval] 成本 $${comparison.cost.baseline.toFixed(6)} → $${comparison.cost.candidate.toFixed(6)}；时延 ${comparison.duration.baseline.toFixed(0)}ms → ${comparison.duration.candidate.toFixed(0)}ms`);
  for (const [category, item] of Object.entries(comparison.byCategory)) console.log(`  ${category}: ${(item.baseline * 100).toFixed(1)}% → ${(item.candidate * 100).toFixed(1)}% (${signed(item.delta)})`);
  if (comparison.regressions.length) console.log(`[eval] 回归：${comparison.regressions.join(" , ")}`);
  if (comparison.improvements.length) console.log(`[eval] 改善：${comparison.improvements.join(" , ")}`);
  if (comparison.newCases.length) console.log(`[eval] 新增：${comparison.newCases.join(" , ")}`);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

async function cmdGate(values: Record<string, unknown>): Promise<void> {
  const root = runsRoot(values) ? { root: runsRoot(values)! } : {};
  const candidateRef = typeof values.candidate === "string" ? values.candidate : typeof values.run === "string" ? values.run : "latest";
  const candidate = await loadRun(candidateRef, root);
  const baseline = typeof values.baseline === "string" ? await loadRun(values.baseline, root) : null;
  const holdout = typeof values["holdout-run"] === "string" ? await loadRun(values["holdout-run"], root) : null;
  let thresholds: Partial<GateThresholds> | undefined;
  if (typeof values.threshold === "string") {
    try { thresholds = JSON.parse(fs.readFileSync(values.threshold, "utf8")) as Partial<GateThresholds>; }
    catch (error) { return fail(`读取 --threshold 失败：${error instanceof Error ? error.message : String(error)}`); }
  }
  const outcome = evaluateGate(candidate, baseline, { holdout, ...(thresholds ? { thresholds } : {}) });
  if (values.json === true) { console.log(JSON.stringify(outcome, null, 2)); process.exitCode = outcome.passed ? 0 : 1; return; }
  console.log(`[eval] gate candidate=${candidate.runId} baseline=${baseline?.runId ?? "无"} → ${outcome.passed ? "PASS" : "REJECT"}`);
  for (const item of outcome.items) console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}`);
  for (const warning of outcome.warnings) console.log(`  ! ${warning}`);
  if (outcome.reasons.length) console.log(`[eval] 拒绝原因：${outcome.reasons.join("；")}`);
  process.exitCode = outcome.passed ? 0 : 1;
}

async function cmdGen(values: Record<string, unknown>): Promise<void> {
  if (typeof values.blueprint !== "string" || typeof values.out !== "string") return fail("gen 需要 --blueprint 与 --out");
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(values.blueprint, "utf8")); }
  catch (error) { return fail(`读取 blueprint 失败：${error instanceof Error ? error.message : String(error)}`); }
  const validation = validateBlueprint(raw);
  if (!validation.blueprint) return fail(`blueprint 无效：${validation.errors.join("；")}`);
  const result = writeGeneratedSuite(validation.blueprint as Blueprint, values.out);
  if (values.json === true) { console.log(JSON.stringify(result.stats, null, 2)); return; }
  console.log(`[eval] 已生成 ${values.out}：cases=${result.stats.total} categories=${Object.keys(result.stats.byCategory).join(",")}（exploratory，不计入 Gate 通过率）`);
}

// ── Parity：人类真实聊天框任务 ↔ Headless 评测行为指纹 ──────────────────────
async function fetchHumanEvidence(values: Record<string, unknown>): Promise<unknown> {
  const baseUrl = typeof values["base-url"] === "string" ? values["base-url"] : process.env.EVAL_PARITY_BASE_URL ?? "http://127.0.0.1:8788";
  const token = typeof values.token === "string" ? values.token : process.env.EVAL_PARITY_TOKEN;
  if (!token) throw new Error("读取人类任务需要 --token <jwt> 或环境变量 EVAL_PARITY_TOKEN（Supabase 登录 token）");
  const get = async (path: string): Promise<any> => {
    const response = await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}：${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  const sessionId = typeof values["human-session"] === "string" ? values["human-session"] : undefined;
  if (sessionId) {
    const list = await get(`/v1/sessions/${encodeURIComponent(sessionId)}/tasks`);
    const tasks = Array.isArray(list.tasks) ? list.tasks : [];
    if (!tasks.length) throw new Error(`会话 ${sessionId} 没有任务记录`);
    const out = [];
    for (const task of tasks) {
      const id = String(task?.id ?? "");
      if (!id) continue;
      const events = await get(`/v1/tasks/${encodeURIComponent(id)}/events`);
      out.push({ task, events: Array.isArray(events.events) ? events.events : [] });
    }
    return { tasks: out };
  }
  const ids = Array.isArray(values["human-task"]) ? values["human-task"] as string[] : [];
  if (!ids.length) throw new Error("需要 --human-task <taskId>（可多个）、--human-session <sessionId> 或 --human-file <json>");
  const out = [];
  for (const id of ids) {
    const task = await get(`/v1/tasks/${encodeURIComponent(id)}`);
    const events = await get(`/v1/tasks/${encodeURIComponent(id)}/events`);
    out.push({ task: task.task, events: Array.isArray(events.events) ? events.events : [] });
  }
  return { tasks: out };
}

async function cmdParity(values: Record<string, unknown>): Promise<void> {
  const caseArg = values.case;
  const caseRef = Array.isArray(caseArg) ? String(caseArg[0] ?? "") : typeof caseArg === "string" ? caseArg : "";
  if (!caseRef) return fail("parity 需要 --case <评测用例ID>");
  const root = runsRoot(values) ? { root: runsRoot(values)! } : {};
  const run = await loadRun(typeof values.eval === "string" ? values.eval : "latest-live", root);
  const evaluation = loadEvalFingerprint(run, caseRef);
  let humanRaw: unknown;
  if (typeof values["human-file"] === "string") {
    try { humanRaw = JSON.parse(fs.readFileSync(values["human-file"], "utf8")); }
    catch (error) { return fail(`读取 --human-file 失败：${error instanceof Error ? error.message : String(error)}`); }
  } else {
    try { humanRaw = await fetchHumanEvidence(values); }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  }
  const human = fingerprintFromHuman(humanRaw);
  const thresholds: Partial<ParityThresholds> = {};
  if (values["min-tool-sim"] !== undefined) thresholds.minToolSimilarity = num(values["min-tool-sim"] as string, 0.8);
  if (values["min-args-match"] !== undefined) thresholds.minArgsMatchRate = num(values["min-args-match"] as string, 0.8);
  if (values["allow-status-diff"] === true) thresholds.requireStatusMatch = false;
  const parity = compareBehavior(human, evaluation, thresholds);
  if (values.json === true) console.log(JSON.stringify(parity, null, 2));
  else console.log(renderParity(parity));
  process.exitCode = parity.passed ? 0 : 1;
}

async function cmdRuns(values: Record<string, unknown>): Promise<void> {
  const runs = await listRuns({ ...(runsRoot(values) ? { root: runsRoot(values) } : {}) });
  if (values.json === true) { console.log(JSON.stringify(runs, null, 2)); return; }
  for (const run of runs) console.log(`${run.runId}  target=${run.target}  ${run.passed}/${run.total} (${(run.passRate * 100).toFixed(1)}%)  suites=${run.suites.join(",")}  ${run.createdAt}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2), allowPositionals: true,
    options: {
      suite: { type: "string", multiple: true }, case: { type: "string", multiple: true }, target: { type: "string" }, concurrency: { type: "string" },
      "timeout-ms": { type: "string" }, label: { type: "string" }, seed: { type: "string" }, holdout: { type: "boolean" },
      reasoning: { type: "string" }, provider: { type: "string" }, session: { type: "boolean" },
      store: { type: "string" }, "store-dir": { type: "string" }, "resume-session": { type: "string" }, "resume-user": { type: "string" },
      offline: { type: "boolean" }, judge: { type: "boolean" }, json: { type: "boolean" }, quiet: { type: "boolean" }, "allow-failures": { type: "boolean" },
      "source-eval-config": { type: "string" }, "allow-private-model-data": { type: "boolean" },
      runs: { type: "string" }, run: { type: "string" }, baseline: { type: "string" }, candidate: { type: "string" },
      "holdout-run": { type: "string" }, threshold: { type: "string" }, sample: { type: "string" }, markdown: { type: "boolean" },
      blueprint: { type: "string" }, out: { type: "string" },
      eval: { type: "string" }, "human-file": { type: "string" }, "human-task": { type: "string", multiple: true },
      "human-session": { type: "string" }, token: { type: "string" }, "base-url": { type: "string" },
      "min-tool-sim": { type: "string" }, "min-args-match": { type: "string" }, "allow-status-diff": { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "help";
  const options = values as Record<string, unknown>;
  try {
    switch (command) {
      case "run": return await cmdRun(options);
      case "validate": return await cmdValidate(options);
      case "list": return await cmdList(options);
      case "report": return await cmdReport(options);
      case "analyze": return await cmdAnalyze(options);
      case "compare": return await cmdCompare(options);
      case "gate": return await cmdGate(options);
      case "gen": return await cmdGen(options);
      case "parity": return await cmdParity(options);
      case "runs": return await cmdRuns(options);
      case "help": case "--help": case "-h": console.log(USAGE); return;
      default: fail(`未知命令：${command}（node scripts/eval.ts help）`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

await main();

