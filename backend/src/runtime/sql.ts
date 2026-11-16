// SQL 执行抽象 + pg 适配器。PostgresStore 依赖此接口，便于单元测试注入 fake、生产用 pg.Pool。
import pg from "pg";
import type { ConnectionOptions } from "node:tls";
import { DatabaseProxyStream } from "./db-proxy.ts";
import { StorageUnavailableError } from "../core/errors.ts";

export function isDatabaseConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "57P01", "57P02", "57P03", "53300"].includes(code ?? "")
    || /^(Connection terminated(?: due to connection timeout| unexpectedly)?$|timeout exceeded when trying to connect|timeout expired|Connection closed|Client has encountered a connection error and is not queryable)/i.test(error.message);
}

export interface SqlResult<T = Record<string, unknown>> { rows: T[]; rowCount: number; }
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
}
export interface SqlPool extends SqlClient {
  // Opt-in for reviewed pure repository reads, never arbitrary SQL/tool input.
  readOnly?<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>>;
  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}
export function readQuery<T = Record<string, unknown>>(pool: SqlPool, text: string, params?: unknown[]): Promise<SqlResult<T>> {
  return pool.readOnly ? pool.readOnly<T>(text, params) : pool.query<T>(text, params);
}

// An already-open transaction must keep every repository on its one client.
export function transactionPool(client: SqlClient): SqlPool {
  return { query: (text, params) => client.query(text, params), transaction: (fn) => fn(client), end: async () => {} };
}

export class PgPool implements SqlPool {
  private pool: pg.Pool;
  private clientErrors = new WeakMap<pg.PoolClient, { error?: Error }>();
  constructor(connectionString: string, opts?: { max?: number; ssl?: boolean | ConnectionOptions; proxyUrl?: string; connectionTimeoutMillis?: number }) {
    if (typeof opts?.ssl === "object" && ["sslmode", "sslcert", "sslkey", "sslrootcert"].some(key => new URL(connectionString).searchParams.has(key))) throw new Error("数据库连接串 SSL 参数不能与显式 CA 配置混用，请保留一种配置方式");
    const timeout = opts?.connectionTimeoutMillis ?? (opts?.proxyUrl ? 15000 : 8000);
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error("数据库连接超时必须为 100–30000 毫秒");
    this.pool = new pg.Pool({
      connectionString,
      max: opts?.max ?? 5,
      connectionTimeoutMillis: timeout,
      idleTimeoutMillis: 60000,
      min: 1,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      // Remote connections verify the server. Local test instances may explicitly disable SSL.
      ssl: opts?.ssl === false ? false : typeof opts?.ssl === "object" ? opts.ssl : { rejectUnauthorized: true },
      ...(opts?.proxyUrl ? { stream: () => new DatabaseProxyStream(opts.proxyUrl!, timeout) } : {}),
    });
    // pg removes a broken idle client before emitting this event. Contain it so
    // an idle socket reset cannot terminate API/Worker; never log connection URIs.
    this.pool.on("error", () => { console.warn("[database] idle connection closed"); });
  }
  private async acquire(): Promise<pg.PoolClient> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = await this.pool.connect();
        let state = this.clientErrors.get(client);
        if (!state) {
          state = {};
          this.clientErrors.set(client, state);
          const errors = state;
          // pool's idle listener is removed during checkout. Retain a listener
          // between queries too, as a socket can close without an active query.
          client.on("error", error => { errors.error = error; });
        }
        if (state.error) { client.release(true); throw state.error; }
        return client;
      }
      catch (error) {
        if (!isDatabaseConnectionError(error)) throw error;
        if (attempt >= 1) throw new StorageUnavailableError(error);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>> {
    const client = await this.acquire();
    let discard = false;
    try {
      const r = await client.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    } catch (error) { discard = isDatabaseConnectionError(error); throw error; }
    finally { client.release(discard || Boolean(this.clientErrors.get(client)?.error)); }
  }
  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.acquire();
    let discard = false;
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
      discard = isDatabaseConnectionError(e);
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw e;
    } finally {
      client.release(discard || Boolean(this.clientErrors.get(client)?.error));
    }
  }
  async readOnly<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<T>> {
    try { return await this.query<T>(text, params); }
    catch (error) {
      if (!isDatabaseConnectionError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      try { return await this.query<T>(text, params); }
      catch (retryError) {
        if (isDatabaseConnectionError(retryError)) throw new StorageUnavailableError(retryError);
        throw retryError;
      }
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
