import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresStore } from "./postgres-store.ts";
import type { SqlClient, SqlPool, SqlResult } from "./sql.ts";
import type { ToolInvocation } from "../core/types.ts";
import { DEFAULT_BUDGET, EMPTY_USAGE } from "../core/types.ts";

type Row = Record<string, unknown>;
const taskRow = (over: Row = {}): Row => ({
  id: "t1", user_id: "u1", goal_id: null, session_id: null, title: "x", intent: "x",
  status: "queued", priority: 50, lease_owner: null, lease_expires_at: null, heartbeat_at: null,
  attempt: 0, max_attempts: 3, budget: DEFAULT_BUDGET, usage: EMPTY_USAGE,
  last_checkpoint_id: null, cancel_requested: false, result: null, error: null,
  created_at: new Date(1000), updated_at: new Date(1000), ...over,
});
const eventRow = (over: Row = {}): Row => ({ id: 1, task_id: "t1", user_id: "u1", step_id: null, seq: 1, type: "task.queued", payload: {}, created_at: new Date(1), ...over });
const invRow = (over: Row = {}): Row => ({ id: "i1", task_id: "t1", user_id: "u1", step_id: null, tool_name: "save_to_inbox", idempotency_key: "k1", args_hash: "h", runtime: "cloud", status: "succeeded", approval_id: null, result: { ok: true }, error: null, attempt: 1, started_at: new Date(1), finished_at: new Date(2), ...over });

class FakePool implements SqlPool {
  calls: { text: string; params?: unknown[] }[] = [];
  handler: (text: string, params?: unknown[]) => SqlResult;
  constructor(handler: (text: string, params?: unknown[]) => SqlResult) { this.handler = handler; }
  async query<T = Row>(text: string, params?: unknown[]): Promise<SqlResult<T>> { this.calls.push({ text, params }); return this.handler(text, params) as SqlResult<T>; }
  async transaction<T>(fn: (c: SqlClient) => Promise<T>): Promise<T> { this.calls.push({ text: "BEGIN" }); const r = await fn(this); this.calls.push({ text: "COMMIT" }); return r; }
  async end(): Promise<void> {}
  texts(): string[] { return this.calls.map((c) => c.text); }
}

const inv = (): ToolInvocation => ({ id: "i1", taskId: "t1", userId: "u1", toolName: "save_to_inbox", idempotencyKey: "k1", argsHash: "h", runtime: "cloud", status: "succeeded", result: { ok: true }, attempt: 1, startedAt: 1, finishedAt: 2 });

test("createTask 发 INSERT...RETURNING 且追加 task.queued 事件", async () => {
  const pool = new FakePool((t) => /insert into agent_tasks/i.test(t) ? { rows: [taskRow()], rowCount: 1 } : { rows: [eventRow()], rowCount: 1 });
  const store = new PostgresStore(pool);
  const task = await store.createTask({ userId: "u1", title: "x" });
  assert.equal(task.id, "t1");
  assert.equal(task.status, "queued");
  assert.ok(pool.texts().some((t) => /insert into agent_tasks/i.test(t) && /returning \*/i.test(t)));
  assert.ok(pool.texts().some((t) => /insert into agent_events/i.test(t)));
});

test("claimNext 用事务 + FOR UPDATE SKIP LOCKED", async () => {
  const pool = new FakePool((t) => /update agent_tasks/i.test(t) ? { rows: [taskRow({ status: "running", lease_owner: "w1", lease_expires_at: new Date(61000) })], rowCount: 1 } : { rows: [eventRow({ type: "task.claimed" })], rowCount: 1 });
  const store = new PostgresStore(pool);
  const c = await store.claimNext({ workerId: "w1", leaseTtlMs: 60000, now: 1000 });
  assert.equal(c?.status, "running");
  assert.equal(c?.lease.owner, "w1");
  assert.ok(pool.texts().includes("BEGIN"));
  assert.ok(pool.texts().includes("COMMIT"));
  assert.ok(pool.texts().some((t) => /for update skip locked/i.test(t)));
});

test("recordInvocation 用 ON CONFLICT DO NOTHING；冲突→deduped", async () => {
  const pool = new FakePool((t) => {
    if (/insert into agent_tool_invocations/i.test(t)) return { rows: [], rowCount: 0 }; // 冲突
    if (/select \* from agent_tool_invocations/i.test(t)) return { rows: [invRow()], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const store = new PostgresStore(pool);
  const r = await store.recordInvocation(inv());
  assert.equal(r.deduped, true);
  assert.ok(pool.texts().some((t) => /on conflict \(task_id, idempotency_key\) do nothing/i.test(t)));
});

test("recordInvocation 新建→deduped=false", async () => {
  const pool = new FakePool((t) => /insert into agent_tool_invocations/i.test(t) ? { rows: [invRow()], rowCount: 1 } : { rows: [], rowCount: 0 });
  const store = new PostgresStore(pool);
  assert.equal((await store.recordInvocation(inv())).deduped, false);
});

test("行映射：timestamptz→epoch ms，jsonb→对象，lease 组装", async () => {
  const pool = new FakePool(() => ({ rows: [taskRow({ lease_owner: "w1", lease_expires_at: new Date(5000), heartbeat_at: new Date(4000), budget: { tokens: 1, toolCalls: 2, wallMs: 3, costUsd: 4 } })], rowCount: 1 }));
  const store = new PostgresStore(pool);
  const t = await store.getTask("t1");
  assert.equal(t?.createdAt, 1000);
  assert.equal(t?.lease.owner, "w1");
  assert.equal(t?.lease.expiresAt, 5000);
  assert.equal(t?.lease.heartbeatAt, 4000);
  assert.deepEqual(t?.budget, { tokens: 1, toolCalls: 2, wallMs: 3, costUsd: 4 });
});

test("appendEvent seq=MAX+1（append-only）", async () => {
  const pool = new FakePool(() => ({ rows: [eventRow({ seq: 7 })], rowCount: 1 }));
  const store = new PostgresStore(pool);
  const e = await store.appendEvent({ taskId: "t1", userId: "u1", type: "llm.request" });
  assert.equal(e.seq, 7);
  assert.ok(pool.texts().some((t) => /coalesce\(max\(seq\),0\)\+1/i.test(t)));
});

test("renewLease 限定 owner+running", async () => {
  const pool = new FakePool(() => ({ rows: [{ id: "t1" }], rowCount: 1 }));
  const store = new PostgresStore(pool);
  assert.equal(await store.renewLease("t1", "w1", 1000, 2000), true);
  assert.ok(pool.texts().some((t) => /lease_owner=\$4 and status='running'/i.test(t)));
});

test("updateTask 非法状态转换抛错", async () => {
  const pool = new FakePool((t) => /select \* from agent_tasks/i.test(t) ? { rows: [taskRow({ status: "succeeded" })], rowCount: 1 } : { rows: [taskRow()], rowCount: 1 });
  const store = new PostgresStore(pool);
  await assert.rejects(() => store.updateTask("t1", { status: "running" }), /非法任务状态转换/);
});

test("requestCancel 限定 user_id（跨用户隔离）", async () => {
  const pool = new FakePool(() => ({ rows: [], rowCount: 0 }));
  const store = new PostgresStore(pool);
  assert.equal(await store.requestCancel("t1", "u2"), false);
  assert.ok(pool.texts().some((t) => /where id=\$1 and user_id=\$2/i.test(t)));
});