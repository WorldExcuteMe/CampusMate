import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresPersonalContextStore } from "./postgres-personal-context-store.ts";
import { PostgresOpportunityStore } from "./postgres-opportunity-store.ts";
import type { SqlClient, SqlPool, SqlResult } from "./sql.ts";
import { OWNER } from "./storage-test-fixture.ts";

// Real pg DATE parser output, rather than PGlite's string, exposes the deployment boundary.
const dateValue = pg.types.getTypeParser(1082, "text")("2026-09-01") as Date;
const common = { id: "33333333-3333-4333-8333-333333333333", user_id: OWNER, term_id: "44444444-4444-4444-8444-444444444444" };
class DatePool implements SqlPool {
  private row: Record<string, unknown>;
  constructor(row: Record<string, unknown>) { this.row = row; }
  async query<T = Record<string, unknown>>(): Promise<SqlResult<T>> { return { rows: [this.row as T], rowCount: 1 }; }
  async transaction<T>(fn: (client: SqlClient) => Promise<T>) { return fn(this); }
  async end() {}
}

test("真实 pg DATE：学期起止日期按日历年月日映射", async () => {
  assert.ok(dateValue instanceof Date);
  const pool = new DatePool({ ...common, institution_id: "example", name: "秋季", start_date: dateValue, end_date: dateValue, total_weeks: 20, timezone: "Asia/Shanghai" });
  assert.equal((await new PostgresPersonalContextStore(pool).listTerms(OWNER))[0]?.startDate, "2026-09-01");
});
test("真实 pg DATE：调课日期保持日历日期", async () => {
  const pool = new DatePool({ ...common, kind: "cancel", date: dateValue, classroom: "", note: "" });
  assert.equal((await new PostgresPersonalContextStore(pool).listExceptions(OWNER, common.term_id))[0]?.date, "2026-09-01");
});
test("真实 pg DATE：机会截止日期不是Date.toString的前十字符", async () => {
  const pool = new DatePool({ ...common, title: "校园竞赛", type: "competition", organizer: "", description: "", conditions: [], deadline: dateValue, source_url: "https://school.example", source_type: "official", collected_at: new Date(0), saved_status: "active", is_demo: false });
  assert.equal((await new PostgresOpportunityStore(pool).get(OWNER, common.id))?.deadline, "2026-09-01");
});
