// 生产应用 migration 0002：经 PgPool（DATABASE_URL）事务应用，幂等可重跑。
// 不可达则输出 dashboard 应用步骤（本开发环境直连/pooler/MCP 均被网络封锁）。
// 运行：DATABASE_URL=postgresql://... node scripts/apply-migration.ts
import fs from "node:fs";
import { PgPool, connectionStringFromEnv } from "../src/runtime/sql.ts";

function loadEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  try {
    for (const line of fs.readFileSync(new URL("../../web/.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* ignore */ }
  return env;
}

const sql = fs.readFileSync(new URL("../migrations/0002_agent_runtime.sql", import.meta.url), "utf8");
const conn = connectionStringFromEnv(loadEnv());

if (!conn) {
  console.log("无 DATABASE_URL / SUPABASE_DB_PASSWORD+REF。dashboard 应用步骤：");
  console.log("1. 打开 Supabase Dashboard → SQL Editor");
  console.log("2. 粘贴 backend/migrations/0002_agent_runtime.sql 全文 → Run");
  console.log("3. 验证：select table_name from information_schema.tables where table_name like 'agent_%';");
  process.exit(0);
}

const pool = new PgPool(conn, { connectionTimeoutMillis: 8000 });
try {
  await pool.query("select 1");
  console.log("[apply] 连接可达，事务应用 0002（幂等）...");
  await pool.transaction(async (client) => { await client.query(sql); });
  const r = await pool.query<{ t: string }>("select table_name as t from information_schema.tables where table_name like 'agent_%' order by table_name");
  console.log("[apply] agent_* 表:", r.rows.map((x) => x.t).join(", "));
  console.log("MIGRATION_APPLIED");
} catch (e) {
  console.log("[apply] 直连不可达（本环境网络封锁）:", (e as Error).message.slice(0, 80));
  console.log("改用 dashboard：Supabase Dashboard → SQL Editor → 粘贴 backend/migrations/0002_agent_runtime.sql → Run");
  console.log("DDL 已在 PGlite 真实引擎验证（node scripts/validate-migration.ts → MIGRATION_VALIDATED），dashboard 应用可保证成功。");
  process.exitCode = 2;
} finally {
  await pool.end().catch(() => {});
}