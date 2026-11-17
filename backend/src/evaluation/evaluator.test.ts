// evaluator.ts 单测：隐式 + 声明式检查组合、passed 判定、Judge 通过/缺失/抛错/非法返回。
// 用 node:test + node:assert/strict；Judge 全部用内存桩，不触网、不读库。
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCase } from "./evaluator.ts";
import type { CheckResult, EvalCase, EvalCheck, EvalObservation, Judge, JudgeVerdict, TraceToolCall } from "./types.ts";

// ── 夹具 ────────────────────────────────────────────────────────────────────
const baseCase = (checks: EvalCheck[], judge?: EvalCase["judge"]): EvalCase => ({
  id: "case-1",
  category: "misc",
  difficulty: "easy",
  source: "fixed",
  prompt: "测试提示",
  checks,
  ...(judge ? { judge } : {}),
});

const call = (seq: number, name: string, options: Partial<TraceToolCall> = {}): TraceToolCall => ({
  seq, name, args: {}, ok: true, resultPreview: "", ...options,
});

interface ObsOptions {
  status?: EvalObservation["status"];
  reply?: string;
  calls?: TraceToolCall[];
  error?: string;
  durationMs?: number;
  tokens?: number;
}

function makeObs(evalCase: EvalCase, options: ObsOptions = {}): EvalObservation {
  const calls = options.calls ?? [];
  const status = options.status ?? "succeeded";
  const reply = options.reply ?? "";
  return {
    case: evalCase,
    target: "scripted",
    status,
    reply,
    toolCalls: calls,
    trace: {
      caseId: evalCase.id,
      target: "scripted",
      startedAt: 0,
      finishedAt: options.durationMs ?? 0,
      events: [],
      llm: { requests: 0, rounds: [], models: [], telemetry: [] },
      tools: calls,
      steps: [],
      finalStatus: status,
      finalOutput: reply,
      ...(options.error ? { error: options.error } : {}),
    },
    business: { inbox: [], opportunities: [], pendingApprovals: 0, artifacts: [], evidenceVerified: 0 },
    usage: { tokens: options.tokens ?? 0, toolCalls: calls.length, wallMs: options.durationMs ?? 0, costUsd: 0 },
    durationMs: options.durationMs ?? 0,
    mock: false,
    ...(options.error ? { error: options.error } : {}),
  };
}

const judgeReturning = (verdict: JudgeVerdict): Judge => ({ name: "test-judge", evaluate: async () => verdict });
const judgeThrowing = (message: string): Judge => ({
  name: "test-judge",
  evaluate: async () => { throw new Error(message); },
});

function judgeCheckOf(checks: CheckResult[]): CheckResult | undefined {
  return checks.find((check) => check.kind === "judge");
}

// ── 基础组合 ────────────────────────────────────────────────────────────────
test("evaluateCase：隐式 + 声明 required 全过 → passed，runtime_execution 排在最前", async () => {
  const evalCase = baseCase([{ kind: "no_write" }]);
  const result = await evaluateCase(evalCase, makeObs(evalCase, { reply: "已完成" }));
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].id, "runtime_execution");
  assert.equal(result.checks[0].required, true);
  assert.equal(result.failureCategory, undefined);
  assert.equal(result.failureReason, undefined);
});

test("evaluateCase：required=false 的声明检查失败不阻断通过", async () => {
  const evalCase = baseCase([{ kind: "tool_called", name: "web_search", required: false }]);
  const result = await evaluateCase(evalCase, makeObs(evalCase));
  assert.equal(result.passed, true);
  const optional = result.checks.find((check) => check.kind === "tool_called");
  assert.equal(optional?.passed, false);
  assert.equal(optional?.required, false);
});

test("evaluateCase：隐式运行时失败 → 用例失败并归因 runtime_error", async () => {
  const evalCase = baseCase([{ kind: "no_write" }]);
  const result = await evaluateCase(evalCase, makeObs(evalCase, { status: "error", error: "模型调用超时 120000ms" }));
  assert.equal(result.passed, false);
  assert.equal(result.failureCategory, "runtime_error");
  assert.match(result.failureReason ?? "", /模型调用超时 120000ms/);
});

test("evaluateCase：声明检查失败 → failureCategory 按检查 kind 映射", async () => {
  const evalCase = baseCase([{ kind: "tool_called", name: "web_search" }]);
  const result = await evaluateCase(evalCase, makeObs(evalCase));
  assert.equal(result.passed, false);
  assert.equal(result.failureCategory, "tool_selection_error");
  assert.match(result.failureReason ?? "", /web_search/);
});

