// 评测用 durable AppContext：把运行时既有的 PGlite + PostgresStore 装配成可跨进程恢复的库。
// 复用 app-context.buildContext 的注入 pool 能力与 PGlitePool.migrateLocalWorkspace（角色/auth/迁移），
// 仅评测侧使用；不改产品 core/runtime，不改变 memory target 默认行为。
import fs from "node:fs/promises";
import path from "node:path";
import { buildContext, type AppContext } from "../../app-context.ts";
import { PGlitePool } from "../../runtime/pglite-pool.ts";

export interface DurableContext {
  ctx: AppContext;
  pool: PGlitePool;
  dataDir: string;
}

export async function openDurableAppContext(env: Record<string, string | undefined>, dataDir: string): Promise<DurableContext> {
  const resolved = dataDir.trim();
  if (!resolved) throw new Error("durable store 需要非空目录");
  await fs.mkdir(resolved, { recursive: true });
  const pool = await PGlitePool.create(resolved);
  try {
    // 幂等：已存在的库只补未应用的 migration；新建库建角色/auth schema/全部迁移。
    await pool.migrateLocalWorkspace();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const ctx = buildContext(env, { pool });
  return { ctx, pool, dataDir: resolved };
}

// 持久化库缺少内存库的“用户行自足”语义：Postgres 的 session/task 外键指向 auth.users，
// 评测 owner 是确定性 UUID，首次使用时补建一行（幂等）。
export async function ensureDurableUser(pool: { query: (text: string, params?: unknown[]) => Promise<unknown> }, userId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error(`durable store 需要合法 UUID 用户：${userId}`);
  await pool.query("insert into auth.users(id) values ($1) on conflict (id) do nothing", [userId]);
}

// CLI/报告用：durable store 的最近一次会话交接信息。
export interface DurableHandoff {
  schemaVersion: 1;
  storeDir: string;
  caseId: string;
  sessionId: string;
  userId: string;
  updatedAt: string;
}

export function durableHandoffPath(dir: string): string {
  return path.join(dir, "durable-session.json");
}
