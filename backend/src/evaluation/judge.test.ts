// LlmJudge 单测：不触网，用脚本 transport 验证 JSON 解析、门槛、重试与降级语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmJudge, buildJudgePrompt } from "./judge.ts";
import type { LlmTransport } from "../core/llm.ts";
import type { ChatResult } from "../core/types.ts";
import type { EvalCase, EvalObservation } from "./types.ts";

const caseFixture = (overrides: Partial<EvalCase> = {}): EvalCase => ({
  id: "JUDGE-001", category: "inbox", difficulty: "medium", source: "fixed",
  prompt: "把通知保存到信息中心并说明结果。",
  acceptanceNotes: ["必须真实保存一条", "不得声称未完成的事"],
  checks: [{ kind: "status", in: ["succeeded"] }],
  ...overrides,
});

const observation = (overrides: Partial<EvalObservation> = {}): EvalObservation => ({
  case: caseFixture(),
  target: "api-memory",
  status: "succeeded",
  reply: "已保存到信息中心：CM讲座，11月23日14:00。",
  toolCalls: [],
  trace: {
    caseId: "JUDGE-001", target: "api-memory", startedAt: 0, finishedAt: 1, events: [],
    llm: { requests: 1, rounds: [{ round: 1, toolCalls: 0 }], models: ["fake"], telemetry: [] },
    tools: [], steps: [], finalStatus: "succeeded", finalOutput: "已保存。",
  },
  business: { inbox: [], opportunities: [], pendingApprovals: 0, artifacts: [], evidenceVerified: 0 },
  usage: { tokens: 10, toolCalls: 0, wallMs: 1, costUsd: 0 },
  durationMs: 1, mock: false,
  ...overrides,
});

function scriptedTransport(contents: Array<string | Error>): { transport: LlmTransport; calls: () => number } {
  let index = 0;
  return {
    transport: {
      async chat(): Promise<ChatResult> {
        const item = contents[Math.min(index, contents.length - 1)];
        index++;
        if (item instanceof Error) throw item;
        return { content: item ?? "", toolCalls: [], usage: { input: 10, output: 10 }, model: "judge-fake" };
      },
    },
    calls: () => index,
  };
}

test("LlmJudge：解析合法 JSON，无 minScore 时采用 verdict.passed", async () => {
  const { transport } = scriptedTransport([JSON.stringify({
    score: 82, passed: true, reason: "真实保存且说明清楚",
    dimensions: { 理解: 90, 规划: 80, 执行: 85, 证据: 70, 表达: 88 },
  })]);
  const verdict = await new LlmJudge(transport).evaluate(caseFixture(), observation());
  assert.equal(verdict.score, 82);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.dimensions?.["执行"], 85);
  assert.match(verdict.reason, /真实保存/);
});

test("LlmJudge：用例声明 minScore 时以分数门槛为准", async () => {
  const { transport } = scriptedTransport([JSON.stringify({ score: 70, passed: true, reason: "基本完成" })]);
  const verdict = await new LlmJudge(transport).evaluate(caseFixture({ judge: { minScore: 90 } }), observation());
  assert.equal(verdict.score, 70);
  assert.equal(verdict.passed, false);
});

test("LlmJudge：容忍 ```json 代码块包裹", async () => {
  const { transport } = scriptedTransport(["```json\n{\"score\": 66, \"passed\": true, \"reason\": \"可用\"}\n```"]);
  const verdict = await new LlmJudge(transport).evaluate(caseFixture(), observation());
  assert.equal(verdict.score, 66);
  assert.equal(verdict.passed, true);
});

test("LlmJudge：非法输出重试一次；第二次合法则成功", async () => {
  const { transport, calls } = scriptedTransport(["这不是 JSON", JSON.stringify({ score: 75, passed: true, reason: "第二次合法" })]);
  const verdict = await new LlmJudge(transport).evaluate(caseFixture(), observation());
  assert.equal(verdict.score, 75);
  assert.equal(calls(), 2);
});

test("LlmJudge：两次都非法时抛错（由 evaluator 降级为失败检查，不崩溃）", async () => {
  const { transport } = scriptedTransport(["bad", "still bad"]);
  await assert.rejects(() => new LlmJudge(transport).evaluate(caseFixture(), observation()), /Judge 评分失败/);
});

test("buildJudgePrompt：包含任务、验收标准、轨迹摘要与回复，且要求只输出 JSON", () => {
  const prompt = buildJudgePrompt(caseFixture(), observation());
  assert.match(prompt, /把通知保存到信息中心/);
  assert.match(prompt, /必须真实保存一条/);
  assert.match(prompt, /执行轨迹摘要/);
  assert.match(prompt, /已保存到信息中心/);
  assert.match(prompt, /只输出 JSON/);
});
