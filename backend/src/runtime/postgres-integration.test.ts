// Explicit isolated database opt-in; never load .env files or DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContext } from "../app-context.ts";
import { PgPool } from "./sql.ts";
import type { ToolInvocation } from "../core/types.ts";

const connection = process.env.TEST_DATABASE_URL;
test("隔离 PostgreSQL：独立 context 的真实共享状态", { skip: connection ? false : "未显式设置隔离 TEST_DATABASE_URL；未连接数据库" }, async (t) => {
  const url = new URL(connection!);
  const pool = new PgPool(connection!, { ssl: !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), connectionTimeoutMillis: 6000 });
  const userId = randomUUID();
  t.after(async () => {
    try { await pool.query("delete from auth.users where id=$1", [userId]); }
    finally { await pool.end(); }
  });
  await pool.query("insert into auth.users(id,email) values($1,$2)", [userId, `${userId}@fixture.test`]);
  const api = buildContext({}, { pool }); const worker = buildContext({}, { pool });
  const task = await api.store.createTask({ userId, title: "独立context共享任务" });
  assert.equal((await worker.store.getTask(task.id))?.title, "独立context共享任务");
  assert.equal(task.status, "queued");
  const claimed = await worker.store.claimNext({ workerId: "fixture-w1", leaseTtlMs: 60000, now: Date.now() });
  assert.equal(claimed?.id, task.id);
  assert.equal(claimed?.status, "running");
  assert.equal(await worker.store.claimNext({ workerId: "fixture-w2", leaseTtlMs: 60000, now: Date.now() }), null);
  assert.equal(await worker.store.renewLease(task.id, "fixture-w1", 60000, Date.now()), true);
  assert.equal(await worker.store.renewLease(task.id, "fixture-w2", 60000, Date.now()), false);
  const invocation: ToolInvocation = { id: randomUUID(), taskId: task.id, userId, toolName: "save_to_inbox", idempotencyKey: "fixture-write", argsHash: "fixture-hash", runtime: "cloud", status: "succeeded", result: { ok: true }, attempt: 1, startedAt: Date.now() };
  assert.equal((await api.store.recordInvocation(invocation)).deduped, false);
  assert.equal((await worker.store.recordInvocation(invocation)).deduped, true);
  await worker.store.appendEvent({ taskId: task.id, userId, type: "llm.request" });
  const events = await api.store.listEvents(task.id);
  assert.ok(events.length >= 2);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(await api.store.requestCancel(task.id, randomUUID()), false);
  assert.equal(await api.store.requestCancel(task.id, userId), true);
  const pending = await worker.approvals.create({ taskId: task.id, userId, toolName: "write_file", args: {}, idempotencyKey: "fixture-write", risk: "test" });
  await api.approvals.decide(pending.id, userId, "approved");
  assert.equal((await buildContext({}, { pool }).approvals.get(pending.id))?.status, "approved");
});
