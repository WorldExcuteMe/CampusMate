import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import { LlmTransportError } from "./errors.ts";
import type { ChatOptions, LlmTransport } from "./llm.ts";
import type { ChatResult } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";
import { recommendedBudget } from "./budget.ts";

const tool = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: {} } });

function fixture(script: Array<Record<string, unknown> | Error>, result = JSON.stringify({ ok: true })) {
  const requests: ChatOptions[] = [];
  const transport: LlmTransport = {
    async chat(opts) {
      requests.push(structuredClone({ ...opts, signal: undefined, onDelta: undefined }));
      const item = script[Math.min(requests.length - 1, script.length - 1)];
      if (item instanceof Error) throw item;
      return { model: "contract", content: "", toolCalls: [], usage: { input: 1, output: 1 }, ...item } as ChatResult;
    },
  };
  return {
    requests,
    deps: {
      transport,
      tools: [tool("workspace_read"), tool("workspace_write"), tool("workspace_run")],
      budget: DEFAULT_BUDGET,
      executeTool: async () => result,
    },
  };
}

const readRound = (i: number) => ({ content: "", toolCalls: [{ id: `r${i}`, type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: `file${i}.txt` }) } }] });
const runRound = (i: number) => ({ content: "", toolCalls: [{ id: `x${i}`, type: "function", function: { name: "workspace_run", arguments: JSON.stringify({ program: "python3", argv: [`-c`, `print(${i})`] }) } }] });

test("连续 8 次只读操作后提醒开始执行（写入意图）", async () => {
  const script = [...Array.from({ length: 8 }, (_, i) => readRound(i)), { content: "已整理并写入报告。" }];
  const f = fixture(script);
  const r = await runAgentLoop({ system: "s", user: "整理这些文件并写入汇总报告", deps: f.deps });
  assert.equal(f.requests.length, 9);
  assert.ok(f.requests[8].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【执行阶段提醒】")));
  assert.match(r.reply, /已整理/);
});

test("连续运行脚本多次后提醒核对目标产物", async () => {
  const script = [...Array.from({ length: 8 }, (_, i) => runRound(i)), { content: "任务完成。" }];
  const f = fixture(script);
  const r = await runAgentLoop({ system: "s", user: "生成报告并保存为文件", deps: f.deps });
  assert.equal(f.requests.length, 9);
  assert.ok(f.requests[8].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【产物核对】")));
  assert.match(r.reply, /任务完成/);
});

test("重复相同工具观测在模型上下文中压缩为引用，transcript 保留原文", async () => {
  const same = JSON.stringify({ entries: [{ name: "a" }, { name: "b" }] });
  const round = { content: "", toolCalls: [{ id: "dup", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: "data.json" }) } }] };
  const f = fixture([round, round, { content: "已读取。" }], same);
  const r = await runAgentLoop({ system: "s", user: "读取 data.json 并说明内容", deps: f.deps });
  assert.equal(f.requests.length, 3);
  const secondRequest = f.requests[2].messages.map((m) => String(m.content)).join("\n");
  assert.match(secondRequest, /duplicateObservation/);
  const toolMessages = r.transcript.filter((m) => m.role === "tool").map((m) => String(m.content));
  assert.equal(toolMessages.filter((content) => content === same).length, 2);
});

test("recommendedBudget 按任务类型分档", () => {
  const heavy = recommendedBudget("请写一个 Python 脚本并运行测试，导出报告文档");
  assert.equal(heavy.tokens, 1_000_000);
  assert.equal(heavy.toolCalls, 120);
  assert.equal(heavy.wallMs, 1_800_000);
  const light = recommendedBudget("你好");
  assert.equal(light.tokens, 120_000);
  assert.equal(light.toolCalls, 20);
  const normal = recommendedBudget("帮我看下这个通知");
  assert.equal(normal.tokens, DEFAULT_BUDGET.tokens);
  assert.equal(recommendedBudget(undefined).tokens, DEFAULT_BUDGET.tokens);
});
test("网络中断后做一次有界重发，并保留续跑提示", async () => {
  const err = new LlmTransportError("fetch failed", { reason: "network" });
  const f = fixture([err, { content: "继续完成后的答复" }]);
  const r = await runAgentLoop({ system: "s", user: "完成任务", deps: f.deps });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【网络中断续跑】")));
  assert.match(r.reply, /继续完成/);
});
test("todo 工具存在时注入计划指导", async () => {
  const f = fixture([{ content: "好的。" }]);
  const deps = { ...f.deps, tools: [...f.deps.tools, tool("todo_write")] };
  await runAgentLoop({ system: "s", user: "整理数据并写入报告", deps });
  assert.ok(f.requests[0].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【任务计划】")));
});

test("多步任务 4 轮仍无计划时提醒一次建立计划", async () => {
  const script = [
    readRound(0), readRound(1), readRound(2), readRound(3),
    { content: "已完成。" },
  ];
  const f = fixture(script);
  const deps = { ...f.deps, tools: [...f.deps.tools, tool("todo_write")] };
  await runAgentLoop({ system: "s", user: "整理这些文件并写入汇总报告", deps });
  assert.ok(f.requests.length >= 6);
  assert.ok(f.requests[5].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【计划提醒】")));
});
test("parallelReads 开启时同一轮多个只读并发执行，观测顺序保持调用顺序", async () => {
  const calls = [0, 1, 2].map((i) => ({ id: `p${i}`, type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: `p${i}.txt` }) } }));
  const f = fixture([{ content: "", toolCalls: calls }, { content: "读取完成" }]);
  let active = 0, maxActive = 0;
  const deps = {
    ...f.deps,
    parallelReads: true,
    executeTool: async (_name: string, args: Record<string, unknown>) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return JSON.stringify({ ok: true, path: args.path });
    },
  };
  const r = await runAgentLoop({ system: "s", user: "读取这三个文件", deps });
  assert.ok(maxActive >= 2, `expect parallel reads, maxActive=${maxActive}`);
  const paths = r.transcript.filter((m) => m.role === "tool").map((m) => { try { return JSON.parse(String(m.content)).path; } catch { return null; } });
  assert.deepEqual(paths, ["p0.txt", "p1.txt", "p2.txt"]);
  assert.match(r.reply, /读取完成/);
});

