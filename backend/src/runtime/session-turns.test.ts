import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { createApiServer } from "../api/server.ts";
import { signJwt } from "../api/jwt.ts";
import { buildContext } from "../app-context.ts";
import { OWNER, storageFixture } from "./storage-test-fixture.ts";
import { Worker } from "./worker.ts";
import type { ChatMessage } from "../core/types.ts";

async function fixture(t: TestContext, postgres: boolean) {
  const ctx = postgres ? (await storageFixture(t)).first : buildContext({});
  const server = createApiServer({ ...ctx, jwtSecret: "turn-fixture" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await ctx.sessionStore.create({ userId: OWNER });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${signJwt({ sub: OWNER, exp: Math.floor(Date.now() / 1000) + 3600 }, "turn-fixture")}` };
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const input = (intent: string) => ({ title: intent, intent, sessionId: session.id, turnId: randomUUID() });
  return { ctx, post, input, session };
}

for (const postgres of [false, true]) {
  const mode = postgres ? "postgres" : "memory";
  test(`${mode}：暂停后新轮次必须立即提示恢复或取消，不能接受一个永不认领的排队任务`, async t => {
    const { ctx, post, input, session } = await fixture(t, postgres);
    const body = input("需要暂停的前轮");
    const first = await (await post("/v1/tasks", body)).json() as { taskId: string };
    const claimed = await ctx.store.claimNext({ workerId: "one", leaseTtlMs: 60000, now: Date.now() });
    assert.equal(claimed?.id, first.taskId);
    await ctx.store.updateTask(first.taskId, { status: "paused" });
    const blocked = await post("/v1/tasks", input("新的后轮"));
    assert.equal(blocked.status, 409); assert.match((await blocked.json() as {error:string}).error, /恢复.*取消/);
    assert.equal((await ctx.store.listSessionTasks(OWNER, session.id)).length, 1);
    assert.equal((await ctx.sessionStore.listMessages(OWNER, session.id)).length, 1);
    const retry = await post("/v1/tasks", body);
    assert.equal(retry.status, 201, "保留既有HTTP契约");
    const retried = await retry.json() as { taskId: string; deduped: boolean };
    assert.equal(retried.taskId, first.taskId); assert.equal(retried.deduped, true, "同turn网络重试仍幂等，不被新轮屏障拒绝");
    await ctx.store.requestCancel(first.taskId, OWNER);
    const next = await (await post("/v1/tasks", input("取消后继续"))).json() as {taskId:string};
    assert.equal((await ctx.store.claimNext({ workerId:"two", leaseTtlMs:60000, now:Date.now() }))?.id,next.taskId);
  });
  test(`${mode}：同turn并发网络重试原子接受一个任务和一条用户消息`, async (t) => {
    const { ctx, post, input, session } = await fixture(t, postgres);
    const body = input("我是计算机大二，擅长Python");
    const responses = await Promise.all([post("/v1/tasks", body), post("/v1/tasks", body)]);
    const data = await Promise.all(responses.map((r) => r.json())) as { taskId: string }[];
    assert.equal(data[0].taskId, data[1].taskId, "重试不能重复执行同一轮");
    assert.equal((await ctx.store.listTasksByUser(OWNER)).length, 1);
    assert.deepEqual((await ctx.sessionStore.listMessages(OWNER, session.id)).map((m) => m.content), [body.intent]);
  });

  test(`${mode}：同turn不同输入冲突，不覆盖已接受身份`, async (t) => {
    const { ctx, post, input, session } = await fixture(t, postgres);
    const body = input("我是大二");
    await post("/v1/tasks", body);
    const conflict = await post("/v1/tasks", { ...body, intent: "我是大四" });
    assert.equal(conflict.status, 409);
    assert.deepEqual((await ctx.sessionStore.listMessages(OWNER, session.id)).map((m) => m.content), ["我是大二"]);
  });

  test(`${mode}：较早轮次暂停时另一Worker不能抢跑后轮`, async (t) => {
    const { ctx, post, input } = await fixture(t, postgres);
    await post("/v1/tasks", input("前轮"));
    await post("/v1/tasks", input("后轮"));
    const first = await ctx.store.claimNext({ workerId: "one", leaseTtlMs: 60000, now: Date.now() });
    assert.ok(first);
    await ctx.store.updateTask(first.id, { status: "needs_input" });
    assert.equal(await ctx.store.claimNext({ workerId: "two", leaseTtlMs: 60000, now: Date.now() }), null);
    assert.equal((await post(`/v1/tasks/${first.id}/resume`, {})).status, 200, "尚在屏障后的queued轮次不应阻止暂停任务恢复");
  });

  test(`${mode}：已有后续对话时旧失败任务提示新消息继续，原记录不变`, async (t) => {
    const { ctx, post, input } = await fixture(t, postgres);
    const created = await (await post("/v1/tasks", input("旧任务"))).json() as { taskId: string };
    await ctx.store.updateTask(created.taskId, { status: "running" });
    await ctx.store.updateTask(created.taskId, { status: "failed" });
    await post("/v1/tasks", input("后续问题"));
    const resumed = await post(`/v1/tasks/${created.taskId}/resume`, {});
    assert.equal(resumed.status, 409);
    assert.match(JSON.stringify(await resumed.json()), /新消息/);
    assert.equal((await ctx.store.getTask(created.taskId))?.status, "failed");
  });

  test(`${mode}：审批恢复先续完原工具组，历史保持调用配对`, async (t) => {
    const { ctx, post, input, session } = await fixture(t, postgres);
    const created = await (await post("/v1/tasks", input("核验并搜索"))).json() as { taskId: string };
    const calls: string[] = [];
    let round = 0;
    const deps = { ...ctx, workerId: "approval-worker", concurrency: 1, tools: ["propose_verification", "web_search"].map((name) => ({ type: "function" as const, function: { name, description: "fixture", parameters: { type: "object", properties: {} } } })), transport: { async chat(opts: { messages: ChatMessage[] }) {
      if (round++ === 0) return { content: "", toolCalls: [{ id: "approval-call", type: "function" as const, function: { name: "propose_verification", arguments: "{}" } }, { id: "search-call", type: "function" as const, function: { name: "web_search", arguments: "{}" } }], usage: { input: 1, output: 1 }, model: "fixture" };
      for (const name of ["approval-call", "search-call"]) assert.ok(opts.messages.some((m) => m.role === "tool" && m.tool_call_id === name && !JSON.stringify(m.content).includes("__approval_pending__")), "恢复请求不得包含未完成的工具组");
      return { content: "核验搜索完成", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
    } }, buildSystem: () => "校园助手", executeTool: async (_task: unknown, name: string) => { calls.push(name); return '{"ok":true}'; } };
    await new Worker(deps).tick();
    assert.equal((await ctx.store.getTask(created.taskId))?.status, "needs_input");
    const approval = (await ctx.approvals.listPendingByUser(OWNER))[0];
    await ctx.approvals.decide(approval.id, OWNER, "approved");
    assert.equal((await post(`/v1/tasks/${created.taskId}/resume`, {})).status, 200);
    await new Worker(deps).tick();
    assert.deepEqual(calls, ["propose_verification", "web_search"]);
    assert.equal((await ctx.store.getTask(created.taskId))?.result?.summary, "核验搜索完成");
    assert.deepEqual((await ctx.sessionStore.listMessages(OWNER, session.id)).map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
  });

  test(`${mode}：检查点写入失败暂停重试，不被模型可达验收当成成功`, async (t) => {
    const { ctx, post, input } = await fixture(t, postgres);
    const created = await (await post("/v1/tasks", input("持久化任务"))).json() as { taskId: string };
    ctx.store.saveTurnProgress = async () => { throw new Error("fixture persistence unavailable"); };
    await new Worker({ ...ctx, concurrency: 1, tools: [{ type: "function", function: { name: "web_search", description: "fixture", parameters: { type: "object", properties: {} } } }], transport: { async chat() { return { content: "", toolCalls: [{ id: "persist-call", type: "function", function: { name: "web_search", arguments: "{}" } }], usage: { input: 1, output: 1 }, model: "fixture" }; } }, buildSystem: () => "校园助手", executeTool: async () => '{"ok":true}' }).tick();
    const task = await ctx.store.getTask(created.taskId);
    assert.equal(task?.status, "paused");
    assert.equal(task?.transcriptCommitted, false);
    assert.match(task?.error ?? "", /历史.*保存/);
  });

  test(`${mode}：JSON回退协议的审批也可恢复，pending不进入不可变历史`, async (t) => {
    const { ctx, post, input, session } = await fixture(t, postgres);
    const created = await (await post("/v1/tasks", input("核验"))).json() as { taskId: string };
    let round = 0, executed = 0;
    const deps = { ...ctx, concurrency: 1, tools: [{ type: "function" as const, function: { name: "propose_verification", description: "fixture", parameters: { type: "object", properties: {} } } }], transport: { async chat(opts: { messages: ChatMessage[] }) {
      if (round++ === 0) return { content: '{"tool":"propose_verification","args":{}}', toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
      assert.ok(JSON.stringify(opts.messages).includes('verified'), "恢复必须先实际执行JSON工具");
      assert.ok(!JSON.stringify(opts.messages).includes('__approval_pending__'));
      return { content: "核验完成", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
    } }, buildSystem: () => "校园助手", executeTool: async () => { executed++; return '{"verified":true}'; } };
    await new Worker(deps).tick();
    assert.deepEqual((await ctx.sessionStore.listMessages(OWNER, session.id)).map((m) => m.role), ["user"]);
    const approval = (await ctx.approvals.listPendingByUser(OWNER))[0];
    await ctx.approvals.decide(approval.id, OWNER, "approved");
    await post(`/v1/tasks/${created.taskId}/resume`, {});
    await new Worker(deps).tick();
    assert.equal(executed, 1);
    assert.equal((await ctx.store.getTask(created.taskId))?.result?.summary, "核验完成");
  });

  test(`${mode}：过时Worker不能调用模型或覆盖新租约`, async (t) => {
    const { ctx, post, input } = await fixture(t, postgres);
    await post("/v1/tasks", input("租约任务"));
    const stale = await ctx.store.claimNext({ workerId: "old", leaseTtlMs: 100, now: 1000 });
    assert.ok(stale);
    await ctx.store.claimNext({ workerId: "new", leaseTtlMs: 60000, now: 2000 });
    let calls = 0;
    await new Worker({ ...ctx, workerId: "old", now: () => 2000, tools: [], transport: { async chat() { calls++; return { content: "过时回答", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" }; } }, buildSystem: () => "校园助手", executeTool: async () => "{}" }).executeTask(stale);
    assert.equal(calls, 0);
    assert.equal((await ctx.store.getTask(stale.id))?.lease.owner, "new");
    assert.equal((await ctx.store.getTask(stale.id))?.status, "running");
  });
  test(`${mode}：工具组中途预算耗尽暂停，调整后只续跑未执行工具`, async (t) => {
    const { ctx, post, input, session } = await fixture(t, postgres);
    const created = await (await post("/v1/tasks", { ...input("两步检索"), budget: { toolCalls: 1 } })).json() as { taskId: string };
    let round = 0; const calls: string[] = [];
    const deps = { ...ctx, concurrency: 1, tools: ["web_search", "web_fetch"].map((name) => ({ type: "function" as const, function: { name, description: "fixture", parameters: { type: "object", properties: {} } } })), buildSystem: () => "规则", executeTool: async (_task: unknown, name: string) => { calls.push(name); return '{"ok":true}'; }, transport: { async chat() {
      return round++ === 0 ? { content: "", toolCalls: ["web_search", "web_fetch"].map((name) => ({ id: name, type: "function" as const, function: { name, arguments: "{}" } })), usage: { input: 1, output: 1 }, model: "fixture" } : { content: "完成检索", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" };
    } } };
    await new Worker(deps).tick();
    assert.equal((await ctx.store.getTask(created.taskId))?.status, "paused");
    assert.deepEqual(calls, ["web_search"]);
    assert.equal((await post(`/v1/tasks/${created.taskId}/resume`, {})).status, 409);
    assert.equal((await post(`/v1/tasks/${created.taskId}/resume`, { budget: { toolCalls: 4 } })).status, 200);
    await new Worker(deps).tick();
    assert.deepEqual(calls, ["web_search", "web_fetch"]);
    assert.equal((await ctx.store.getTask(created.taskId))?.status, "succeeded");
    assert.deepEqual((await ctx.sessionStore.listMessages(OWNER, session.id)).map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
  });

  test(`${mode}：真实API到Worker严格按轮保存身份和回答，不读取未来问题`, async (t) => {
    const { ctx, post, input } = await fixture(t, postgres);
    await post("/v1/tasks", input("我是示例大学计算机大二，擅长Python"));
    await post("/v1/tasks", input("根据我的身份推荐竞赛"));
    const requests: ChatMessage[][] = [];
    const deps = { ...ctx, workerId: "session-worker", concurrency: 1, tools: [], transport: { async chat(opts: { messages: ChatMessage[] }) { requests.push(structuredClone(opts.messages)); return { content: requests.length === 1 ? "已记住你的身份" : "推荐结论", toolCalls: [], usage: { input: 10, output: 2 }, model: "fixture" }; } }, buildSystem: () => "校园助手", executeTool: async () => "{}" };
    assert.equal(await new Worker(deps).tick(), 1);
    assert.doesNotMatch(JSON.stringify(requests[0]), /根据我的身份推荐竞赛/);
    assert.equal(await new Worker(deps).tick(), 1, "前一轮历史提交后必须释放下一轮");
    assert.match(JSON.stringify(requests[1]), /示例大学/);
    assert.match(JSON.stringify(requests[1]), /已记住你的身份/);
    assert.equal(requests[1].filter((m) => m.role === "user" && m.content === "根据我的身份推荐竞赛").length, 1);
  });
}
