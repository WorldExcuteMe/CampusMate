import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBudget, budgetStopSummary } from "./budget.ts";
import { RecoveryEngine, initialRecoveryState } from "./recovery.ts";
import { MetricsCollector } from "./monitoring.ts";
import { DEFAULT_BUDGET, EMPTY_USAGE } from "./types.ts";

test("Budget 四维硬停（含 costUsd）", () => {
  assert.equal(checkBudget({ ...EMPTY_USAGE }, DEFAULT_BUDGET).exceeded, false);
  assert.equal(checkBudget({ ...EMPTY_USAGE, tokens: DEFAULT_BUDGET.tokens }, DEFAULT_BUDGET).dimension, "tokens");
  assert.equal(checkBudget({ ...EMPTY_USAGE, toolCalls: DEFAULT_BUDGET.toolCalls }, DEFAULT_BUDGET).dimension, "toolCalls");
  assert.equal(checkBudget({ ...EMPTY_USAGE, wallMs: DEFAULT_BUDGET.wallMs }, DEFAULT_BUDGET).dimension, "wallMs");
  assert.equal(checkBudget({ ...EMPTY_USAGE, costUsd: DEFAULT_BUDGET.costUsd }, DEFAULT_BUDGET).dimension, "costUsd");
});

test("Budget 停止说明含剩余预算", () => {
  const c = checkBudget({ ...EMPTY_USAGE, costUsd: 1 }, DEFAULT_BUDGET);
  const s = budgetStopSummary(c, ["web_search"]);
  assert.match(s, /costUsd 预算超限/);
  assert.match(s, /已完成 1 步/);
});

test("RecoveryEngine 差异化策略", () => {
  const eng = new RecoveryEngine();
  assert.equal(eng.decide("transport", initialRecoveryState()).action, "backoff");
  assert.equal(eng.decide("rate_limit", initialRecoveryState()).action, "backoff");
  assert.equal(eng.decide("invalid_model_output", initialRecoveryState()).action, "repair");
  assert.equal(eng.decide("tool_transient", initialRecoveryState()).action, "retry");
  assert.equal(eng.decide("tool_permanent", initialRecoveryState()).action, "replan");
  assert.equal(eng.decide("permission", initialRecoveryState()).action, "pause");
  assert.equal(eng.decide("budget", initialRecoveryState()).action, "stop");
  assert.equal(eng.decide("evaluation", initialRecoveryState()).action, "reexecute");
});

test("RecoveryEngine 重试上限 → stop（禁止无限）", () => {
  const eng = new RecoveryEngine({ maxRetries: 2 });
  const st = initialRecoveryState();
  assert.equal(eng.decide("transport", st).action, "backoff");
  assert.equal(eng.decide("transport", st).action, "backoff");
  const third = eng.decide("transport", st);
  assert.equal(third.action, "stop");
  assert.equal(third.exhausted, true);
});

test("RecoveryEngine 重规划上限 → stop；验收重执行上限 → pause", () => {
  const eng = new RecoveryEngine({ maxReplans: 1, maxReexecutes: 1 });
  const st = initialRecoveryState();
  assert.equal(eng.decide("tool_permanent", st).action, "replan");
  assert.equal(eng.decide("tool_permanent", st).action, "stop");
  const st2 = initialRecoveryState();
  assert.equal(eng.decide("evaluation", st2).action, "reexecute");
  assert.equal(eng.decide("evaluation", st2).action, "pause");
});

test("RecoveryEngine backoff 指数退避", () => {
  const eng = new RecoveryEngine({ baseDelayMs: 500 });
  const st = initialRecoveryState();
  const d1 = eng.decide("transport", st).delayMs;
  const d2 = eng.decide("transport", st).delayMs;
  assert.equal(d1, 500);
  assert.equal(d2, 1000);
});

test("MetricsCollector 指标与关联链", () => {
  const m = new MetricsCollector();
  m.taskSucceeded(1000, 500, 0.001);
  m.taskSucceeded(3000, 300, 0.0006);
  m.taskFailed();
  m.toolCalled(false); m.toolCalled(true);
  m.evaluated(true); m.evaluated(false);
  m.setQueueDepth(3); m.leaseExpired(); m.heartbeat();
  m.trace({ taskId: "t1", stepId: "s1", toolInvocationId: "i1", eventId: 1 });
  const s = m.snapshot();
  assert.equal(s.taskSuccess, 2);
  assert.equal(s.taskFailure, 1);
  assert.ok(Math.abs(s.taskSuccessRate - 2 / 3) < 1e-9);
  assert.equal(s.toolFailureRate, 0.5);
  assert.equal(s.evaluatorRejectionRate, 0.5);
  assert.equal(s.avgTaskDurationMs, 2000);
  assert.equal(s.queueDepth, 3);
  assert.equal(s.leaseExpirations, 1);
  assert.equal(m.getTraces("t1")[0].toolInvocationId, "i1");
});