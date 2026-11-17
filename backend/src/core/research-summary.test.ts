import { test } from "node:test";
import assert from "node:assert/strict";
import { researchTarget, renderResearchSummary } from "./research-summary.ts";
import { runAgentLoop } from "./agent-loop.ts";
import type { ToolDef } from "./types.ts";
const sources = [{ url: "https://contest.example/rules", text: "蓝桥杯全国软件和信息技术专业人才大赛。个人赛报名费为每人300元。Python组接受在校本科生报名。报名截止时间按各赛区通知执行。" }, { url: "https://school.example.edu/notice", text: "校园数据创新赛由本校信息学院主办。参赛报名不收取任何费用。2026年11月25日前提交作品。" }];
test("recommendation target preserves scope and does not force web reads for offline directions", () => {
  assert.equal(researchTarget("按刚才身份找两个真实赛事的官方信息，说明是否适合我"), 2);
  assert.equal(researchTarget("不要联网，推荐两类项目方向"), 0);
  assert.equal(researchTarget("收集全国大学生物联网设计竞赛的信息"), 0);
});
test("only actual quotes become facts and zero-budget conflicts are explicit", () => {
  const result = renderResearchSummary(JSON.stringify({ items: [{ name: "蓝桥杯全国软件和信息技术专业人才大赛", source: 0, fee: { source: 0, quote: "个人赛报名费为每人300元。" }, eligibility: { source: 0, quote: "Python组接受在校本科生报名。" }, suggestion: "每周6小时可先练习Python基础。", inventedConclusion: "2027年尚未发布报名通知" }, { name: "校园数据创新赛", source: 1, fee: { source: 1, quote: "参赛报名不收取任何费用。" } }] }), sources, ["我是大二，Python入门，无硬件，每周6小时，预算0元"], 2);
  assert(result?.complete); assert.match(result.reply, /300元/); assert.match(result.reply, /高于.*0元/); assert.match(result.reply, /报名.*未核实/);
  assert(!result.reply.includes("2027")); assert(result.reply.includes(sources[0].url));
});
test("invented quotes and mismatched names are never promoted to verified facts", () => {
  const result = renderResearchSummary(JSON.stringify({ items: [{ name: "蓝桥杯全国软件和信息技术专业人才大赛", source: 0, fee: { source: 0, quote: "本大赛所有组别均为免费报名。" } }, { name: "Kaggle", source: 0, suggestion: "提供免费GPU，随时报名" }] }), sources, ["预算0元"], 2);
  assert(result); assert.equal(result.complete, false); assert(!result.reply.includes("均为免费")); assert(!result.reply.includes("免费GPU")); assert.match(result.reply, /未核实/);
  assert.equal(renderResearchSummary("not JSON", sources, [], 2), undefined);
});

const tools: ToolDef[] = [{ type: "function", function: { name: "web_fetch", description: "read", parameters: { type: "object" } } }];
const tc = (index: number) => ({ id: `read-${index}`, type: "function" as const, function: { name: "web_fetch", arguments: JSON.stringify({ url: sources[index].url }) } });
const summary = JSON.stringify({ items: [{ name: "蓝桥杯全国软件和信息技术专业人才大赛", source: 0, fee: { source: 0, quote: "个人赛报名费为每人300元。" } }, { name: "校园数据创新赛", source: 1, fee: { source: 1, quote: "参赛报名不收取任何费用。" } }], inventedConclusion: "2027尚未发布" });
test("real tool observations feed an isolated quoted summary instead of another free-form conclusion", async () => {
  let calls = 0;
  const result = await runAgentLoop({ system: "s", user: "按刚才身份找两个真实赛事的官方信息，说明是否适合我", history: [{ role: "user", content: "预算0元，Python入门，每周6小时" }, { role: "assistant", content: "2027尚未发布" }], deps: { tools, reasoning: "high", budget: { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 },
    transport: { chat: async opts => { calls++; if (calls === 1) { assert(!opts.messages.some(m => m.role === "assistant")); assert.equal(opts.messages.filter(m => m.role === "user").length, 1); assert(JSON.stringify(opts.messages).includes("预算0元")); } if (calls === 2) { assert.equal(opts.stage, "summary"); assert.deepEqual(opts.tools, []); assert(!JSON.stringify(opts.messages).includes("2027尚未发布")); } return { content: calls === 1 ? "" : summary, toolCalls: calls === 1 ? [tc(0), tc(1)] : [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async (_name, args) => JSON.stringify({ status: 200, ...sources.find(s => s.url === args.url) }),
  } });
  assert.equal(calls, 2); assert.equal(result.stopReason, "completed"); assert(!result.reply.includes("2027")); assert.match(result.reply, /高于.*0元/);
});

test("insufficient recommendation sources trigger one bounded research repair", async () => {
  let calls = 0;
  const result = await runAgentLoop({ system: "s", user: "按我的身份找两个真实赛事的官方信息，说明是否适合我", deps: { tools, budget: { tokens: 20000, toolCalls: 5, wallMs: 60000, costUsd: 1 },
    transport: { chat: async opts => { calls++; if (calls === 3) assert(JSON.stringify(opts.messages).includes("补充推荐来源")); return { content: calls === 2 ? "已经足够了，第二个暂且猜测免费。" : calls === 4 ? summary : "", toolCalls: calls === 1 ? [tc(0)] : calls === 3 ? [tc(1)] : [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async (_name, args) => JSON.stringify({ status: 200, ...sources.find(s => s.url === args.url) }),
  } });
  assert.equal(calls, 4); assert.equal(result.stopReason, "completed"); assert(!result.reply.includes("猜测免费"));
});
