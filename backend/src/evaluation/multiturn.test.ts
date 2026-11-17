// 多轮/会话级评测自测：数据集解析、评估器逐轮检查、scripted history、api-memory 真实 session。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSuite, parseSuite } from "./dataset.ts";
import { evaluateCase } from "./evaluator.ts";
import { ScriptedTarget } from "./targets/scripted.ts";
import { ApiTarget } from "./targets/api.ts";
import type { EvalCase, EvalObservation, EvalTurnObservation, TargetOptions } from "./types.ts";

const options: TargetOptions = { concurrency: 1, defaultTimeoutMs: 30_000, offlineTools: true, now: Date.now };
test("api-memory stops a conversation at an unexpected pause instead of queuing an unreachable next turn", async () => {
  const c = multiTurnCase({id:"MT-pause-boundary",budget:{tokens:1,toolCalls:5,wallMs:60000,costUsd:1},turns:[
    {prompt:"先给一个说明",script:[{content:"预算已用完",usage:{input:2,output:2}}],checks:[{kind:"no_write"}]},
    {prompt:"继续第二步",script:[{content:"不能跳过前轮暂停"}],checks:[{kind:"no_write"}]},
  ]});
  const target = new ApiTarget("script"); await target.setup(options);
  try {const obs=await target.run(c,{timeoutMs:300});assert.equal(obs.turns?.length,1);assert.equal(obs.status,"paused");}
  finally {await target.dispose();}
});
test("api-memory switches independent sessions under the same owner and returns to the first session", async () => {
  const c = multiTurnCase({ id: "MT-session-isolation", turns: [
    { sessionKey: "first", prompt: "本会话暗号青禾，只确认，不写档案。", script: [{ content: "确认青禾" }], checks: [{ kind: "no_write" }] },
    { sessionKey: "second", prompt: "新会话，不知道其他会话暗号。", script: [{ content: "未知" }], checks: [{ kind: "no_write" }] },
    { sessionKey: "first", prompt: "回到最初会话，复述暗号。", script: [{ content: "青禾" }], checks: [{ kind: "no_write" }] },
  ], checks: [{ kind: "status", in: ["succeeded"] }] });
  const parsed = parseSuite({ schemaVersion: 1, id: "session-isolation", cases: [c] });
  assert.equal(parsed.cases[0].turns![1].sessionKey, "second");
  const target = new ApiTarget("script"); await target.setup(options);
  try {
    const obs = await target.run(parsed.cases[0], { timeoutMs: 10000 });
    const ids = obs.turns!.map(turn => turn.trace.session?.id);
    assert(ids.every(Boolean)); assert.equal(ids[0], ids[2]); assert.notEqual(ids[0], ids[1]);
  } finally { await target.dispose(); }
});

function multiTurnCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "MT-001", category: "conversation", difficulty: "easy", source: "fixed",
    prompt: "第一轮：先只预览，不要写入：CM多轮测试通知 11月23日14:00。",
    turns: [
      {
        prompt: "第一轮：先只预览，不要写入：CM多轮测试通知 11月23日14:00。",
        script: [{ content: "预览：CM多轮测试通知，11月23日14:00。未写入。" }],
        checks: [{ kind: "no_write" }, { kind: "reply_includes", any: ["预览"] }],
        expectedStatus: "succeeded",
      },
      {
        prompt: "第二轮：我确认，请保存到信息中心，只保存一条。",
        script: [
          { toolCalls: [{ name: "save_to_inbox", arguments: { title: "CM多轮测试通知", rawText: "CM多轮测试通知 11月23日14:00", deadline: "2026-11-23", deadlineTime: "14:00" } }] },
          { content: "已保存到信息中心，只有一条。" },
        ],
        checks: [{ kind: "inbox_saved", min: 1, max: 1, titleIncludes: "CM多轮测试通知" }],
        expectedStatus: "succeeded",
      },
    ],
    checks: [{ kind: "status", in: ["succeeded"] }, { kind: "inbox_saved", min: 1, max: 1 }],
    ...overrides,
  };
}

test("dataset：多轮用例解析、prompt 首轮兜底、case.script 与 turns 冲突报错", () => {
  const suite = loadSuite("conversation");
  const conv = suite.cases.find((item) => item.id === "CONV-001");
  assert.ok(conv?.turns && conv.turns.length === 3);
  assert.match(conv.prompt, /整理这条通知/);
  assert.ok(conv.turns![1].checks?.some((check) => check.kind === "tool_called"));
  assert.throws(() => parseSuite({
    schemaVersion: 1, id: "bad-suite", name: "bad",
    cases: [{ id: "BAD-001", category: "test", prompt: "x", script: [{ content: "a" }], turns: [{ prompt: "y", checks: [{ kind: "no_write" }] }] }],
  }), /多轮用例请使用 turns\[\]\.script/);
});

