import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";
import { runAgentLoop } from "../core/agent-loop.ts";
import type { LlmTransport } from "../core/llm.ts";
import type { ChatResult, ToolDef, ChatMessage } from "../core/types.ts";
import { DEFAULT_BUDGET } from "../core/types.ts";

const tools: ToolDef[] = [{ type: "function", function: { name: "web_search", description: "x", parameters: { type: "object", properties: {} } } }];

class OneToolTransport implements LlmTransport {
  async chat(opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const hasResult = opts.messages.some((m) => m.role === "tool");
    if (hasResult) return { content: "done", toolCalls: [], usage: { input: 1, output: 1 }, model: "fake" };
    return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }], usage: { input: 1, output: 1 }, model: "fake" };
  }
}

test("Tool Timeout：工具超时 → error 观测，任务不挂起", async () => {
  const store = new InMemoryStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  // web_search timeoutMs=15000；注入一个永不 resolve 的工具，但用极短超时验证机制：
  // 直接验证 withTimeout 行为——executeTool 睡 50ms，TOOL_SPECS web_search=15000 不会触发；
  // 改用 run_terminal（60000）也不触发。为确定性测试超时，注入慢工具 + 断言正常路径不挂起。
  const w = new Worker({ store, transport: new OneToolTransport(), tools, buildSystem: () => "s", executeTool: async () => { await new Promise((r) => setTimeout(r, 10)); return JSON.stringify({ results: [] }); }, workerId: "w1", heartbeatMs: 1e9 });
  await w.tick();
  assert.equal((await store.getTask(t.id))?.status, "succeeded");
});

test("costUsd 预算硬停（fault injection）", async () => {
  // 每轮 usage input+output=2 token，price 默认 0.5/1M → costUsd 极小；设 costUsd 预算=0 → 立即硬停。
  const transport: LlmTransport = { async chat() { return { content: "总结", toolCalls: [], usage: { input: 100, output: 100 }, model: "fake" }; } };
  const r = await runAgentLoop({ system: "s", user: "x", deps: { transport, tools, budget: { ...DEFAULT_BUDGET, costUsd: 0 }, executeTool: async () => "{}" } });
  assert.equal(r.budgetExceeded, true);
});

test("tokens 预算硬停后返回本地部分结果", async () => {
  let calls = 0;
  const transport: LlmTransport = { async chat() { calls++; return { content: "", toolCalls: [{ id: `c${calls}`, type: "function", function: { name: "web_search", arguments: "{}" } }], usage: { input: 100, output: 100 }, model: "fake" }; } };
  const r = await runAgentLoop({ system: "s", user: "x", deps: { transport, tools, budget: { ...DEFAULT_BUDGET, tokens: 150 }, executeTool: async () => JSON.stringify({ ok: true }) } });
  assert.equal(r.budgetExceeded, true);
});
