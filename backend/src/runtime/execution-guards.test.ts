import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../core/agent-loop.ts";
import { DEFAULT_BUDGET, EMPTY_USAGE, type ChatResult, type ToolDef } from "../core/types.ts";
import type { LlmTransport } from "../core/llm.ts";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";

const tools: ToolDef[] = [{ type: "function", function: { name: "save_to_inbox", description: "fixture", parameters: { type: "object" } } }];
const call = (i: number) => ({ id: `call-${i}`, type: "function" as const, function: { name: "save_to_inbox", arguments: JSON.stringify({ title: `item-${i}` }) } });
function script(responses: Partial<ChatResult>[]) {
  let requests = 0;
  const transport: LlmTransport = { async chat() {
    const value = responses[Math.min(requests++, responses.length - 1)];
    return { content: "", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture", ...value };
  } };
  return { transport, requests: () => requests };
}

test("native batch of 3, tool budget 1: execute exactly 1 and no paid final summary", async () => {
  const llm = script([{ toolCalls: [call(1), call(2), call(3)] }]);
  let executed = 0;
  const result = await runAgentLoop({ system: "s", user: "u", deps: {
    transport: llm.transport, tools, budget: { ...DEFAULT_BUDGET, toolCalls: 1 },
    executeTool: async () => { executed++; return '{"ok":true}'; },
  } });
  assert.equal(executed, 1);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.stopReason, "budget");
  assert.equal(llm.requests(), 1);
});

test("model response exhausts token budget: none of its tool calls may execute", async () => {
  const llm = script([{ toolCalls: [call(1)], usage: { input: 1, output: 1 } }]);
  let executed = 0;
  const result = await runAgentLoop({ system: "s", user: "u", deps: {
    transport: llm.transport, tools, budget: { ...DEFAULT_BUDGET, tokens: 2 },
    executeTool: async () => { executed++; return '{}'; },
  } });
  assert.equal(executed, 0);
  assert.equal(result.stopReason, "budget");
  assert.equal(llm.requests(), 1);
});

test("cancel during first tool: second distinct tool and next LLM request never run", async () => {
  const store = new InMemoryStore();
  const task = await store.createTask({ userId: "u", title: "cancel" });
  const llm = script([{ toolCalls: [call(1), call(2)] }]);
  let executed = 0;
  await new Worker({ store, transport: llm.transport, tools, buildSystem: () => "s", heartbeatMs: 1e9,
    executeTool: async () => { executed++; await store.requestCancel(task.id, "u"); return '{"ok":true}'; },
  }).tick();
  const done = await store.getTask(task.id);
  assert.equal(executed, 1);
  assert.equal(done?.status, "cancelled");
  assert.equal(done?.usage.toolCalls, 1);
  assert.equal(llm.requests(), 1);
});

for (const output of ['{"error":"disk full"}', '{"ok":false}', '{"success":false}']) {
  test(`tool failure ${output} followed by model "done" never certifies success`, async () => {
    const store = new InMemoryStore();
    const task = await store.createTask({ userId: "u", title: "write" });
    const llm = script([{ toolCalls: [call(1)] }, { content: "全部成功，已完成。" }]);
    await new Worker({ store, transport: llm.transport, tools, buildSystem: () => "s", heartbeatMs: 1e9,
      executeTool: async () => output,
      // Even a mistakenly permissive custom evaluator may not bypass runtime gates.
      evaluator: async t => ({ taskId: t.id, evaluatedBy: "evaluator", passed: true, criteria: [], evaluatedAt: 0 }),
    }).tick();
    const done = await store.getTask(task.id);
    assert.equal(done?.status, "failed");
    assert.equal(done?.result?.certificate?.passed, false);
    assert.match(done?.result?.summary ?? "", /任务未通过验收/);
  });
}

test("non-transport tool exception is not mistaken for successful real model execution", async () => {
  const store = new InMemoryStore();
  const task = await store.createTask({ userId: "u", title: "write" });
  const llm = script([{ toolCalls: [call(1)] }, { content: "完成。" }]);
  await new Worker({ store, transport: llm.transport, tools, buildSystem: () => "s", heartbeatMs: 1e9,
    executeTool: async () => { throw new Error("write failed"); },
  }).tick();
  assert.equal((await store.getTask(task.id))?.status, "failed");
  assert.equal(llm.requests(), 2);
});

test("explicit required business criteria without evaluator storage fail closed", async () => {
  const store = new InMemoryStore();
  const task = await store.createTask({ userId: "u", title: "write" });
  const llm = script([{ content: "done" }]);
  await new Worker({ store, transport: llm.transport, tools, buildSystem: () => "s", heartbeatMs: 1e9,
    acceptance: () => [{ id: "artifact", kind: "artifact_exists", params: {}, required: true }],
    executeTool: async () => '{}',
  }).tick();
  assert.equal((await store.getTask(task.id))?.status, "failed");
});

