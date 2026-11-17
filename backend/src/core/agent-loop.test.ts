import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import type { LlmTransport } from "./llm.ts";
import type { ChatResult, ToolDef } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";
import { LlmTransportError } from "./errors.ts";

test("search-only runtimes report real search leads for both native and JSON protocols", async () => {
  const search: ToolDef[] = [{ type: "function", function: { name: "web_search", description: "search", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }];
  for (const native of [true, false]) {
    let requests = 0, executed = 0;
    const transport = { chat: async (): Promise<ChatResult> => { requests++; return { content: requests === 1 ? native ? "" : '{"tool":"web_search","args":{"query":"竞赛"}}' : "根据真实搜索结果找到候选链接，日期仍需核对。", toolCalls: requests === 1 && native ? [tc("web_search", {query:"竞赛"})] : [], model: "contract", usage: {input:1,output:1} }; } };
    const result = await runAgentLoop({ system: "s", user: "收集竞赛信息", deps: { transport, tools: search, budget: DEFAULT_BUDGET, executeTool: async () => { executed++; return JSON.stringify({results:[{title:"竞赛线索",url:"https://example.org/notice"}]}); } } });
    assert.equal(executed,1); assert.equal(result.stopReason,"completed"); assert.ok(result.actions.includes("web_search")); assert.match(result.reply,/搜索/);
  }
});

const tools: ToolDef[] = [{ type: "function", function: { name: "save_to_inbox", description: "x", parameters: { type: "object", properties: {} } } }];
const tc = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
test("insufficient input budget pauses before any text or vision model request", async () => {
  for (const images of [undefined, ["data:image/png;base64,AAAA"]]) {
    let calls = 0; const events: string[] = [];
    const result = await runAgentLoop({ system: "校园通知助手", user: images ? "核验这张通知图片" : "给一个方案", ...(images ? {images} : {}), deps: { tools, budget: { tokens: 1, toolCalls: 5, wallMs: 60000, costUsd: 1 }, transport: {estimateInputTokens:()=>2300,chat:async()=>{calls++;return {content:"不该花费这些tokens",toolCalls:[],model:"contract",usage:{input:2300,output:1}};}}, executeTool:async()=>"{}", hooks: {onEvent:type=>{events.push(type);}} } });
    assert.equal(calls,0); assert.equal(result.usage.tokens,0); assert.equal(result.budgetExceeded,true); assert.equal(events.filter(type=>type==="llm.request").length,0);
  }
});

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

test("预算硬停：toolCalls=1 → 本地说明，不能追加模型请求", async () => {
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
  assert.match(r.reply, /预算超限停止/);
  assert.equal(transport.i, 1);
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
    deps: { transport, tools, budget: DEFAULT_BUDGET, executeTool: async () => JSON.stringify({ ok: true }), hooks: { onEvent: (t) => { events.push(t); }, onCheckpoint: () => { checkpoints++; } } },
  });
  assert.ok(events.includes("tool.called"));
  assert.ok(events.includes("checkpoint.written"));
  assert.ok(checkpoints >= 1);
});
