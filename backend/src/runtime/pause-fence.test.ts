import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStore } from "./postgres-store.ts";
import type { SqlPool } from "./sql.ts";

test("storage pause atomically fences owner, attempt, status and lease expiry", async () => {
  const db = new PGlite();
  const pool: SqlPool = { query: async <T>(sql: string, params?: unknown[]) => {
    const result = await db.query(sql, params); return { rows: result.rows as T[], rowCount: result.rows.length };
  }, transaction: async () => { throw new Error("This atomic update must not need a read/write transaction"); }, end: () => db.close() };
  try {
    await db.exec("create table agent_tasks(id text, user_id text, status text, lease_owner text, attempt int, lease_expires_at timestamptz, error text, updated_at timestamptz)");
    await db.query("insert into agent_tasks values ('task','user','running','new-worker',2,$1,null,now())", [new Date(60000).toISOString()]);
    const store = new PostgresStore(pool);
    const pause = (store as PostgresStore & { pauseTaskIfOwned?: (input: { taskId: string; userId: string; workerId: string; attempt: number; now: number; error: string }) => Promise<boolean> }).pauseTaskIfOwned;
    assert(pause, "A pre-read followed by an unconditional update can overwrite a new owner");
    const fence = { taskId: "task", userId: "user", workerId: "new-worker", attempt: 2, now: 1000, error: "storage interrupted" };
    assert.equal(await pause.call(store, { ...fence, workerId: "old-worker", attempt: 1 }), false);
    assert.equal(await pause.call(store, { ...fence, attempt: 1 }), false);
    assert.equal(await pause.call(store, { ...fence, userId: "other" }), false);
    assert.equal(await pause.call(store, { ...fence, now: 70000 }), false);
    assert.equal((await db.query<{ status: string }>("select status from agent_tasks")).rows[0].status, "running");
    assert.equal(await pause.call(store, fence), true);
    assert.equal(await pause.call(store, fence), false);
    const row = (await db.query<{ status: string; error: string }>("select status,error from agent_tasks")).rows[0];
    assert.deepEqual(row, { status: "paused", error: "storage interrupted" });
  } finally { await pool.end(); }
});
