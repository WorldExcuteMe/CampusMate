// PGlite 适配器：把嵌入式 WASM Postgres 包装为 SqlPool，用于真实引擎验证 migration + PostgresStore。
// 仅测试/验证用（devDependency）；生产用 PgPool（pg 直连）。
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { SqlClient, SqlPool, SqlResult } from "./sql.ts";

export class PGlitePool implements SqlPool {
  private db: PGlite;
  constructor(db: PGlite) { this.db = db; }
  static async create(): Promise<PGlitePool> { return new PGlitePool(await PGlite.create({ extensions: { pgcrypto } })); }
  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>> {
    const r = await this.db.query(text, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.affectedRows ?? r.rows.length };
  }
  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return await this.db.transaction(async (tx) => {
      const client: SqlClient = {
        async query<U = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<U>> {
          const r = await tx.query(text, params as unknown[]);
          return { rows: r.rows as U[], rowCount: r.affectedRows ?? r.rows.length };
        },
      };
      return await fn(client);
    });
  }
  async end(): Promise<void> { await this.db.close(); }
  // 直接执行多语句 SQL（迁移脚本）。
  async exec(sql: string): Promise<void> { await this.db.exec(sql); }
}