test("checkpoint and Task counters are retained on resume; no tool budget reset", async () => {
  const store = new InMemoryStore();
  const task = await store.createTask({ userId: "u", title: "resume", budget: { ...DEFAULT_BUDGET, toolCalls: 1 } });
  await store.writeCheckpoint({ taskId: task.id, userId: "u", eventSeq: 0, state: {
    messages: [{ role: "user", content: "resume" }], repeat: {}, stepProgress: {}, pendingApprovals: [],
    usage: { ...EMPTY_USAGE, tokens: 20, toolCalls: 1, costUsd: 0.01, wallMs: 300 },
  } });
  const llm = script([{ content: "must not run" }]);
  await new Worker({ store, transport: llm.transport, tools, buildSystem: () => "s", heartbeatMs: 1e9, executeTool: async () => '{}' }).tick();
  const done = await store.getTask(task.id);
  assert.equal(llm.requests(), 0);
  assert.equal(done?.status, "failed");
  assert.equal(done?.usage.toolCalls, 1);
  assert.equal(done?.usage.tokens, 20);
  assert.equal(done?.usage.costUsd, 0.01);
  assert.ok(done!.usage.wallMs >= 300);
});

test("checkpoint rejection prevents the next model call and success certificate", async () => {
  const store = new InMemoryStore();
  const task = await store.createTask({ userId: "u", title: "write" });
  store.writeCheckpoint = async () => { throw new Error("checkpoint disk error"); };
  const llm = script([{ toolCalls: [call(1)] }, { content: "must not run" }]);
  await new Worker({ store, transport: llm.transport, tools, buildSystem: () => "s", heartbeatMs: 1e9,
    executeTool: async () => '{"ok":true}',
  }).tick();
  const done = await store.getTask(task.id);
  assert.equal(llm.requests(), 1);
  assert.equal(done?.status, "failed");
  assert.match(done?.error ?? "", /checkpoint disk error/);
});

test("async checkpoint is awaited, not fire-and-forget", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const llm = script([{ toolCalls: [call(1)] }, { content: "ok" }]);
  const running = runAgentLoop({ system: "s", user: "u", deps: {
    transport: llm.transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => '{"ok":true}',
    hooks: { onCheckpoint: () => wait },
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(llm.requests(), 1);
  release();
  assert.equal((await running).stopReason, "completed");
  assert.equal(llm.requests(), 2);
});

test("unknown tools or invalid native JSON arguments do not reach executor", async () => {
  const invalid = [
    { ...call(1), function: { name: "delete_everything", arguments: '{}' } },
    { ...call(2), function: { name: "save_to_inbox", arguments: '[]' } },
    { ...call(3), function: { name: "save_to_inbox", arguments: '{' } },
  ];
  const llm = script([{ toolCalls: invalid }, { content: "done" }]);
  let executed = 0;
  const result = await runAgentLoop({ system: "s", user: "u", deps: {
    transport: llm.transport, tools, budget: DEFAULT_BUDGET,
    executeTool: async () => { executed++; return '{}'; },
  } });
  assert.equal(executed, 0);
  assert.equal(result.toolErrors, 3);
});

test("cancel while awaiting model response discards tool calls without executing them", async () => {
  let cancelled = false;
  let executed = 0;
  const result = await runAgentLoop({ system: "s", user: "u", deps: {
    tools, budget: DEFAULT_BUDGET, isCancelled: () => cancelled,
    transport: { async chat() { cancelled = true; return { content: "", toolCalls: [call(1)], usage: { input: 2, output: 3 }, model: "fixture" }; } },
    executeTool: async () => { executed++; return '{}'; },
  } });
  assert.equal(executed, 0);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(result.usage.tokens, 5);
});

test("resumed cost and wall usage accumulate instead of being recomputed from zero", async () => {
  const llm = script([{ content: "ok", usage: { input: 2, output: 3 } }]);
  const result = await runAgentLoop({ system: "s", user: "u", resumeUsage: { ...EMPTY_USAGE, tokens: 10, costUsd: 0.1, wallMs: 500 }, deps: {
    tools, budget: DEFAULT_BUDGET, transport: llm.transport, executeTool: async () => '{}',
    hooks: { now: () => 100, pricePerToken: 0.01 },
  } });
  assert.equal(result.usage.tokens, 15);
  assert.ok(Math.abs(result.usage.costUsd - 0.15) < 1e-10);
  assert.equal(result.usage.wallMs, 500);
});

test("round limit and fabricated tool_result cannot be marked successful", async () => {
  const limit = await runAgentLoop({ system: "s", user: "u", deps: {
    tools, maxRounds: 1, budget: DEFAULT_BUDGET, transport: script([{ toolCalls: [call(1)] }]).transport,
    executeTool: async () => '{"ok":true}',
  } });
  assert.equal(limit.stopReason, "round_limit");
  const fabricated = await runAgentLoop({ system: "s", user: "u", deps: {
    tools, budget: DEFAULT_BUDGET, transport: script([{ content: '<tool_result>成功</tool_result>' }]).transport,
    executeTool: async () => { throw new Error("must not execute"); },
  } });
  assert.equal(fabricated.stopReason, "invalid_output");
});
