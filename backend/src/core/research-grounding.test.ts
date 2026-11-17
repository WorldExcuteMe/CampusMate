import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import type { ToolDef, ChatMessage } from "./types.ts";
import { researchTarget } from "./research-summary.ts";
test("a request for three contest sites enters multi-source research without requiring personalization", () => {
  assert.equal(researchTarget("搜索 2026 年大学生计算机竞赛，给出 3 个带官网链接的，并标明来源；不要编造。"), 3);
  assert.equal(researchTarget("不要联网，推荐3个竞赛方向"), 0);
});
const tools: ToolDef[] = [{ type: "function", function: { name: "web_fetch", description: "read", parameters: { type: "object" } } }];
const call = { id: "read", type: "function" as const, function: { name: "web_fetch", arguments: '{"url":"https://contest.example/rules"}' } };
const budget = { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 };
test("three available contest sources are read in one bounded batch before synthesis", async () => {
  const names = ["校园算法赛", "校园软件设计大赛", "校园人工智能创新赛"];
  const sources = names.map((name, index) => ({ url: `https://school${index}.example.edu/rules`, title: name, text: `${name}，计算机专业学生可以参赛，具体规则以学校正式通知为准。` }));
  let requests = 0; const fetched: string[] = [];
  const result = await runAgentLoop({ system: "s", user: "搜索大学生计算机竞赛，给出3个带官网链接的，并标明来源", deps: { budget, tools: [...tools, { type: "function", function: { name: "web_search", description: "search", parameters: { type: "object" } } }],
    transport: { chat: async () => { requests++; return { content: requests === 1 ? "" : JSON.stringify({ items: names.map((name, source) => ({ name, source })) }), toolCalls: requests === 1 ? [{ id: "search", type: "function", function: { name: "web_search", arguments: '{"query":"大学生计算机竞赛"}' } }] : [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async (name, args) => { if (name === "web_search") return JSON.stringify({ query: "大学生计算机竞赛", results: sources.map(source => ({ ...source, snippet: source.text })) }); fetched.push(String(args.url)); return JSON.stringify({ status: 200, ...sources.find(source => source.url === args.url) }); },
  } });
  assert.equal(result.stopReason, "completed"); assert.equal(fetched.length, 3); assert.equal(requests, 2); assert.equal(result.usage.toolCalls, 4);
});

test("failed official reads cannot become confident fees/status conclusions, including streamed drafts", async () => {
  let requests = 0; const deltas: string[] = [];
  const result = await runAgentLoop({ system: "s", user: "找两个赛事的官方信息，先搜索再打开来源，说明费用和报名状态", deps: { tools, budget,
    transport: { chat: async opts => { requests++; const content = requests === 1 ? "" : "两个比赛均免费，2026赛程已结束，2027尚未报名。"; if (content) opts.onDelta?.(content); return { content, toolCalls: requests === 1 ? [call] : [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async () => '{"url":"https://contest.example/rules","status":200,"readable":false,"error":"页面只有标题，未取得正文"}', hooks: { onEvent: (name, data) => { if (name === "llm.delta") deltas.push(String(data.text)); } },
  } });
  assert.equal(result.error, "source_unavailable"); assert.match(result.reply, /未取得.*正文/); assert(!result.reply.includes("均免费")); assert(!deltas.join("").includes("均免费"));
});

test("same-session follow-up can rely on an actually read source without searching again", async () => {
  const history: ChatMessage[] = [{ role: "assistant", content: "", tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: '{"url":"https://contest.example/rules","status":200,"text":"报名费100元，每队3名学生和2名指导老师。"}' }];
  const result = await runAgentLoop({ system: "s", user: "只用刚才的官方来源回答人数，不必重新搜索", history, deps: { tools, budget, transport: { chat: async () => ({ content: "3名学生，2名指导老师。https://contest.example/rules", toolCalls: [], model: "contract", usage: { input: 1, output: 1 } }) }, executeTool: async () => { assert.fail("no repeated fetch needed"); } } });
  assert.equal(result.stopReason, "completed"); assert.match(result.reply, /3名学生/);
});