test("parallelReads 关闭时保持串行", async () => {
  const calls = [0, 1, 2].map((i) => ({ id: `s${i}`, type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: `s${i}.txt` }) } }));
  const f = fixture([{ content: "", toolCalls: calls }, { content: "读取完成" }]);
  let active = 0, maxActive = 0;
  const deps = {
    ...f.deps,
    executeTool: async (_name: string, args: Record<string, unknown>) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return JSON.stringify({ ok: true, path: args.path });
    },
  };
  await runAgentLoop({ system: "s", user: "读取这三个文件", deps });
  assert.equal(maxActive, 1);
});
test("会话事件日志双写：turn/user/assistant/tool/turn-end 可重放", async () => {
  const { InMemorySessionLog, replay } = await import("./event-log.ts");
  const log = new InMemorySessionLog();
  const f = fixture([
    { content: "", toolCalls: [{ id: "r1", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: "a.txt" }) } }] },
    { content: "文件内容已读取。" },
  ]);
  const deps = { ...f.deps, sessionLog: log };
  const r = await runAgentLoop({ system: "s", user: "读取 a.txt 并总结", deps });
  const types = log.events().map((event) => event.type);
  assert.equal(types[0], "turn/start");
  assert.equal(types[1], "user/message");
  assert.ok(types.includes("assistant/message"));
  assert.ok(types.includes("tool/call"));
  assert.ok(types.includes("tool/result"));
  assert.ok(types.includes("checkpoint"));
  assert.equal(types.at(-1), "turn/end");
  const state = replay(log.events());
  assert.equal(state.openTurn, false);
  assert.equal(state.messages.length, 4);
  assert.equal(state.messages[2].tool_call_id, "r1");
  assert.match(r.reply, /文件内容已读取/);
});
test("todo 计划持久化进 checkpoint，并在 resume 时回注【当前计划】", async () => {
  const checkpoints: Array<{ plan?: Array<{ content: string; status: string }> }> = [];
  const todoCall = { id: "p1", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "读取输入", status: "completed" }, { content: "生成 report.docx", status: "in_progress" }] }) } };
  const f = fixture([
    { content: "", toolCalls: [todoCall] },
    { content: "计划已更新，继续执行。" },
  ]);
  const deps = {
    ...f.deps,
    tools: [...f.deps.tools, tool("todo_write")],
    hooks: { onCheckpoint: (state: { plan?: Array<{ content: string; status: string }> }) => { checkpoints.push(structuredClone(state)); } },
  };
  await runAgentLoop({ system: "s", user: "整理数据并写入 report.docx", deps });
  const withPlan = checkpoints.find((state) => state.plan?.length === 2);
  assert.ok(withPlan, "checkpoint must contain the todo plan");
  assert.equal(withPlan!.plan![1].content, "生成 report.docx");
  assert.equal(withPlan!.plan![1].status, "in_progress");

  const resumed = fixture([{ content: "继续完成。" }]);
  const resumedDeps = { ...resumed.deps, tools: [...resumed.deps.tools, tool("todo_write")] };
  await runAgentLoop({ system: "s", user: "继续", deps: resumedDeps, resumePlan: withPlan!.plan as Array<{ content: string; status: "pending" | "in_progress" | "completed" }> });
  assert.ok(resumed.requests[0].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【当前计划】")));
  assert.match(String(resumed.requests[0].messages.find((m) => typeof m.content === "string" && m.content.startsWith("【当前计划】"))?.content), /生成 report\.docx/);
});

