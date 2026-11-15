// Benchmark Runner：驱动真实 runAgentLoop 执行 deterministic/integration 用例，确定性检查。
// manual_realworld → BLOCKED_EXTERNAL（需开发者真实环境）。不伪造结果。
import { runAgentLoop } from "../../src/core/agent-loop.ts";
import type { LlmTransport } from "../../src/core/llm.ts";
import { LlmTransportError } from "../../src/core/errors.ts";
import type { ChatResult, ChatMessage } from "../../src/core/types.ts";
import { DEFAULT_BUDGET } from "../../src/core/types.ts";
import { CASES, TRANSPORT_FAIL_CASES } from "./cases.ts";
import type { BenchmarkCase, BenchmarkResult, BenchmarkMetrics, BenchmarkRunContext } from "./types.ts";

class ScriptTransport implements LlmTransport {
  i = 0;
  script: Partial<ChatResult>[];
  constructor(script: Partial<ChatResult>[]) { this.script = script; }
  async chat(_opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const m = this.script[Math.min(this.i, this.script.length - 1)] ?? { content: "" }; this.i++;
    return { content: m.content ?? "", toolCalls: m.toolCalls ?? [], usage: m.usage ?? { input: 10, output: 10 }, model: m.model ?? "bench" };
  }
}
const failTransport: LlmTransport = { async chat() { throw new LlmTransportError("HTTP 503: upstream down"); } };

export async function runCase(c: BenchmarkCase): Promise<BenchmarkResult> {
  const start = Date.now();
  if (c.evaluationMethod === "manual_realworld") {
    return { id: c.id, category: c.category, passed: false, checks: [], status: "BLOCKED_EXTERNAL", costUsd: 0, durationMs: 0, toolCalls: 0, humanIntervention: 0, failureReason: "需开发者真实高校环境" };
  }
  const transport = TRANSPORT_FAIL_CASES.has(c.id) ? failTransport : new ScriptTransport(c.script ?? [{ content: "" }]);
  const r = await runAgentLoop({
    system: "你是 CampusMate 校园管家。", user: c.userGoal,
    deps: { transport, tools: c.tools ?? [], budget: c.budget ?? DEFAULT_BUDGET, executeTool: c.toolImpl ?? (async () => "{}") },
  });
  const ctx: BenchmarkRunContext = { reply: r.reply, actions: r.actions, toolCalls: r.usage.toolCalls, mock: r.mock, budgetExceeded: r.budgetExceeded, paused: r.paused, rounds: r.rounds };
  const checks = (c.checks ?? []).map((ck) => ({ name: ck.name, passed: ck.fn(ctx), required: ck.required }));
  const passed = checks.filter((x) => x.required).every((x) => x.passed);
  return { id: c.id, category: c.category, passed, checks, status: passed ? "VERIFIED" : "FAILED", costUsd: r.usage.costUsd, durationMs: Date.now() - start, toolCalls: r.usage.toolCalls, humanIntervention: r.paused ? 1 : 0, failureReason: passed ? undefined : checks.filter((x) => x.required && !x.passed).map((x) => x.name).join("；") };
}

export async function runAll(): Promise<BenchmarkResult[]> {
  const out: BenchmarkResult[] = [];
  for (const c of CASES) out.push(await runCase(c));
  return out;
}

export function computeMetrics(results: BenchmarkResult[]): BenchmarkMetrics {
  const runnable = results.filter((r) => r.status !== "BLOCKED_EXTERNAL");
  const verified = runnable.filter((r) => r.passed);
  const byCategory: BenchmarkMetrics["byCategory"] = {};
  for (const r of results) {
    const g = byCategory[r.category] ?? { total: 0, passed: 0, rate: 0 };
    g.total++; if (r.passed) g.passed++; g.rate = g.passed / g.total; byCategory[r.category] = g;
  }
  const evidenceCases = results.filter((r) => r.category === "evidence");
  const recoveryCases = results.filter((r) => r.category === "recovery");
  const envCases = results.filter((r) => r.category === "environment");
  const rate = (arr: BenchmarkResult[]) => arr.length ? arr.filter((r) => r.passed).length / arr.length : 0;
  return {
    total: results.length, verified: verified.length, failed: runnable.filter((r) => !r.passed).length, blocked: results.filter((r) => r.status === "BLOCKED_EXTERNAL").length,
    endToEndSuccessRate: runnable.length ? verified.length / runnable.length : 0,
    byCategory,
    evidenceCoverage: rate(evidenceCases),
    recoverySuccessRate: rate(recoveryCases),
    environmentGeneralizationRate: rate(envCases),
    humanInterventionRate: results.length ? results.reduce((s, r) => s + r.humanIntervention, 0) / results.length : 0,
    avgCostUsd: runnable.length ? runnable.reduce((s, r) => s + r.costUsd, 0) / runnable.length : 0,
    avgDurationMs: runnable.length ? runnable.reduce((s, r) => s + r.durationMs, 0) / runnable.length : 0,
  };
}