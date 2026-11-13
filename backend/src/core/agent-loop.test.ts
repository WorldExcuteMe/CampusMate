import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import type { LlmTransport } from "./llm.ts";
import type { ChatResult, ToolDef } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";
import { LlmTransportError } from "./errors.ts";

const tools: ToolDef[] = [{ type: "function", function: { name: "save_to_inbox", description: "x", parameters: { type: "object", properties: {} } } }];
const tc = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

class FakeTransport implements LlmTransport {
  i = 0;
  script: Partial<ChatResult>[];
  constructor(script: Partial<ChatResult>[]) { this.script = script; }
  async chat(): Promise<ChatResult> {
    const m = this.script[Math.min(this.i, this.script.length - 1)]; this.i++;
    return { content: m.content ?? "", toolCalls: m.toolCalls ?? [], usage: m.usage ?? { input: 1, output: 1 }, model: m.model ?? "fake" };
  }
}

test("工具调用→落库→最终答复（mock=false，usage 累计）", async () => {
  const transport = new FakeTransport([
    { toolCalls: [tc("save_to_inbox", { title: "竞赛" })] },
    { content: "已写入。" },
  ]);
  const r = await runAgentLoop({
    system: "s", user: "写inbox",
    deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ ok: true, title: "竞赛" }) },
  });
  assert.equal(r.reply, "已写入。");
  assert.equal(r.mock, false);
  assert.ok(r.actions.includes("save_to_inbox"));
  assert.equal(r.usage.toolCalls, 1);
  assert.ok(r.usage.tokens > 0);
});

test("工具失败 error 观测回传，循环不中断（mock=false）", async () => {
  const transport = new FakeTransport([
    { toolCalls: [tc("save_to_inbox", { title: "x" })] },
    { content: "写入失败，已知悉。" },
  ]);
  const r = await runAgentLoop({
    system: "s", user: "写inbox",
    deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ error: "工具 save_to_inbox 执行失败：duplicate key | code: 23505" }) },
  });
  assert.equal(r.mock, false);
  assert.match(r.reply, /写入失败/);
  assert.ok(!r.reply.includes("[object Object]"));
});

test("预算硬停：toolCalls=1 → 强制总结，budgetExceeded=true", async () => {
  const transport = new FakeTransport([
    { toolCalls: [tc("save_to_inbox", { title: "a" })] },
    { content: "最终总结。" },
  ]);
  const r = await runAgentLoop({
    system: "s", user: "x",
    deps: { transport, tools, budget: { ...DEFAULT_BUDGET, toolCalls: 1 }, executeTool: async () => JSON.stringify({ ok: true }) },
  });
  assert.equal(r.budgetExceeded, true);
  assert.equal(r.usage.toolCalls, 1);
  assert.equal(r.reply, "最终总结。");
});

test("真实传输失败 → mock=true，可读，无 [object Object]", async () => {
  const transport: LlmTransport = { async chat() { throw new LlmTransportError("上游模型错误 HTTP 401: invalid api key"); } };
  const r = await runAgentLoop({ system: "s", user: "x", deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => "{}" } });
  assert.equal(r.mock, true);
  assert.equal(r.model, "unreachable");
  assert.match(r.reply, /invalid api key/);
  assert.ok(!r.reply.includes("[object Object]"));
});

test("JSON 工具回退（无原生 tool_calls 的模型）", async () => {
  const transport = new FakeTransport([
    { content: '{"tool":"save_to_inbox","args":{"title":"x"}}' },
    { content: "完成。" },
  ]);
  const r = await runAgentLoop({ system: "s", user: "x", deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ ok: true }) } });
  assert.equal(r.reply, "完成。");
  assert.equal(r.usage.toolCalls, 1);
});

test("事件与检查点钩子被调用", async () => {
  const events: string[] = [];
  let checkpoints = 0;
  const transport = new FakeTransport([{ toolCalls: [tc("save_to_inbox", {})] }, { content: "ok" }]);
  await runAgentLoop({
    system: "s", user: "x",
    deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ ok: true }), hooks: { onEvent: (t) => events.push(t), onCheckpoint: () => { checkpoints++; } } },
  });
  assert.ok(events.includes("tool.called"));
  assert.ok(events.includes("checkpoint.written"));
  assert.ok(checkpoints >= 1);
});