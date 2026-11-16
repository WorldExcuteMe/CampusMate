import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../core/agent-loop.ts";
import type { ToolDef } from "../core/types.ts";
const tools: ToolDef[] = ["web_search", "web_fetch"].map(name => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }));
const candidates = ["https://official.example.edu/notice", "https://school.example.edu/notice", "https://third.example.edu/notice"];

async function run(user: string, failAll = false, toolBudget = 10, options: { sourceText?: string; summary?: string; unrelated?: boolean; staticArticle?: boolean } = {}) {
  let requests = 0; const fetched: string[] = []; let summaryStage = false;
  const deltas: string[] = [];
  const result = await runAgentLoop({ system: "fixture", user, deps: { tools, budget: { tokens: 30000, wallMs: 60000, toolCalls: toolBudget, costUsd: 1 },
    hooks: { onEvent: (type, payload) => { if (type === "llm.delta") deltas.push(String(payload.text)); } },
    transport: { async chat(request) {
      requests++;
      if (requests === 1) return { content: "", toolCalls: [{ id: "s1", type: "function", function: { name: "web_search", arguments: '{"query":"竞赛"}' } }], model: "fixture", usage: { input: 1, output: 1 } };
      summaryStage = request.stage === "summary" && request.tools?.length === 0;
      const content = options.summary ?? "实际读取的通知 https://school.example.edu/notice；赛程是否实际举办仍未核实。";
      request.onDelta?.(content);
      return { content, toolCalls: [], model: "fixture", usage: { input: 1, output: 1 } };
    } },
    executeTool: async (name, args) => {
      if (name === "web_search") return JSON.stringify({ results: candidates.map((url, i) => ({ title: options.unrelated ? "大字的字典解释" : "竞赛通知", url: options.staticArticle && i === 1 ? url + ".htm" : url, snippet: options.unrelated ? "大：汉字释义" : "竞赛" })) });
      const url = String(args.url); fetched.push(url);
      return failAll || url === candidates[0] ? '{"error":"fetch failed"}' : JSON.stringify({ status: 200, url, text: options.sourceText ?? "参赛通知正文：计划于八月举办，具体报名信息以通知为准。" });
    },
  } });
  return { result, fetched, requests, summaryStage, deltas };
}
test("brief collection reads bounded real search candidates before another model request", async () => {
  const { result, fetched, requests, summaryStage } = await run("收集竞赛的信息");
  assert.deepEqual(fetched, candidates.slice(0, 2)); assert.equal(requests, 2); assert(summaryStage);
  assert.equal(result.toolErrors, 0); assert.equal(result.recoveredReadErrors, 1); assert.match(result.reply, /读取失败/);
  assert.equal(result.usage.toolCalls, 3);
  assert.equal(result.transcript.filter(m => m.role === "tool").length, 3);
});
test("unreadable search candidates cannot be presented as a completed sourced answer", async () => {
  const { result, fetched } = await run("收集竞赛的信息", true);
  assert.equal(fetched.length, 2); assert(result.error); assert.notEqual(result.stopReason, "completed");
});
test("automatic source reading respects the remaining tool budget", async () => {
  const { result, fetched } = await run("收集竞赛的信息", false, 1);
  assert.equal(fetched.length, 0); assert.equal(result.budgetExceeded, true);
});
test("complex research is left to the existing planner rather than brief-source automation", async () => {
  const { fetched, summaryStage } = await run("收集详细资料并撰写竞赛计划书");
  assert.equal(fetched.length, 0); assert.equal(summaryStage, false);
});
test("an advance notice cannot prove the event actually ended, including streamed text", async () => {
  const { result, deltas } = await run("收集竞赛的信息", false, 10, {
    sourceText: "关于竞赛参赛的通知。在成功举办2014—2025年历届赛事的基础上，现发布本届参赛通知。赛事流程：8月20—31日全国总决赛举行。每队不超过4人。",
    summary: "截至今日，竞赛已结束，全国总决赛于8月20日至31日举行。\n目前暂无2027年赛事官方报名信息。\n* **赛事状态**：赛事已于8月下旬完成全国总决赛，目前处于非报名期。\n\n* 每队不超过4人。\n* 来源：https://school.example.edu/notice",
  });
  assert(!result.reply.includes("竞赛已结束")); assert(!deltas.join("").includes("竞赛已结束"));
  assert(!result.reply.includes("暂无2027"));
  assert(!result.reply.includes("非报名期")); assert(!deltas.join("").includes("已于8月下旬完成"));
  assert.match(result.reply, /实际举办.*未核实/); assert.match(result.reply, /不超过4人/);
  assert(!result.transcript.some(m => m.role === "assistant" && String(m.content).includes("竞赛已结束")));
});
test("a real result report is not treated as an advance notice", async () => {
  const { result } = await run("收集竞赛的信息", false, 10, {
    sourceText: "关于竞赛结果的通知：总决赛已成功举办，现公布获奖名单。",
    summary: "竞赛已结束，来源 https://school.example.edu/notice",
  });
  assert(result.reply.includes("竞赛已结束"));
});
test("search drift cannot turn dictionary results into a completed competition answer", async () => {
  const { result, fetched, deltas } = await run("收集全国大学生物联网设计竞赛的信息", false, 10, { unrelated: true });
  assert.equal(fetched.length, 0); assert.equal(result.error, "source_unavailable");
  assert(!deltas.join("").includes("实际读取的通知"));
});
test("static university articles are preferred over a failure-prone dynamic entry", async () => {
  const { result, fetched } = await run("收集竞赛的信息", false, 10, { staticArticle: true });
  assert.deepEqual(fetched, ["https://school.example.edu/notice.htm"]); assert.equal(result.toolErrors, 0);
});
