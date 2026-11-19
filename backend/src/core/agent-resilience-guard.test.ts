import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop, requestedDeliverable } from "./agent-loop.ts";
import { LlmTransportError } from "./errors.ts";
import type { ChatOptions, LlmTransport } from "./llm.ts";
import type { ChatResult } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";

const tool = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: {} } });

function fixture(script: Array<Record<string, unknown> | Error>) {
  const requests: ChatOptions[] = [];
  const transport: LlmTransport = {
    async chat(opts) {
      requests.push(structuredClone({ ...opts, signal: undefined, onDelta: undefined }));
      const item = script[Math.min(requests.length - 1, script.length - 1)];
      if (item instanceof Error) throw item;
      return { model: "contract", content: "", toolCalls: [], usage: { input: 1, output: 1 }, ...item } as ChatResult;
    },
  };
  return { requests, deps: { transport, tools: [tool("workspace_write"), tool("workspace_run")], budget: DEFAULT_BUDGET, executeTool: async () => "{}" } };
}

test("requestedDeliverable 只识别点名交付文件的写类请求", () => {
  assert.equal(requestedDeliverable("Extract Bill's previous courses and put the course in classes_taken.docx."), "classes_taken.docx");
  assert.equal(requestedDeliverable("生成一份 report.md 报告并保存"), "report.md");
  assert.equal(requestedDeliverable("把 data.xlsx 转成 result.csv"), "data.xlsx、result.csv");
  assert.equal(requestedDeliverable("请比较 score.xlsx 和 reference.xlsx 的差异"), null);
  assert.equal(requestedDeliverable("请读取 data.xlsx 并总结"), null);
  assert.equal(requestedDeliverable("只预览，不要写入 report.md"), null);
});

test("点名交付文件但整轮没有写操作时给一次有界提醒，提醒后不再重复", async () => {
  const f = fixture([{ content: "以下是从表格提取的课程：CS 101、MATH 150……" }, { content: "已创建并回读 classes_taken.docx。" }, { content: "不会再请求" }]);
  const r = await runAgentLoop({ system: "s", user: "Extract Bill's previous courses and put the course in classes_taken.docx.", deps: f.deps });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【交付校验】")));
  assert.match(r.reply, /classes_taken\.docx/);
});

test("写入动作但未在工具观测中确认文件名时，仍给一次有界核验提醒", async () => {
  const f = fixture([
    { content: "", toolCalls: [{ id: "a", type: "function", function: { name: "workspace_write", arguments: '{"path":"report.md","content":"x"}' } }] },
    { content: "已写入 report.md。" },
  ]);
  await runAgentLoop({ system: "s", user: "生成 report.md 报告", deps: f.deps });
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[2].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【交付校验】")));
});

test("只生成了部分点名文件时，提醒缺少的那个文件", async () => {
  const f = fixture([
    { content: "", toolCalls: [{ id: "a", type: "function", function: { name: "workspace_run", arguments: '{"program":"python3","argv":["-c","print(1)"]}' } }] },
    { content: "已完成转换，产物为 data/invoices.xlsx。" },
    { content: "已补充 report.docx。" },
  ]);
  const deps = { ...f.deps, executeTool: async () => "data/invoices.xlsx 已生成" };
  await runAgentLoop({ system: "s", user: "把发票转成 data/invoices.xlsx 并生成 report.docx 报告", deps });
  assert.equal(f.requests.length, 3);
  const marker = f.requests[2].messages.find((m) => typeof m.content === "string" && m.content.startsWith("【交付校验】"));
  assert.ok(marker);
  assert.match(String(marker.content), /report\.docx/);
  assert.doesNotMatch(String(marker.content), /invoices\.xlsx/);
});

test("只跑过只读脚本也算未交付，交付校验要求先核验文件存在", async () => {
  const f = fixture([
    { content: "", toolCalls: [{ id: "a", type: "function", function: { name: "workspace_run", arguments: '{"program":"python3","argv":["-c","print(1)"]}' } }] },
    { content: "数据已经读取完毕。" },
    { content: "已确认并创建 report.docx。" },
  ]);
  const r = await runAgentLoop({ system: "s", user: "生成 report.docx 报告", deps: f.deps });
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[2].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【交付校验】")));
  assert.match(r.reply, /report\.docx/);
});

test("单次模型请求超时且剩余期限充足时做一次有界重发", async () => {
  const timeout = new LlmTransportError("模型响应超时（本次请求限时180秒）", { reason: "timeout" });
  const f = fixture([timeout, { content: "继续完成后的最终答复" }]);
  const r = await runAgentLoop({ system: "s", user: "完成一个需要多步的任务", deps: f.deps });
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【请求超时续跑】")));
  assert.equal(r.reply, "继续完成后的最终答复");
});

test("剩余期限不足时不重发超时请求，如实返回超时", async () => {
  const timeout = new LlmTransportError("模型响应超时（本次请求限时5秒）", { reason: "timeout" });
  const f = fixture([timeout]);
  const r = await runAgentLoop({ system: "s", user: "任务", deps: { ...f.deps, budget: { ...DEFAULT_BUDGET, wallMs: 30_000 } } });
  assert.equal(f.requests.length, 1);
  assert.ok(r.error && String(r.error).includes("timeout"));
});

test("连续 5 次工具失败触发一次诊断提醒，之后继续执行", async () => {
  const failing = (i: number) => ({ content: "", toolCalls: [{ id: `t${i}`, type: "function", function: { name: "workspace_run", arguments: "{}" } }] });
  const f = fixture([failing(1), failing(2), failing(3), failing(4), failing(5), { content: "已读取文档并修正参数。" }]);
  const deps = { ...f.deps, executeTool: async () => JSON.stringify({ error: "bad arguments" }) };
  const r = await runAgentLoop({ system: "s", user: "完成任务", deps });
  assert.equal(f.requests.length, 6);
  assert.ok(f.requests[5].messages.some((m) => typeof m.content === "string" && m.content.startsWith("【工具失败诊断】")));
  assert.match(r.reply, /已读取文档/);
});


