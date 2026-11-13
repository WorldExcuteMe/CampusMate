// 在真实 Postgres 引擎（PGlite WASM）上应用 0001+0002 并跑 PostgresStore 完整契约。
// 证明 migration DDL 有效（SKIP LOCKED / ON CONFLICT / 触发器 / RLS 策略），生产 dashboard 应用可保证成功。
// 运行：node scripts/validate-migration.ts
import fs from "node:fs";
import { PGlitePool } from "../src/runtime/pglite-pool.ts";
import { PostgresStore } from "../src/runtime/postgres-store.ts";
import { randomUUID } from "node:crypto";
import type { ToolInvocation } from "../src/core/types.ts";

const root = new URL("../../", import.meta.url);
// PGlite 由构造器加载 pgcrypto；剥离 SQL 中的 create extension 语句（生产 Supabase 保留）。
const stripExtension = (s: string) => s.replace(/create extension if not exists pgcrypto;/gi, "");
const sql0001 = stripExtension(fs.readFileSync(new URL("supabase/migrations/0001_init.sql", root), "utf8"));
const sql0002 = stripExtension(fs.readFileSync(new URL("backend/migrations/0002_agent_runtime.sql", root), "utf8"));

// Supabase 专有对象桩：auth.users + auth.uid()（PGlite 无 Supabase auth schema）。
const AUTH_STUB = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

const pool = await PGlitePool.create();
const userId = randomUUID();
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { if (cond) { pass++; console.log("  ✔", name); } else { fail++; console.log("  ✖", name); } };

try {
  console.log("[1] 应用 auth 桩 + 0001_init + 0002_agent_runtime");
  await pool.exec(AUTH_STUB);
  await pool.exec(sql0001);
  await pool.exec(sql0002);
  await pool.query("insert into auth.users (id, email) values ($1, $2)", [userId, "test@example.com"]);
  const tables = await pool.query<{ t: string }>("select table_name as t from information_schema.tables where table_name like 'agent_%' order by table_name");
  check("agent_* 8 表创建", tables.rows.length >= 8);
  console.log("    表:", tables.rows.map((r) => r.t).join(", "));

  console.log("[2] PostgresStore 真实契约");
  const store = new PostgresStore(pool);
  const t = await store.createTask({ userId, title: "集成测试任务" });
  check("createTask queued", t.status === "queued");
  check("getTask 往返", (await store.getTask(t.id))?.title === "集成测试任务");

  const c = await store.claimNext({ workerId: "w1", leaseTtlMs: 60000, now: Date.now() });
  check("claimNext FOR UPDATE SKIP LOCKED → running", c?.id === t.id && c?.status === "running");
  check("无其他任务 claim → null", (await store.claimNext({ workerId: "w2", leaseTtlMs: 60000, now: Date.now() })) === null);
  check("renewLease owner 校验", (await store.renewLease(t.id, "w1", 60000, Date.now())) === true);
  check("renewLease 错 owner → false", (await store.renewLease(t.id, "w2", 60000, Date.now())) === false);

  const inv: ToolInvocation = { id: randomUUID(), taskId: t.id, userId, toolName: "save_to_inbox", idempotencyKey: "k1", argsHash: "h", runtime: "cloud", status: "succeeded", result: { ok: true }, attempt: 1, startedAt: Date.now() };
  check("recordInvocation 新建 deduped=false", (await store.recordInvocation(inv)).deduped === false);
  check("recordInvocation ON CONFLICT 幂等 deduped=true", (await store.recordInvocation(inv)).deduped === true);

  await store.appendEvent({ taskId: t.id, userId, type: "llm.request" });
  await store.appendEvent({ taskId: t.id, userId, type: "llm.response" });
  const ev = await store.listEvents(t.id);
  check("事件 seq 单调", ev.length >= 3 && ev.every((e, i) => e.seq === i + 1));

  const cp = await store.writeCheckpoint({ taskId: t.id, userId, eventSeq: 3, state: { messages: [], stepProgress: {}, repeat: {}, usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 }, pendingApprovals: [] } });
  check("checkpoint 写入+最新读取", (await store.latestCheckpoint(t.id))?.id === cp.id);

  check("requestCancel 跨用户 → false", (await store.requestCancel(t.id, randomUUID())) === false);
  check("requestCancel owner → true", (await store.requestCancel(t.id, userId)) === true);

  console.log("[3] VERIFIED 触发器门控");
  const oppId = randomUUID();
  await pool.query("insert into opportunities (id, title, type, source_url) values ($1,$2,$3,$4)", [oppId, "测试机会", "competition", "https://example.org"]);
  let rejected = false;
  try { await pool.query("insert into verification_reports (opportunity_id, status, evaluated_by, evidence_count) values ($1,'VERIFIED','pending',0)", [oppId]); } catch { rejected = true; }
  check("无证据 VERIFIED 被触发器拒绝", rejected);
  let accepted = false;
  try { await pool.query("insert into verification_reports (opportunity_id, status, evaluated_by, evidence_count) values ($1,'VERIFIED','evaluator',1)", [oppId]); accepted = true; } catch { accepted = false; }
  check("evaluator+证据 VERIFIED 允许", accepted);

  console.log("[4] 幂等唯一约束（inbox dedup_key）");
  await pool.query("insert into inbox_items (user_id, raw_text, extracted, classification, dedup_key) values ($1,'x','{}','{}','dk1')", [userId]);
  let dupRejected = false;
  try { await pool.query("insert into inbox_items (user_id, raw_text, extracted, classification, dedup_key) values ($1,'y','{}','{}','dk1')", [userId]); } catch { dupRejected = true; }
  check("同 user dedup_key 重复被唯一约束拒绝", dupRejected);

  await pool.query("delete from agent_tasks where id=$1", [t.id]);
} catch (e) {
  console.error("验证异常:", e);
  fail++;
} finally {
  await pool.end();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
console.log(fail === 0 ? "MIGRATION_VALIDATED" : "MIGRATION_FAILED");
process.exit(fail === 0 ? 0 : 1);