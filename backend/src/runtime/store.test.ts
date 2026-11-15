import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStore } from "./store.ts";
import type { ToolInvocation } from "../core/types.ts";

function inv(taskId: string, key: string): ToolInvocation {
  return { id: "i1", taskId, userId: "u1", toolName: "save_to_inbox", idempotencyKey: key, argsHash: "h", runtime: "cloud", status: "succeeded", attempt: 1, startedAt: 1 };
}

test("createTask → queued + 事件", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "收集竞赛" });
  assert.equal(t.status, "queued");
  const ev = await s.listEvents(t.id);
  assert.equal(ev[0].type, "task.queued");
  assert.equal(ev[0].seq, 1);
});

test("claimNext 认领置 running+lease；无其他任务返回 null", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  const c = await s.claimNext({ workerId: "w1", leaseTtlMs: 60000, now: 1000 });
  assert.equal(c?.id, t.id);
  assert.equal(c?.status, "running");
  assert.equal(c?.lease.owner, "w1");
  assert.equal(c?.lease.expiresAt, 61000);
  assert.equal(await s.claimNext({ workerId: "w2", leaseTtlMs: 60000, now: 1000 }), null);
});

test("lease 过期 → 重认领 attempt+1（崩溃恢复）", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  await s.claimNext({ workerId: "w1", leaseTtlMs: 1000, now: 1000 }); // expires 2000
  const reclaimed = await s.claimNext({ workerId: "w2", leaseTtlMs: 1000, now: 3000 });
  assert.equal(reclaimed?.id, t.id);
  assert.equal(reclaimed?.lease.owner, "w2");
  assert.equal(reclaimed?.attempt, 1);
});

test("renewLease owner 校验", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  await s.claimNext({ workerId: "w1", leaseTtlMs: 1000, now: 1000 });
  assert.equal(await s.renewLease(t.id, "w1", 1000, 1500), true);
  assert.equal(await s.renewLease(t.id, "w2", 1000, 1500), false);
});

test("requestCancel owner 隔离", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  assert.equal(await s.requestCancel(t.id, "u2"), false);
  assert.equal(await s.requestCancel(t.id, "u1"), true);
  assert.equal((await s.getTask(t.id))?.cancelRequested, true);
});

test("事件 seq 单调递增", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  await s.appendEvent({ taskId: t.id, userId: "u1", type: "llm.request" });
  await s.appendEvent({ taskId: t.id, userId: "u1", type: "llm.response" });
  const ev = await s.listEvents(t.id);
  assert.deepEqual(ev.map((e) => e.seq), [1, 2, 3]);
  assert.equal((await s.listEvents(t.id, 2)).length, 1);
});

test("recordInvocation 幂等去重", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  const first = await s.recordInvocation(inv(t.id, "k1"));
  const second = await s.recordInvocation(inv(t.id, "k1"));
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.invocation.id, first.invocation.id);
});

test("updateTask 非法转换抛错", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  await s.updateTask(t.id, { status: "running" });
  await s.updateTask(t.id, { status: "succeeded" });
  await assert.rejects(() => s.updateTask(t.id, { status: "running" }), /非法任务状态转换/);
});

test("checkpoint 写入与最新读取", async () => {
  const s = new InMemoryStore();
  const t = await s.createTask({ userId: "u1", title: "x" });
  const cp = await s.writeCheckpoint({ taskId: t.id, userId: "u1", eventSeq: 1, state: { messages: [], stepProgress: {}, repeat: {}, usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 }, pendingApprovals: [] } });
  assert.equal((await s.latestCheckpoint(t.id))?.id, cp.id);
  assert.equal((await s.getTask(t.id))?.lastCheckpointId, cp.id);
});