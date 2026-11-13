import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";
import type { LlmTransport } from "../core/llm.ts";
import type { ChatResult, ToolDef } from "../core/types.ts";
import { LlmTransportError } from "../core/errors.ts";

const tools: ToolDef[] = [{ type: "function", function: { name: "save_to_inbox", description: "x", parameters: { type: "object", properties: {} } } }];
const tc = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

class FakeTransport implements LlmTransport {
  i = 0;
  script: Partial<ChatResult>[];
  constructor(script: Partial<ChatResult>[]) { this.script = script; }
  async chat(): Promise<ChatResult> {
    const m = this.script[Math.min(this.i, this.script.length - 1)]; this.i++;
    return { content: m.content ?? "", toolCalls: m.toolCalls ?? [], usage: { input: 1, output: 1 }, model: "fake" };
  }
}

function makeWorker(store: InMemoryStore, transport: LlmTransport, executeTool: (t: unknown, n: string, a: Record<string, unknown>) => Promise<string>, workerId = "w1") {
  return new Worker({ store, transport, tools, buildSystem: () => "s", executeTool, workerId, leaseTtlMs: 60000, heartbeatMs: 1000000 });
}

test("Worker 执行任务 → succeeded + 事件 + 结果", async () => {
  const store = new InMemoryStore();
  const t = await store.createTask({ userId: "u1", title: "写inbox" });
  const transport = new FakeTransport([{ toolCalls: [tc("save_to_inbox", { title: "竞赛" })] }, { content: "已写入。" }]);
  const w = makeWorker(store, transport, async () => JSON.stringify({ ok: true }));
  const n = await w.tick();
  assert.equal(n, 1);
  const done = await store.getTask(t.id);
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.result?.summary, "已写入。");
  const types = (await store.listEvents(t.id)).map((e) => e.type);
  assert.ok(types.includes("task.succeeded"));
  assert.ok(types.includes("eval.passed"));
});

test("传输失败 → Evaluator 拒绝 → failed", async () => {
  const store = new InMemoryStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  const transport: LlmTransport = { async chat() { throw new LlmTransportError("HTTP 401: invalid api key"); } };
  const w = makeWorker(store, transport, async () => "{}");
  await w.tick();
  assert.equal((await store.getTask(t.id))?.status, "failed");
});

test("cancelRequested → cancelled（不执行）", async () => {
  const store = new InMemoryStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  await store.requestCancel(t.id, "u1");
  const transport = new FakeTransport([{ content: "不该执行" }]);
  const w = makeWorker(store, transport, async () => "{}");
  await w.tick();
  assert.equal((await store.getTask(t.id))?.status, "cancelled");
});

test("幂等：模型重复调同工具同参 → 副作用只执行一次", async () => {
  const store = new InMemoryStore();
  await store.createTask({ userId: "u1", title: "x" });
  let calls = 0;
  const transport = new FakeTransport([
    { toolCalls: [tc("save_to_inbox", { title: "x" }, "a")] },
    { toolCalls: [tc("save_to_inbox", { title: "x" }, "b")] },
    { content: "完成。" },
  ]);
  const w = makeWorker(store, transport, async () => { calls++; return JSON.stringify({ ok: true }); });
  await w.tick();
  assert.equal(calls, 1); // 第二次同幂等键被去重
});

test("崩溃重认领：lease 过期后另一 Worker 接管执行", async () => {
  const store = new InMemoryStore();
  const t = await store.createTask({ userId: "u1", title: "x" });
  // w1 认领后"崩溃"（不执行），lease 短
  await store.claimNext({ workerId: "w1", leaseTtlMs: 1000, now: 1000 });
  const transport = new FakeTransport([{ content: "恢复完成。" }]);
  const w2 = new Worker({ store, transport, tools, buildSystem: () => "s", executeTool: async () => "{}", workerId: "w2", leaseTtlMs: 60000, heartbeatMs: 1000000, now: () => 5000 });
  await w2.tick();
  const done = await store.getTask(t.id);
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.lease.owner, "w2");
  assert.equal(done?.attempt, 1);
});