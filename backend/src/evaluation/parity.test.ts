// Parity 自测：人类任务证据归一化、行为指纹、阈值判定、trace 文件读取。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compareBehavior, fingerprintFromEval, fingerprintFromHuman, loadEvalFingerprint, normalizeHumanEvidence,
} from "./parity.ts";
import { canonicalArgs, sha256 } from "../runtime/idempotency.ts";
import type { EvalResult, EvalRun, EvalTrace } from "./types.ts";

const savedArgs = { title: "CM对照通知", rawText: "CM对照通知 11月23日14:00", deadline: "2026-11-23", deadlineTime: "14:00" };

function humanEvidence(overrides: { toolName?: string; status?: string; withArgs?: boolean } = {}): unknown {
  const toolName = overrides.toolName ?? "save_to_inbox";
  const tasks = [{
    task: {
      id: "human-task-1", status: overrides.status ?? "succeeded", createdAt: 1000, updatedAt: 5000,
      usage: { tokens: 1000, toolCalls: 1 }, result: { summary: "已保存到信息中心，只有一条。" },
    },
    events: [
      { seq: 1, type: "llm.request", payload: {}, createdAt: 1 },
      { seq: 2, type: "tool.called", payload: { name: toolName }, createdAt: 2 },
      { seq: 3, type: "tool.result", payload: { ok: true, sourceUrls: ["https://example.com/notice?token=secret"] }, createdAt: 3 },
      { seq: 4, type: "llm.response", payload: { toolCalls: 0 }, createdAt: 4 },
      { seq: 5, type: "llm.request", payload: {}, createdAt: 5 },
    ],
  }];
  return {
    tasks,
    ...(overrides.withArgs ? { invocations: [{ toolName, argsHash: sha256(canonicalArgs(savedArgs)), startedAt: 2 }] } : {}),
  };
}

function evalResult(overrides: Partial<EvalResult> = {}): EvalResult {
  return {
    caseId: "CONV-001", category: "conversation", difficulty: "medium", source: "fixed", target: "live",
    status: "succeeded", passed: true, checks: [], durationMs: 4000,
    usage: { tokens: 1200, toolCalls: 1, costUsd: 0 }, replyPreview: "已保存到信息中心。", toolSequence: ["save_to_inbox"],
    ...overrides,
  };
}

function evalTrace(overrides: Partial<EvalTrace> = {}): EvalTrace {
  return {
    caseId: "CONV-001", target: "live", startedAt: 0, finishedAt: 4000,
    events: [
      { seq: 1, type: "tool.result", payload: { ok: true, sourceUrls: ["https://example.com/notice?token=secret"] }, at: 3 },
    ],
    llm: { requests: 2, rounds: [{ round: 1, toolCalls: 1 }], models: ["gemma"], telemetry: [] },
    tools: [{ seq: 1, name: "save_to_inbox", args: savedArgs, ok: true, resultPreview: "{}" }],
    steps: [], finalStatus: "succeeded", finalOutput: "已保存到信息中心，只有一条。",
    ...overrides,
  };
}

function evalRun(result: EvalResult, trace: EvalTrace): EvalRun {
  return {
    schemaVersion: 1, runId: "run-1", target: "live", suites: ["conversation"],
    startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), durationMs: 1,
    manifest: {
      runId: "run-1", target: "live", suites: ["conversation"], caseCount: 1, createdAt: new Date(0).toISOString(),
      git: { commit: "x", branch: "x", dirty: false }, node: process.version,
      model: { real: true }, systemPromptHash: "x", toolsHash: "x", datasetHashes: {}, concurrency: 1, offlineTools: false,
    },
    metrics: {
      total: 1, passed: 1, failed: 0, skipped: 0, exploratory: 0, passRate: 1,
      byCategory: {}, byDifficulty: {}, avgDurationMs: 1, avgTokens: 1, totalTokens: 1, avgToolCalls: 1,
      totalCostUsd: 0, failureCategories: {}, hardGateViolations: [],
    },
    results: [result],
  };
}

test("human evidence：归一化单任务/tasks/裸事件数组", () => {
  assert.equal(normalizeHumanEvidence({ task: { id: "t" }, events: [] }).tasks?.length, 1);
  assert.equal(normalizeHumanEvidence({ tasks: [{ task: { id: "a" }, events: [] }, { task: { id: "b" }, events: [] }] }).tasks?.length, 2);
  assert.equal(normalizeHumanEvidence([{ type: "tool.called", payload: { name: "x" } }]).tasks?.length, 1);
});

test("fingerprintFromHuman：工具序列/状态/来源/用量/参数哈希", () => {
  const fp = fingerprintFromHuman(humanEvidence({ withArgs: true }));
  assert.equal(fp.status, "succeeded");
  assert.deepEqual(fp.toolSequence, ["save_to_inbox"]);
  assert.equal(fp.llmRequests, 2);
  assert.equal(fp.tokens, 1000);
  assert.equal(fp.durationMs, 4000);
  assert.deepEqual(fp.sourceUrls, ["example.com/notice"]);
  assert.equal(fp.toolArgsHashes?.length, 1);
  assert.equal(fp.reply, "已保存到信息中心，只有一条。");
});

