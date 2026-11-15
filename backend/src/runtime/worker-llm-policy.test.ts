import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../app-context.ts";
import { Worker } from "./worker.ts";
import type { ChatMessage } from "../core/types.ts";

test("Worker固定system前缀不因task变化，并分离实际请求量及输出截断", async () => {
  const ctx = buildContext({}); const requests: ChatMessage[][] = [];
  for (const title of ["提取A", "提取B"]) await ctx.store.createTask({ userId: "student", title });
  await new Worker({ ...ctx, concurrency: 2, tools: [], buildSystem: () => "稳定规则", transport: { async chat(opts) { requests.push(structuredClone(opts.messages)); return { content: "部分草稿", toolCalls: [], usage: { input: 10, output: 2 }, model: "fixture", truncated: true }; } }, executeTool: async () => "{}" }).tick();
  assert.equal(requests[0][0].content, requests[1][0].content);
  for (const task of await ctx.store.listTasksByUser("student")) {
    assert.equal(task.status, "paused", "截断不能被模型可达验收当成成功");
    assert.equal(task.result?.partial, true);
    assert.match(task.result?.summary ?? "", /草稿/);
  }
});
test("模型不能越过本轮工具allowlist或用无效参数执行副作用", async () => {
  const ctx = buildContext({}); await ctx.store.createTask({ userId: "student", title: "范围" });
  let executed = 0, round = 0; const outputs: unknown[] = [];
  await new Worker({ ...ctx, concurrency: 1, tools: [{ type: "function", function: { name: "web_search", description: "检索", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }], buildSystem: () => "规则", executeTool: async () => { executed++; return "{}"; }, transport: { async chat(opts) {
    if (round++ === 0) return { content: "", toolCalls: [{ id: "unknown", type: "function", function: { name: "unlisted_write", arguments: "{}" } }, { id: "bad-args", type: "function", function: { name: "web_search", arguments: '{"query":7}' } }], usage: { input: 1, output: 1 }, model: "fixture" };
    outputs.push(...opts.messages.filter((m) => m.role === "tool").map((m) => m.content));
    return { content: "已报告工具限制", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
  } } }).tick();
  assert.equal(executed, 0);
  assert.match(JSON.stringify(outputs), /error/);
});

test("大工具输出首次进模型前保存artifact和稳定摘要，原始transcript不被裁剪", async () => {
  const ctx = buildContext({});
  const session = await ctx.sessionStore.create({ userId: "student" });
  const task = (await ctx.store.createSessionTask!({ userId: "student", sessionId: session.id, turnId: crypto.randomUUID(), title: "查材料" }, ctx.sessionStore)).task;
  const full = JSON.stringify({ content: "原始材料".repeat(6000) }); let round = 0, observed = "";
  await new Worker({ ...ctx, concurrency: 1, tools: [{ type: "function", function: { name: "web_search", description: "搜索", parameters: { type: "object", properties: {} } } }], buildSystem: () => "稳定规则", transport: { async chat(opts) {
    if (round++ === 0) return { content: "", toolCalls: [{ id: "big", type: "function", function: { name: "web_search", arguments: "{}" } }], usage: { input: 1, output: 1 }, model: "fixture" };
    observed = String(opts.messages.find((m) => m.role === "tool")?.content);
    return { content: "结论", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
  } }, executeTool: async () => full }).tick();
  assert.ok(observed.length < 8000, "首次调用不能将整个大结果送入模型");
  assert.match(observed, /artifactId/);
  const artifacts = await ctx.artifactStore.listByTask("student", task.id);
  assert.equal(artifacts.length, 1);
  assert.equal((await ctx.sessionStore.listMessages("student", session.id)).find((m) => m.role === "tool")?.content, full);
  assert.equal(await ctx.artifactStore.get("other", artifacts[0].id), null);
});
test("不可重复操作的异常结果不被模型盲重试或标为成功", async () => {
  const ctx = buildContext({}); const task = await ctx.store.createTask({ userId: "student", title: "保存" });
  let calls = 0, round = 0;
  await new Worker({ ...ctx, tools: [{ type: "function", function: { name: "save_opportunity", description: "保存", parameters: { type: "object", properties: {} } } }], buildSystem: () => "规则", executeTool: async () => { calls++; throw new Error("fixture result unknown"); }, transport: { async chat() {
    return round++ < 2 ? { content: "", toolCalls: [{ id: "c" + round, type: "function", function: { name: "save_opportunity", arguments: "{}" } }], usage: { input: 1, output: 1 }, model: "fixture" } : { content: "已完成", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
  } } }).tick();
  assert.equal(calls, 1);
  assert.equal((await ctx.store.getTask(task.id))?.status, "failed");
  assert.match((await ctx.store.getTask(task.id))?.result?.summary ?? "", /未确认/);
});
