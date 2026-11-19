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