// ── Judge 集成 ──────────────────────────────────────────────────────────────
test("evaluateCase：Judge 达到 minScore → judge 检查 required 且通过，detail 含分数", async () => {
  const evalCase = baseCase([], { minScore: 70, rubric: "准确性" });
  const judge = judgeReturning({ score: 88, passed: true, reason: "回答准确", dimensions: { accuracy: 90 } });
  const result = await evaluateCase(evalCase, makeObs(evalCase), judge);
  assert.equal(result.passed, true);
  const check = judgeCheckOf(result.checks);
  assert.ok(check);
  assert.equal(check.required, true);
  assert.equal(check.passed, true);
  assert.match(check.detail, /88\/100/);
  assert.match(check.detail, /accuracy/);
});

test("evaluateCase：Judge 低于 minScore → 用例失败并归因 response_quality", async () => {
  const evalCase = baseCase([], { minScore: 80 });
  const judge = judgeReturning({ score: 60, passed: false, reason: "缺少来源引用" });
  const result = await evaluateCase(evalCase, makeObs(evalCase), judge);
  assert.equal(result.passed, false);
  assert.equal(result.failureCategory, "response_quality");
  const check = judgeCheckOf(result.checks);
  assert.equal(check?.passed, false);
  assert.match(check?.detail ?? "", /60\/100/);
});

test("evaluateCase：无 minScore 时 judge 检查 required=false，判定失败不影响通过", async () => {
  const evalCase = baseCase([], { rubric: "仅记录不设门槛" });
  const judge = judgeReturning({ score: 40, passed: false, reason: "一般" });
  const result = await evaluateCase(evalCase, makeObs(evalCase), judge);
  assert.equal(result.passed, true);
  const check = judgeCheckOf(result.checks);
  assert.ok(check);
  assert.equal(check.required, false);
  assert.equal(check.passed, false);
});

test("evaluateCase：Judge 抛错降级为失败检查，不向调用方抛出", async () => {
  const evalCase = baseCase([], { minScore: 60 });
  const result = await evaluateCase(evalCase, makeObs(evalCase), judgeThrowing("provider 503"));
  assert.equal(result.passed, false);
  const check = judgeCheckOf(result.checks);
  assert.ok(check);
  assert.equal(check.passed, false);
  assert.equal(check.required, true);
  assert.match(check.detail, /provider 503/);

  // 无 minScore 时同样的抛错不阻断用例，只留下非 required 失败检查。
  const lenientCase = baseCase([]);
  const lenient = await evaluateCase(lenientCase, makeObs(lenientCase), judgeThrowing("boom"));
  assert.equal(lenient.passed, true);
  assert.equal(judgeCheckOf(lenient.checks)?.required, false);
});

test("evaluateCase：未注入 Judge → 不产生 judge 检查", async () => {
  const evalCase = baseCase([{ kind: "no_write" }], { minScore: 70 });
  const result = await evaluateCase(evalCase, makeObs(evalCase));
  assert.equal(result.checks.some((check) => check.kind === "judge"), false);
  assert.equal(result.passed, true);
});

test("evaluateCase：Judge 返回非法结果 → 失败检查（required 依 minScore）", async () => {
  const broken: Judge = {
    name: "broken-judge",
    evaluate: async () => ({ reason: "缺少 score" } as unknown as JudgeVerdict),
  };
  const evalCase = baseCase([], { minScore: 50 });
  const result = await evaluateCase(evalCase, makeObs(evalCase), broken);
  assert.equal(result.passed, false);
  const check = judgeCheckOf(result.checks);
  assert.equal(check?.required, true);
  assert.match(check?.detail ?? "", /非法结果/);

  const lenientCase = baseCase([]);
  const lenient = await evaluateCase(lenientCase, makeObs(lenientCase), broken);
  assert.equal(lenient.passed, true);
  assert.equal(judgeCheckOf(lenient.checks)?.required, false);
});

test("evaluateCase：verdict.passed=true 但分数低于 minScore → 以门槛为准失败", async () => {
  const evalCase = baseCase([], { minScore: 90 });
  const judge = judgeReturning({ score: 75, passed: true, reason: "尚可" });
  const result = await evaluateCase(evalCase, makeObs(evalCase), judge);
  assert.equal(result.passed, false);
  assert.equal(judgeCheckOf(result.checks)?.passed, false);
});
