// L2 golden journeys（骨架）：以"用户旅程"为单位断言 agent 的真实行为，而不仅是机制。
// 这些用例是 CI 回归集的第一批：文档交付、编码获取复杂网页信息、连续失败升级后成功、计划中断恢复。
// 后续扩充到 20–30 条（审批/预算/重启恢复/记忆召回/安全边界等），并接入 CI 闸门。
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import type { ChatOptions, LlmTransport } from "./llm.ts";
import type { ChatResult, ToolDef } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";

const tool = (name: string, properties: Record<string, unknown> = {}): ToolDef => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties } } });
const tc = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

function journey(script: Array<Record<string, unknown> | Error>, executeTool: (name: string, args: Record<string, unknown>) => Promise<string>) {
  const requests: ChatOptions[] = [];
  const transport: LlmTransport = {
    async chat(opts) {
      requests.push(structuredClone({ ...opts, signal: undefined, onDelta: undefined }));
      const item = script[Math.min(requests.length - 1, script.length - 1)];
      if (item instanceof Error) throw item;
      return { model: "golden", content: "", toolCalls: [], usage: { input: 100, output: 50 }, ...item } as ChatResult;
    },
  };
  const deps: { transport: LlmTransport; tools: ToolDef[]; budget: typeof DEFAULT_BUDGET; executeTool: (name: string, args: Record<string, unknown>) => Promise<string> } = { transport, tools: [], budget: DEFAULT_BUDGET, executeTool };
  return { requests, deps };
}

test("golden J1 文档交付：写文件→回读确认→报告完成，不触发多余交付校验", async () => {
  const f = journey(
    [
      { content: "", toolCalls: [tc("c1", "workspace_write", { path: "data/report.docx", content: "周报内容" })] },
      { content: "已生成 data/report.docx 并回读确认内容完整。" },
    ],
    async (name, args) => JSON.stringify({ ok: true, path: args.path, bytes: String(args.content).length, verified: name === "workspace_write" }),
  );
  f.deps.tools = [tool("workspace_write", { path: { type: "string" }, content: { type: "string" } })];
  const r = await runAgentLoop({ system: "s", user: "生成周报并保存为 data/report.docx", deps: f.deps });
  assert.equal(f.requests.length, 2);
  assert.match(r.reply, /report\.docx/);
  assert.ok(!f.requests[1].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【交付校验】")));
  const toolResult = String(r.transcript.find((m) => m.role === "tool")?.content);
  assert.match(toolResult, /report\.docx/);
});

test("golden J2 编码获取复杂网页信息：写脚本→执行→解析结果→交付摘要", async () => {
  const f = journey(
    [
      { content: "", toolCalls: [tc("c1", "workspace_write", { path: "scrape.py", content: "import json,urllib.request\nprint(json.dumps({'items':[{'title':'竞赛报名通知','deadline':'2026-12-01'}]}))" })] },
      { content: "", toolCalls: [tc("c2", "workspace_run", { program: "python3", argv: ["scrape.py"] })] },
      { content: "已解析某高校官网：发现 1 条竞赛通知（报名截止 2026-12-01），来源 page.html。" },
    ],
    async (name, args) => {
      if (name === "workspace_write") return JSON.stringify({ ok: true, path: args.path, bytes: String(args.content).length });
      return JSON.stringify({ exitCode: 0, stdout: '{"items":[{"title":"竞赛报名通知","deadline":"2026-12-01"}]}', stderr: "" });
    },
  );
  f.deps.tools = [tool("workspace_write", { path: { type: "string" }, content: { type: "string" } }), tool("workspace_run", { program: { type: "string" }, argv: { type: "array", items: { type: "string" } } })];
  const r = await runAgentLoop({ system: "s", user: "抓取某高校官网的竞赛通知并整理截止时间", deps: f.deps });
  assert.equal(f.requests.length, 3);
  assert.match(r.reply, /竞赛/);
  assert.match(r.reply, /2026-12-01/);
  const toolResults = r.transcript.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
  assert.match(toolResults, /exitCode/);
  assert.equal(r.actions.filter((name) => name === "workspace_write").length, 1);
});

test("golden J3 连续工具失败升级提醒，换来源后成功", async () => {
  const rounds: Array<Record<string, unknown>> = [0, 1, 2, 3, 4].map((i) => ({ content: "", toolCalls: [tc(`f${i}`, "web_fetch", { url: `https://blocked.example/page${i}` })] }));
  rounds.push({ content: "", toolCalls: [tc("ok", "web_fetch", { url: "https://official.example/notice" })] });
  rounds.push({ content: "已读取官方通知：报名截止 2026-12-01。" });
  let calls = 0;
  const f = journey(rounds, async (_name, args) => {
    calls += 1;
    if (String(args.url).includes("official")) return JSON.stringify({ status: 200, readable: true, text: "报名截止 2026-12-01" });
    return JSON.stringify({ status: 403, readable: false, error: "网页返回HTTP 403，未取得正文" });
  });
  f.deps.tools = [tool("web_fetch", { url: { type: "string" } })];
  const r = await runAgentLoop({ system: "s", user: "查询官方通知的报名截止时间", deps: f.deps });
  assert.equal(calls, 6);
  const nudged = f.requests.some((request) => request.messages.some((m) => typeof m.content === "string" && m.content.startsWith("【工具失败诊断】")));
  assert.ok(nudged, "repeated failures should trigger the bounded escalation");
  assert.match(r.reply, /2026-12-01/);
});

test("golden J4 计划中断恢复：resumePlan 回注后继续完成剩余步骤", async () => {
  const resumed = journey(
    [{ content: "", toolCalls: [tc("w1", "workspace_write", { path: "data/summary.md", content: "汇总" })] }, { content: "已按计划完成并交付 data/summary.md。" }],
    async (name, args) => JSON.stringify({ ok: true, name, path: args.path }),
  );
  resumed.deps.tools = [tool("workspace_write", { path: { type: "string" }, content: { type: "string" } })];
  const r = await runAgentLoop({
    system: "s", user: "继续完成周报汇总",
    deps: resumed.deps,
    resumePlan: [
      { content: "读取本周群通知", status: "completed" },
      { content: "生成汇总并写入 data/summary.md", status: "in_progress" },
    ],
  });
  const resumedMessages = resumed.requests[0].messages.map((m) => String(m.content)).join("\n");
  assert.match(resumedMessages, /【当前计划】/);
  assert.match(resumedMessages, /data\/summary\.md/);
  assert.match(r.reply, /summary\.md/);
});


