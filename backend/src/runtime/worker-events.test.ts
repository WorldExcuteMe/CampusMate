import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../app-context.ts";
import { Worker } from "./worker.ts";

test("真实工具事件有独立ID、结果/耗时及脱敏来源，同名多次可区分", async () => {
  const ctx = buildContext({}); const task = await ctx.store.createTask({ userId: "student", title: "检索" });
  let round = 0;
  await new Worker({ ...ctx, tools: [{ type: "function", function: { name: "web_search", description: "查资料", parameters: { type: "object", properties: {} } } }], buildSystem: () => "规则", transport: { async chat() {
    return round++ < 2 ? { content: "", toolCalls: [{ id: "call" + round, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: round }) } }], usage: { input: 1, output: 1 }, model: "fixture" } : { content: "结果", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
  } }, executeTool: async () => JSON.stringify({ results: [{ url: "https://school.example/a?token=private-value" }] }) }).tick();
  const events = await ctx.store.listEvents(task.id);
  const starts = events.filter((e) => e.type === "tool.called"), ends = events.filter((e) => e.type === "tool.result");
  assert.equal(starts.length, 2); assert.equal(ends.length, 2);
  assert.ok(starts[0].payload.invocationId);
  assert.notEqual(starts[0].payload.callInstanceId, starts[1].payload.callInstanceId);
  for (let i = 0; i < 2; i++) {
    assert.equal(starts[i].payload.callInstanceId, ends[i].payload.callInstanceId);
    assert.ok(Number(ends[i].payload.durationMs) >= 0);
    assert.equal(ends[i].payload.ok, true);
  }
  assert.ok(!JSON.stringify(events).includes("private-value"));
});
test("工具组间取消不执行后续调用，保留记录并释放会话屏障", async () => {
  const ctx = buildContext({}); const session = await ctx.sessionStore.create({ userId: "student" });
  const first = (await ctx.store.createSessionTask!({ userId: "student", sessionId: session.id, turnId: crypto.randomUUID(), title: "取消任务" }, ctx.sessionStore)).task;
  await ctx.store.createSessionTask!({ userId: "student", sessionId: session.id, turnId: crypto.randomUUID(), title: "后续" }, ctx.sessionStore);
  let calls = 0;
  await new Worker({ ...ctx, concurrency: 1, tools: [{ type: "function", function: { name: "web_search", description: "检索", parameters: { type: "object", properties: {} } } }], buildSystem: () => "规则", transport: { async chat() { return { content: "", toolCalls: [1, 2].map((n) => ({ id: String(n), type: "function" as const, function: { name: "web_search", arguments: JSON.stringify({ q: n }) } })), usage: { input: 1, output: 1 }, model: "fixture" }; } }, executeTool: async () => { calls++; await ctx.store.requestCancel(first.id, "student"); return '{"ok":true}'; } }).tick();
  assert.equal(calls, 1);
  assert.equal((await ctx.store.getTask(first.id))?.status, "cancelled");
  assert.equal((await ctx.store.getTask(first.id))?.transcriptCommitted, true);
  assert.ok(await ctx.store.claimNext({ workerId: "next", leaseTtlMs: 60000, now: Date.now() }));
});
