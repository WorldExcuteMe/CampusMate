import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../app-context.ts";
import { Worker } from "./worker.ts";
import type { ChatMessage } from "../core/types.ts";

test("AC01：真实Worker读取同会话先前身份和画像，当前问题仅出现一次", async () => {
  const ctx = buildContext({});
  const session = await ctx.sessionStore.create({ userId: "student", title: "竞赛建议" });
  await ctx.personalContext.setProfile({ userId: "student", university: "示例大学", major: "计算机", grade: "大二", skills: ["Python"], interests: [], goals: [], preferences: {}, updatedAt: 1 });
  const earlier = await ctx.store.createTask({ userId: "student", sessionId: session.id, title: "介绍", intent: "我是示例大学计算机专业大二学生" });
  await ctx.sessionStore.appendMessage({ userId: "student", sessionId: session.id, turnId: "first", messageKey: "first:user", taskId: earlier.id, role: "user", content: earlier.intent });
  const requests: ChatMessage[][] = [];
  const deps = { ...ctx, transport: { async chat(opts: { messages: ChatMessage[] }) { requests.push(structuredClone(opts.messages)); return { content: "已了解", toolCalls: [], usage: { input: 10, output: 2 }, model: "fixture" }; } }, tools: [], buildSystem: () => "校园助手", executeTool: async () => "{}", concurrency: 1 };
  await new Worker(deps).tick();
  await ctx.store.createTask({ userId: "student", sessionId: session.id, title: "推荐", intent: "根据我的身份推荐竞赛" });
  await new Worker(deps).tick();
  assert.match(JSON.stringify(requests[1]), /示例大学/);
  assert.match(JSON.stringify(requests[1]), /Python/);
  assert.equal(requests[1].filter((m) => m.role === "user" && m.content === "根据我的身份推荐竞赛").length, 1);
  assert.equal((await ctx.sessionStore.listMessages("student", session.id)).filter((m) => m.role === "assistant").length, 2);
  const completed = (await ctx.store.listTasksByUser("student")).find((t) => t.title === "推荐")!;
  assert.equal(completed.promptUsage?.inputTokens, 10);
  assert.equal(completed.usage.tokens, 12);
  assert.equal(completed.promptUsage?.contextLimit, null, "未配置端点能力时窗口上限未知");
});

test("AC02：同用户其他会话的身份不注入当前Worker", async () => {
  const ctx = buildContext({});
  const first = await ctx.sessionStore.create({ userId: "student" });
  const current = await ctx.sessionStore.create({ userId: "student" });
  await ctx.sessionStore.appendMessage({ userId: "student", sessionId: first.id, turnId: "old", messageKey: "old:user", role: "user", content: "跨会话私有身份标记" });
  const task = await ctx.store.createTask({ userId: "student", sessionId: current.id, title: "当前问题" });
  const requests: ChatMessage[][] = [];
  await new Worker({ ...ctx, transport: { async chat(opts) { requests.push(structuredClone(opts.messages)); return { content: "回答", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" }; } }, tools: [], buildSystem: () => "校园助手", executeTool: async () => "{}" }).tick();
  assert.doesNotMatch(JSON.stringify(requests), /跨会话私有身份标记/);
  assert.equal((await ctx.store.getTask(task.id))?.status, "succeeded");
});

test("AC02：Worker保留真实工具交互及最终回复供后续轮次读取", async () => {
  const ctx = buildContext({});
  const session = await ctx.sessionStore.create({ userId: "student" });
  await ctx.store.createTask({ userId: "student", sessionId: session.id, title: "查资料" });
  let call = 0;
  await new Worker({ ...ctx, tools: [{ type: "function", function: { name: "lookup", description: "fixture", parameters: { type: "object", properties: {} } } }], transport: { async chat() { return call++ === 0
    ? { content: "", toolCalls: [{ id: "lookup-1", type: "function" as const, function: { name: "lookup", arguments: "{}" } }], usage: { input: 1, output: 1 }, model: "fixture" }
    : { content: "资料结论", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" }; } }, buildSystem: () => "校园助手", executeTool: async () => '{"source":"https://school.example","found":true}' }).tick();
  const messages = await ctx.sessionStore.listMessages("student", session.id);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(messages[1].tool_calls?.[0].id, "lookup-1");
  assert.equal(messages[2].tool_call_id, "lookup-1");
  assert.equal(messages[3].content, "资料结论");
});

test("AC02：Worker压缩并保存连续摘要，重建后保留身份与最新纠正及原始长结果", async () => {
  const ctx = buildContext({});
  const session = await ctx.sessionStore.create({ userId: "student" });
  for (let turn = 1; turn <= 10; turn++) {
    await ctx.store.createSessionTask!({ userId: "student", sessionId: session.id, turnId: crypto.randomUUID(), title: `历史${turn}`, intent: turn === 1 ? "我是计算机大二，擅长Python" : turn === 8 ? "更正：现在是大三" : "继续研究" }, ctx.sessionStore);
  }
  for (let turn = 1; turn <= 10; turn++) {
    const task = await ctx.store.claimNext({ workerId: "history", leaseTtlMs: 60000, now: Date.now() });
    assert.equal(task?.turnSeq, turn);
    const raw = [{ role: "assistant" as const, content: `资料${turn}：` + "原始材料".repeat(12000) }];
    await ctx.store.finishSessionTurn!({ taskId: task!.id, userId: "student", workerId: "history", attempt: task!.attempt, now: Date.now(), state: { messages: [], transcript: raw, repeat: {}, stepProgress: {}, usage: task!.usage, pendingApprovals: [] }, patch: { status: "succeeded" } }, ctx.sessionStore);
  }
  await ctx.store.createSessionTask!({ userId: "student", sessionId: session.id, turnId: crypto.randomUUID(), title: "推荐", intent: "根据我的身份推荐" }, ctx.sessionStore);
  let request = "";
  await new Worker({ ...ctx, tools: [], transport: { async chat(opts) { request = JSON.stringify(opts.messages); return { content: "推荐结果", toolCalls: [], usage: { input: 20, output: 3 }, model: "fixture" }; } }, buildSystem: () => "校园助手", executeTool: async () => "{}", concurrency: 1 }).tick();
  assert.match(request, /计算机大二/);
  assert.match(request, /更正：现在是大三/);
  const saved = await ctx.sessionStore.get("student", session.id);
  assert.ok(saved!.summaryThroughSeq > 0, "实际Worker需要保存带seq边界的摘要");
  assert.ok(saved!.summaryThroughSeq <= 4, "摘要不能跨过未概括的近期轮次，即使旧回复稍后才写入");
  assert.equal((await ctx.sessionStore.listMessages("student", session.id))[10].content.length, 48004, "摘要不可改写原始材料");
});
