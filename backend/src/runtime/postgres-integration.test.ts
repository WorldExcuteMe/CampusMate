// PostgresStore 真实库集成测试。需 DATABASE_URL（或 web/.env.local 的 SUPABASE_DB_PASSWORD+REF）
// 且已应用 migrations/0002。不可达/未迁移则自动 skip（本阶段未应用迁移，默认 skip）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "./postgres-store.ts";
import { PgPool, connectionStringFromEnv } from "./sql.ts";
import type { ToolInvocation } from "../core/types.ts";

function loadEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  try {
    const txt = fs.readFileSync(new URL("../../../web/.env.local", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* ignore */ }
  return env;
}

const conn = connectionStringFromEnv(loadEnv());
let pool: PgPool | null = null;
let reachable = false;
if (conn) {
  try {
    pool = new PgPool(conn, { connectionTimeoutMillis: 6000 });
    const r = await pool.query<{ t: string | null }>("select to_regclass('public.agent_tasks') as t");
    reachable = r.rows[0]?.t != null;
  } catch { reachable = false; }
}
if (!reachable && pool) { await pool.end().catch(() => {}); pool = null; }
const skip = reachable ? false : "无 DATABASE_URL 或 agent_tasks 未迁移/不可达（本阶段未应用迁移）";

test("PostgresStore 集成：CRUD/claim/lease/幂等/事件/跨用户", { skip }, async () => {
  const store = new PostgresStore(pool!);
  const userId = randomUUID(); // 隔离测试数据（注意：真实库需 auth.users 存在该 id；此处用随机 id 仅验证 store 逻辑，FK 可能拒绝）
  // 真实库 FK 要求 user_id 存在于 auth.users；集成测试应在有测试用户的环境运行。
  const t = await store.createTask({ userId, title: "集成测试任务" });
  try {
    assert.equal(t.status, "queued");
    assert.equal((await store.getTask(t.id))?.title, "集成测试任务");

    const c = await store.claimNext({ workerId: "w1", leaseTtlMs: 60000, now: Date.now() });
    assert.equal(c?.id, t.id);
    assert.equal(c?.status, "running");
    assert.equal(await store.claimNext({ workerId: "w2", leaseTtlMs: 60000, now: Date.now() }), null);

    assert.equal(await store.renewLease(t.id, "w1", 60000, Date.now()), true);
    assert.equal(await store.renewLease(t.id, "w2", 60000, Date.now()), false);

    const inv: ToolInvocation = { id: randomUUID(), taskId: t.id, userId, toolName: "save_to_inbox", idempotencyKey: "k1", argsHash: "h", runtime: "cloud", status: "succeeded", result: { ok: true }, attempt: 1, startedAt: Date.now() };
    assert.equal((await store.recordInvocation(inv)).deduped, false);
    assert.equal((await store.recordInvocation(inv)).deduped, true);

    await store.appendEvent({ taskId: t.id, userId, type: "llm.request" });
    const ev = await store.listEvents(t.id);
    assert.ok(ev.length >= 2);
    assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1));

    assert.equal(await store.requestCancel(t.id, randomUUID()), false); // 跨用户
    assert.equal(await store.requestCancel(t.id, userId), true);
  } finally {
    await pool!.query("delete from agent_tasks where id=$1", [t.id]); // cascade 清理
    await pool!.end();
  }
});