test("parity PASS：状态/工具/参数/来源一致（人类无参数时降级为警告）", () => {
  const human = fingerprintFromHuman(humanEvidence());
  const evaluation = fingerprintFromEval(evalRun(evalResult(), evalTrace()), evalResult(), evalTrace());
  const parity = compareBehavior(human, evaluation);
  assert.equal(parity.passed, true, parity.reasons.join("；"));
  assert.equal(parity.metrics.statusMatch, true);
  assert.equal(parity.metrics.toolExactMatch, true);
  assert.equal(parity.metrics.toolSimilarity, 1);
  assert.equal(parity.metrics.argsMatchRate, null);
  assert.ok(parity.warnings.some((warning) => /参数哈希/.test(warning)));
});

test("parity PASS：人类提供 invocations 时比较参数哈希", () => {
  const human = fingerprintFromHuman(humanEvidence({ withArgs: true }));
  const evaluation = fingerprintFromEval(evalRun(evalResult(), evalTrace()), evalResult(), evalTrace());
  const parity = compareBehavior(human, evaluation);
  assert.equal(parity.metrics.argsMatchRate, 1);
  assert.equal(parity.passed, true, parity.reasons.join("；"));
});

test("parity FAIL：工具序列差异过大 / 状态不一致 / 参数哈希不一致", () => {
  const human = fingerprintFromHuman(humanEvidence({ withArgs: true }));
  const wrongTrace = evalTrace({ tools: [{ seq: 1, name: "web_search", args: { query: "x" }, ok: true, resultPreview: "{}" }] });
  const wrongTools = fingerprintFromEval(evalRun(evalResult(), wrongTrace), evalResult(), wrongTrace);
  const toolMismatch = compareBehavior(human, wrongTools);
  assert.equal(toolMismatch.passed, false);
  assert.ok(toolMismatch.reasons.some((reason) => /工具序列相似度/.test(reason)));

  const wrongStatus = fingerprintFromEval(evalRun(evalResult({ status: "failed" }), evalTrace()), evalResult({ status: "failed" }), evalTrace());
  const statusMismatch = compareBehavior(human, wrongStatus);
  assert.equal(statusMismatch.passed, false);
  assert.ok(statusMismatch.reasons.some((reason) => /状态不一致/.test(reason)));

  const wrongArgs = fingerprintFromEval(
    evalRun(evalResult(), evalTrace({ tools: [{ seq: 1, name: "save_to_inbox", args: { ...savedArgs, deadline: "2026-11-24" }, ok: true, resultPreview: "{}" }] })),
    evalResult(), evalTrace({ tools: [{ seq: 1, name: "save_to_inbox", args: { ...savedArgs, deadline: "2026-11-24" }, ok: true, resultPreview: "{}" }] }),
  );
  const argsMismatch = compareBehavior(human, wrongArgs);
  assert.equal(argsMismatch.metrics.argsMatchRate, 0);
  // 默认参数差异只告警不判失败（模型采样波动），严格模式由调用方显式开启。
  assert.equal(argsMismatch.passed, true);
  assert.ok(argsMismatch.warnings.some((warning) => /参数哈希一致率/.test(warning)));
  const strictArgs = compareBehavior(human, wrongArgs, { minArgsMatchRate: 0.8 });
  assert.equal(strictArgs.passed, false);
  assert.ok(strictArgs.reasons.some((reason) => /参数哈希一致率/.test(reason)));

  const relaxed = compareBehavior(human, wrongStatus, { requireStatusMatch: false, minToolSimilarity: 0 });
  assert.equal(relaxed.passed, true, relaxed.reasons.join("；"));
});

test("parity：工具序列错位时参数哈希只在同名位置比较（避免误导性 0%）", () => {
  const human = fingerprintFromHuman(humanEvidence({ withArgs: true }));
  // 评测序列在开头多一个工具 → 位置错开；同名对齐后参数应一致。
  const shiftedTrace = evalTrace({
    tools: [
      { seq: 1, name: "list_opportunities", args: {}, ok: true, resultPreview: "{}" },
      { seq: 2, name: "save_to_inbox", args: savedArgs, ok: true, resultPreview: "{}" },
    ],
  });
  const shifted = fingerprintFromEval(evalRun(evalResult(), shiftedTrace), evalResult(), shiftedTrace);
  const parity = compareBehavior(human, shifted, { minToolSimilarity: 0 });
  assert.equal(parity.metrics.argsMatchRate, 1);
  assert.ok(parity.warnings.some((warning) => /工具序列非精确一致/.test(warning)));
});

test("loadEvalFingerprint：从 run 的 trace 文件读取评测行为指纹", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "campusmate-eval-parity-"));
  const traceFile = path.join(dir, "CONV-001.json");
  await writeFile(traceFile, JSON.stringify(evalTrace()), "utf8");
  const result = evalResult({ tracePath: traceFile });
  const run = evalRun(result, evalTrace());
  const fp = loadEvalFingerprint(run, "CONV-001");
  assert.equal(fp.source, "eval");
  assert.deepEqual(fp.toolSequence, ["save_to_inbox"]);
  assert.throws(() => loadEvalFingerprint(run, "MISSING"), /没有用例/);
});
