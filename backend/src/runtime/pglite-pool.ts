// PGlite 适配器：把嵌入式 WASM Postgres 包装为 SqlPool，用于真实引擎验证 migration + PostgresStore。
// 测试和本地工作区使用。云端生产用 PgPool（pg 直连）。
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { SqlClient, SqlPool, SqlResult } from "./sql.ts";
import { readMigrations } from "./migrations.ts";

export class PGlitePool implements SqlPool {
  private db: PGlite;
  constructor(db: PGlite) { this.db = db; }
  static async create(dataDir?: string): Promise<PGlitePool> { return new PGlitePool(await PGlite.create({ dataDir, extensions: { pgcrypto } })); }
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

  async migrateLocalWorkspace(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.exec(`
        create table if not exists campusmate_local_migrations(path text primary key);
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'anon') then
            create role anon; create role authenticated; create role service_role bypassrls;
          end if;
        end $$;
        create schema if not exists auth;
        create table if not exists auth.users (id uuid primary key, email text);
        create or replace function auth.uid() returns uuid language sql stable as
          $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      `);
      const applied = new Set((await tx.query<{ path: string }>("select path from campusmate_local_migrations")).rows.map((row) => row.path));
      for (const migration of await readMigrations()) {
        if (applied.has(migration.path)) continue;
        await tx.exec(migration.sql.replace(/^\s*(?:begin|commit);\s*$/gim, "").replace(/create extension if not exists pgcrypto;/gi, ""));
        await tx.query("insert into campusmate_local_migrations(path) values ($1)", [migration.path]);
      }
      await tx.exec(`
        create table if not exists campusmate_local_identity (
          singleton boolean primary key default true check (singleton),
          owner uuid not null references auth.users(id),
          full_since bigint,
          vault_key text not null
        );
      `);
    });
  }
}
