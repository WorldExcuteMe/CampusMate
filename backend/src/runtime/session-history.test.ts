import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InMemoryStore, type TaskStore } from "./store.ts";
import { Worker } from "./worker.ts";
import { InMemoryMemoryStore } from "../core/memory.ts";
import type { ChatMessage } from "../core/types.ts";
import { EMPTY_USAGE } from "../core/types.ts";
import { MAX_SESSION_HISTORY_CHARS, MAX_SESSION_TURNS, sessionMessages, sessionTurnLimit } from "./session-history.ts";

async function done(store: TaskStore, userId: string, sessionId: string | undefined, input: string, summary: string, status: "succeeded" | "failed" | "cancelled" = "succeeded") {
  const task = await store.createTask({ userId, sessionId, title: input, intent: input });
  await store.updateTask(task.id, { status: "running", createdAt: 1 }); // Equal timestamps must not reorder dialogue.
  return await store.updateTask(task.id, { status, result: { summary, artifactIds: [] } });
}

test("session history contains prior user+assistant turns only, in queue order, once per Task", async () => {
  const store = new InMemoryStore();
  const sessionId = randomUUID();
  const first = await done(store, "u1", sessionId, "记住我的项目叫蓝鲸", "记住了，项目叫蓝鲸。");
  const second = await done(store, "u1", sessionId, "截止周五", "截止周五。");
  // A duplicate trace must not duplicate a conversation turn.
  await store.appendEvent({ taskId: first.id, userId: "u1", type: "task.queued" });
  const current = await store.createTask({ userId: "u1", sessionId, title: "项目叫什么？" });
  await done(store, "u1", sessionId, "未来消息不能注入旧任务", "未来答案");
  const history = await store.listSessionHistory({ userId: "u1", sessionId, beforeTaskId: current.id });
  assert.deepEqual(history.map(m => m.content), [first.intent, first.result!.summary, second.intent, second.result!.summary]);
  assert.deepEqual(history.map(m => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(await store.listSessionHistory({ userId: "u1", sessionId, beforeTaskId: current.id }), history);
});

test("same sessionId never grants access across users; other sessions and missing session stay isolated", async () => {
  const store = new InMemoryStore();
  const sessionId = randomUUID(), otherSession = randomUUID();
  await done(store, "u1", sessionId, "mine", "my reply");
  await done(store, "u2", sessionId, "u2-secret", "u2-secret-reply");
  await done(store, "u1", otherSession, "other-session-secret", "other-reply");
  await done(store, "u1", undefined, "standalone-secret", "standalone-reply");
  const current = await store.createTask({ userId: "u1", sessionId, title: "current" });
  const q = { userId: "u1", sessionId, beforeTaskId: current.id };
  assert.deepEqual((await store.listSessionHistory(q)).map(m => m.content), ["mine", "my reply"]);
  assert.deepEqual(await store.listSessionHistory({ ...q, userId: "u2" }), []);
  assert.deepEqual(await store.listSessionHistory({ ...q, sessionId: otherSession }), []);
  assert.deepEqual(await store.listSessionHistory({ ...q, sessionId: "" }), []);
});

test("failed/cancelled outcomes stay marked, pending and running Tasks are not fake assistant answers", async () => {
  const store = new InMemoryStore(), sessionId = randomUUID();
  await done(store, "u", sessionId, "write", "模型声称成功，但写入失败", "failed");
  await done(store, "u", sessionId, "cancel", "未执行后续步骤", "cancelled");
  const pending = await store.createTask({ userId: "u", sessionId, title: "pending" });
  const running = await store.createTask({ userId: "u", sessionId, title: "running" });
  await store.updateTask(running.id, { status: "running" });
  const current = await store.createTask({ userId: "u", sessionId, title: "current" });
  const history = await store.listSessionHistory({ userId: "u", sessionId, beforeTaskId: current.id });
  assert.equal(history.length, 4);
  assert.match(String(history[1].content), /历史任务失败/);
  assert.match(String(history[3].content), /历史任务已取消/);
  assert.ok(!history.some(m => m.content === pending.intent || m.content === running.intent));
});

test("history limits keep newest whole turns and cap total text, not unlimited entire sessions", async () => {
  const store = new InMemoryStore(), sessionId = randomUUID();
  for (let i = 0; i < 25; i++) await done(store, "u", sessionId, `question-${i}`, `answer-${i}`);
  const current = await store.createTask({ userId: "u", sessionId, title: "current" });
  const history = await store.listSessionHistory({ userId: "u", sessionId, beforeTaskId: current.id, maxTurns: 2 });
  assert.deepEqual(history.map(m => m.content), ["question-23", "answer-23", "question-24", "answer-24"]);
  assert.equal(sessionTurnLimit(1e9), MAX_SESSION_TURNS);
  const huge = Array.from({ length: 20 }, () => ({ intent: "x".repeat(20_000), status: "succeeded" as const, result: { summary: "y".repeat(20_000), artifactIds: [] } }));
  const bounded = sessionMessages(huge);
  assert.ok(bounded.reduce((n, m) => n + String(m.content).length, 0) <= MAX_SESSION_HISTORY_CHARS);
  assert.ok(bounded.length > 0 && bounded.length % 2 === 0);
  assert.match(String(bounded[0].content), /历史消息已截断/);
});

test("fresh Worker for second Task sees first Task input and real reply", async () => {
  const store = new InMemoryStore(), sessionId = randomUUID();
  const memory = new InMemoryMemoryStore();
  await memory.setUserMemory("u1", { major: "物理" }, {});
  await memory.setUserMemory("u2", { secret: "other-user-profile" }, {});
  const run = async (input: string, reply: string) => {
    const task = await store.createTask({ userId: "u1", sessionId, title: input });
    let messages: ChatMessage[] = [];
    await new Worker({ store, tools: [], buildSystem: () => "fixture system", executeTool: async () => '{}', concurrency: 1,
      memoryStore: memory, heartbeatMs: 1e9,
      transport: { async chat(opts) { messages = opts.messages; return { content: reply, toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" }; } },
    }).tick();
    assert.equal((await store.getTask(task.id))?.status, "succeeded");
    return messages;
  };
  await run("请记住：项目名是蓝鲸", "已记住蓝鲸。");
  const second = await run("刚才项目名是什么？", "蓝鲸");
  assert.deepEqual(second.filter(m => m.role !== "system").map(m => m.content), ["请记住：项目名是蓝鲸", "已记住蓝鲸。", "刚才项目名是什么？"]);
  assert.match(String(second[0].content), /物理/);
  assert.ok(!JSON.stringify(second).includes("other-user-profile"));
});

test("checkpoint resume does not append prior session turns or current input twice", async () => {
  const store = new InMemoryStore(), sessionId = randomUUID();
  await done(store, "u", sessionId, "old question", "old answer");
  const current = await store.createTask({ userId: "u", sessionId, title: "continue" });
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "old question" }, { role: "assistant", content: "old answer" }, { role: "user", content: "continue" }];
  await store.writeCheckpoint({ taskId: current.id, userId: "u", eventSeq: 0, state: { messages, usage: EMPTY_USAGE, repeat: {}, stepProgress: {}, pendingApprovals: [] } });
  store.listSessionHistory = async () => { throw new Error("must not reload frozen checkpoint history"); };
  let observed: ChatMessage[] = [];
  await new Worker({ store, tools: [], buildSystem: () => "s", executeTool: async () => '{}', concurrency: 1, heartbeatMs: 1e9,
    transport: { async chat(opts) { observed = opts.messages; return { content: "done", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture" }; } },
  }).tick();
  assert.deepEqual(observed, messages);
  assert.equal((await store.getTask(current.id))?.status, "succeeded");
});

test("retrying a Task updates one durable turn, not an append-only duplicate", async () => {
  const store = new InMemoryStore(), sessionId = randomUUID();
  const first = await done(store, "u", sessionId, "write", "failed", "failed");
  await store.updateTask(first.id, { status: "queued" });
  await store.updateTask(first.id, { status: "running" });
  await store.updateTask(first.id, { status: "succeeded", result: { summary: "retried successfully", artifactIds: [] } });
  const current = await store.createTask({ userId: "u", sessionId, title: "current" });
  const history = await store.listSessionHistory({ userId: "u", sessionId, beforeTaskId: current.id });
  assert.deepEqual(history.map(m => m.content), ["write", "retried successfully"]);
});
