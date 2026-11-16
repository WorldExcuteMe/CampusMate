import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import pg from "pg";
import { PgPool, readQuery, transactionPool } from "./sql.ts";

const transient = () => new Error("Connection terminated due to connection timeout");
function fakePool(t: import("node:test").TestContext, failures: Error[], execute?: (sql: string) => void) {
  const stats = { connects: 0, queries: [] as string[], releases: [] as unknown[], options: {} as Record<string, unknown> };
  let instance: EventEmitter, borrowed: EventEmitter;
  class FakePool extends EventEmitter {
    constructor(options: Record<string, unknown>) { super(); stats.options = options; instance = this; }
    async connect() {
      stats.connects++;
      const error = failures.shift(); if (error) throw error;
      return Object.assign(borrowed = new EventEmitter(), {
        query: async (sql: string) => { stats.queries.push(sql); execute?.(sql); return { rows: [{ value: 1 }], rowCount: 1 }; },
        release: (error?: unknown) => { stats.releases.push(error); },
      });
    }
    // Baseline pool.query has no acquisition recovery, like the real pg.Pool.
    async query(sql: string) { const client = await this.connect(); try { return await client.query(sql); } finally { client.release(); } }
    async end() {}
  }
  const original = pg.Pool;
  pg.Pool = FakePool as unknown as typeof pg.Pool;
  t.after(() => { pg.Pool = original; });
  return { stats, pool: new PgPool("postgresql://localhost/test", { ssl: false, connectionTimeoutMillis: 100 }), idleError: () => instance!.emit("error", transient()), clientError: () => borrowed!.emit("error", transient()) };
}

test("query retries acquisition only, then executes SQL exactly once", async t => {
  const { pool, stats } = fakePool(t, [transient()]);
  assert.equal((await pool.query("SELECT 1")).rowCount, 1);
  assert.equal(stats.connects, 2); assert.deepEqual(stats.queries, ["SELECT 1"]); assert.equal(stats.releases.length, 1);
});
test("transaction retries acquisition, never replays callback", async t => {
  const { pool, stats } = fakePool(t, [transient()]); let calls = 0;
  await pool.transaction(async client => { calls++; await client.query("UPDATE fixture"); });
  assert.equal(calls, 1); assert.deepEqual(stats.queries, ["BEGIN", "UPDATE fixture", "COMMIT"]);
});
test("authentication errors do not retry", async t => {
  const error = Object.assign(new Error("authentication failed"), { code: "28P01" });
  const { pool, stats } = fakePool(t, [error]);
  await assert.rejects(pool.query("SELECT 1"), e => e === error); assert.equal(stats.connects, 1);
});
test("exhausted transient acquisitions report storage outage without executing SQL", async t => {
  const { pool, stats } = fakePool(t, [transient(), transient(), transient()]);
  await assert.rejects(pool.query("SELECT 1"), { name: "StorageUnavailableError" });
  assert.equal(stats.connects, 2); assert.deepEqual(stats.queries, []);
});
test("SQL transport failure is never retried and its client is discarded", async t => {
  const failure = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
  const { pool, stats } = fakePool(t, [], () => { throw failure; });
  await assert.rejects(pool.query("INSERT fixture"), e => e === failure);
  assert.equal(stats.connects, 1); assert.deepEqual(stats.queries, ["INSERT fixture"]); assert(stats.releases[0]);
});
test("failed rollback preserves original COMMIT error and discards client", async t => {
  const failure = Object.assign(new Error("COMMIT lost connection"), { code: "ECONNRESET" });
  const { pool, stats } = fakePool(t, [], sql => { if (sql === "COMMIT") throw failure; if (sql === "ROLLBACK") throw new Error("rollback also failed"); });
  let calls = 0;
  await assert.rejects(pool.transaction(async () => { calls++; }), e => e === failure);
  assert.equal(calls, 1); assert.equal(stats.connects, 1); assert(stats.releases[0]);
});
test("pool idle error is contained; connections keep finite reuse and keepalive", async t => {
  const { stats, idleError } = fakePool(t, []);
  assert.doesNotThrow(idleError); assert.equal(stats.options.keepAlive, true); assert.equal(stats.options.idleTimeoutMillis, 60000);
});
test("a checked-out client error cannot crash the process and its socket is discarded", async t => {
  const fixture = fakePool(t, [], () => { fixture.clientError(); });
  await assert.doesNotReject(fixture.pool.query("SELECT 1"));
  assert.equal(fixture.stats.queries.length, 1); assert(fixture.stats.releases[0]);
});
test("explicit pure reads may retry one interrupted statement while normal SQL never replays", async t => {
  let calls = 0; const failure = Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
  const { pool, stats } = fakePool(t, [], () => { if (++calls === 1) throw failure; });
  const optional = pool as PgPool & { readOnly?: PgPool["query"] };
  await (optional.readOnly?.("SELECT 1") ?? pool.query("SELECT 1"));
  assert.equal(stats.connects, 2); assert.deepEqual(stats.queries, ["SELECT 1", "SELECT 1"]);
});
test("exhausted pure reads stop after two statements", async t => {
  const failure = new Error("Connection terminated unexpectedly");
  const { pool, stats } = fakePool(t, [], () => { throw failure; });
  await assert.rejects(readQuery(pool, "SELECT 1"), { name: "StorageUnavailableError" });
  assert.equal(stats.connects, 2); assert.equal(stats.queries.length, 2);
});
test("pure read SQL errors are not retried", async t => {
  const failure = Object.assign(new Error("invalid SQL"), { code: "42601" });
  const { pool, stats } = fakePool(t, [], () => { throw failure; });
  await assert.rejects(readQuery(pool, "SELECT 1"), e => e === failure); assert.equal(stats.connects, 1); assert.equal(stats.queries.length, 1);
});
test("pure read certificate errors are not retried", async t => {
  const failure = Object.assign(new Error("certificate expired"), { code: "CERT_HAS_EXPIRED" });
  const { pool, stats } = fakePool(t, [failure]);
  await assert.rejects(readQuery(pool, "SELECT 1"), e => e === failure); assert.equal(stats.connects, 1); assert.equal(stats.queries.length, 0);
});
test("transaction-bound reads do not replay after a connection failure", async () => {
  const failure = new Error("Connection terminated unexpectedly"); let calls = 0;
  const pool = transactionPool({ query: async () => { calls++; throw failure; } });
  await assert.rejects(readQuery(pool, "SELECT 1"), e => e === failure); assert.equal(calls, 1);
});
