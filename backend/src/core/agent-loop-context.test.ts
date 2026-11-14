import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import { validatePairing } from "./context.ts";
import type { LlmTransport } from "./llm.ts";
import type { ChatResult, ToolDef, ChatMessage } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";

const tools: ToolDef[] = [{ type: "function", function: { name: "big_tool", description: "x", parameters: { type: "object", properties: {} } } }];

// 模型连续多轮调用 big_tool（返回大结果），最后收尾。触发循环内压缩。
class ManyToolTransport implements LlmTransport {
  rounds: number;
  constructor(rounds: number) { this.rounds = rounds; }
  async chat(opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const toolResults = opts.messages.filter((m) => m.role === "tool").length;
    if (toolResults >= this.rounds) return { content: "完成", toolCalls: [], usage: { input: 1, output: 1 }, model: "deepseek-chat" };
    return { content: "", toolCalls: [{ id: `c${toolResults}`, type: "function", function: { name: "big_tool", arguments: "{}" } }], usage: { input: 1, output: 1 }, model: "deepseek-chat" };
  }
}

test("多轮工具超窗压缩后配对完整（无孤儿 tool），任务正常收尾", async () => {
  const transport = new ManyToolTransport(15);
  const r = await runAgentLoop({
    system: "s", user: "x", model: "deepseek-chat",
    deps: { transport, tools, budget: { ...DEFAULT_BUDGET, tokens: 8000 }, executeTool: async () => JSON.stringify({ data: "y".repeat(3000) }) },
  });
  assert.equal(r.reply, "完成");
  assert.equal(r.mock, false);
  assert.equal(validatePairing(r.messages).ok, true); // 关键：压缩后无孤儿
});

test("压缩不丢任务状态：resumeMessages 配对完整保留", async () => {
  const resume: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "x" },
    { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "big_tool", arguments: "{}" } }] },
    { role: "tool", content: "result", tool_call_id: "a" },
  ];
  const transport: LlmTransport = { async chat() { return { content: "收尾", toolCalls: [], usage: { input: 1, output: 1 }, model: "deepseek-chat" }; } };
  const r = await runAgentLoop({ system: "s", user: "x", resumeMessages: resume, deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => "{}" } });
  assert.equal(r.reply, "收尾");
  assert.equal(validatePairing(r.messages).ok, true);
});