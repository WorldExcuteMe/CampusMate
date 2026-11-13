// SQL 执行抽象 + pg 适配器。PostgresStore 依赖此接口，便于单元测试注入 fake、生产用 pg.Pool。
import pg from "pg";

export interface SqlResult<T = Record<string, unknown>> { rows: T[]; rowCount: number; }
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
}
export interface SqlPool extends SqlClient {
  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export class PgPool implements SqlPool {
  private pool: pg.Pool;
  constructor(connectionString: string, opts?: { max?: number; ssl?: boolean; connectionTimeoutMillis?: number }) {
    this.pool = new pg.Pool({
      connectionString,
      max: opts?.max ?? 5,
      connectionTimeoutMillis: opts?.connectionTimeoutMillis ?? 8000,
      // Supabase 直连需 SSL；本地测试可关。
      ssl: opts?.ssl === false ? undefined : { rejectUnauthorized: false },
    });
  }
  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>> {
    const r = await this.pool.query(text, params as unknown[]);
    return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
  }
  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const wrapped: SqlClient = {
        async query<U = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<U>> {
          const r = await client.query(text, params as unknown[]);
          return { rows: r.rows as U[], rowCount: r.rowCount ?? 0 };
        },
      };
      const out = await fn(wrapped);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async end(): Promise<void> { await this.pool.end(); }
}

// 连接串：DATABASE_URL 优先；否则用 SUPABASE_DB_PASSWORD + SUPABASE_PROJECT_REF 构造直连串。
// 直连 db.<ref>.supabase.co:5432（session 语义，支持 FOR UPDATE SKIP LOCKED）。
export function connectionStringFromEnv(env: Record<string, string | undefined>): string | null {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const ref = env.SUPABASE_PROJECT_REF;
  const pwd = env.SUPABASE_DB_PASSWORD;
  if (ref && pwd) return `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`;
  return null;
}