test("evaluator：多轮逐轮检查 + 会话级检查；某轮失败则用例失败", async () => {
  const c = multiTurnCase();
  const turns: EvalTurnObservation[] = [
    turnObservation(c, 1, "预览：未写入。", "succeeded"),
    turnObservation(c, 2, "已保存到信息中心。", "succeeded"),
  ];
  turns[1].business.inbox = [{ id: "inbox-1", title: "CM多轮测试通知" }];
  const obs = aggregate(c, turns);
  const result = await evaluateCase(c, obs);
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter((check) => !check.passed)));
  assert.ok(result.checks.some((check) => check.id === "第1轮-no_write-1"));
  assert.ok(result.checks.some((check) => check.id === "第2轮-inbox_saved-1"));

  const failingTurns = [
    turnObservation(c, 1, "直接写入并回复：已保存。", "succeeded"),
    turnObservation(c, 2, "已保存。", "succeeded"),
  ];
  failingTurns[1].business.inbox = [{ id: "inbox-1", title: "CM多轮测试通知" }];
  // 第一轮应答违反 no_write（写工具成功），应判失败。
  failingTurns[0].toolCalls = [{ seq: 1, name: "save_to_inbox", args: {}, ok: true, resultPreview: "{}" }];
  const failed = await evaluateCase(c, aggregate(c, failingTurns));
  assert.equal(failed.passed, false);
  assert.ok(failed.checks.some((check) => check.id.startsWith("第1轮-") && !check.passed));

  // 轮数不完整（第二轮未执行）必须失败
  const partial = aggregate(c, [turns[0]]);
  const incomplete = await evaluateCase(c, partial);
  assert.equal(incomplete.passed, false);
  assert.ok(incomplete.checks.some((check) => check.id === "turns_complete" && !check.passed));
});

test("scripted target：多轮顺序执行、历史注入、业务事实累积", async () => {
  const target = new ScriptedTarget();
  await target.setup(options);
  try {
    const c = multiTurnCase();
    const obs = await target.run(c, { timeoutMs: 20_000 });
    assert.equal(obs.turns?.length, 2);
    assert.equal(obs.status, "succeeded");
    assert.equal(obs.turns![0].toolCalls.length, 0);
    assert.equal(obs.turns![1].toolCalls.length, 1);
    assert.equal(obs.turns![1].toolCalls[0].name, "save_to_inbox");
    assert.equal(obs.business.inbox.length, 1);
    assert.match(obs.reply, /已保存/);
    assert.equal(obs.trace.turns?.length, 2);
    const evaluated = await evaluateCase(c, obs);
    assert.equal(evaluated.passed, true, JSON.stringify(evaluated.checks.filter((check) => !check.passed)));
  } finally {
    await target.dispose();
  }
});

test("api-memory target：真实 session + 逐轮 task/turn + 历史注入 + 会话消息", async () => {
  const target = new ApiTarget("script");
  await target.setup({ ...options, concurrency: 1 });
  try {
    const c = multiTurnCase();
    const obs = await target.run(c, { timeoutMs: 30_000 });
    assert.equal(obs.turns?.length, 2);
    assert.equal(obs.status, "succeeded");
    assert.equal(obs.business.inbox.length, 1);
    assert.ok(obs.trace.session?.id, "多轮必须创建真实 session");
    assert.ok((obs.trace.session?.messageCount ?? 0) >= 4, `session 应包含多轮消息，实际 ${obs.trace.session?.messageCount}`);
    assert.equal(obs.trace.turns?.length, 2);
    assert.equal(obs.toolCalls.length, 1);
    const evaluated = await evaluateCase(c, obs);
    assert.equal(evaluated.passed, true, JSON.stringify(evaluated.checks.filter((check) => !check.passed)));
  } finally {
    await target.dispose();
  }
});

// ── helpers ────────────────────────────────────────────────────────────────
function turnObservation(c: EvalCase, turn: number, reply: string, status: EvalTurnObservation["status"]): EvalTurnObservation {
  const trace = {
    caseId: c.id, target: "scripted" as const, startedAt: 0, finishedAt: 1, events: [],
    llm: { requests: 1, rounds: [{ round: 1, toolCalls: 0 }], models: ["scripted-model"], telemetry: [] },
    tools: [], steps: [], finalStatus: status, finalOutput: reply,
  };
  return {
    turn, prompt: c.turns?.[turn - 1]?.prompt ?? `第${turn}轮`, status, reply,
    toolCalls: [], trace, business: { inbox: [], opportunities: [], pendingApprovals: 0, artifacts: [], evidenceVerified: 0 },
    usage: { tokens: 10, toolCalls: 0, wallMs: 1, costUsd: 0 }, durationMs: 1, mock: false,
  };
}

function aggregate(c: EvalCase, turns: EvalTurnObservation[]): EvalObservation {
  const last = turns[turns.length - 1];
  return {
    case: c, target: "scripted", status: last.status, reply: last.reply,
    toolCalls: turns.flatMap((turn) => turn.toolCalls), trace: last.trace, business: last.business,
    usage: { tokens: 20, toolCalls: 0, wallMs: 2, costUsd: 0 }, durationMs: 2, mock: false,
    turns,
  };
}
