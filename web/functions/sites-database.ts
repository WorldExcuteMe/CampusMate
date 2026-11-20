import type { SitesRun, SitesRunStore, RunState } from "./sites-app.ts";

// 对应平台注入的 SDK 2：只用官方示例已有的查询、条件更新和 insertIfAbsent。
// 同站点一行保存 P0 小规模运行与计数，配额检查和预约位于同一次版本 CAS 中。
// 协调器租约独占一行：version 围栏同一行的接管与记录写入，token 标识当前持有者。
interface Result { data: unknown; error?: unknown }
export interface SitesQuery extends PromiseLike<Result> {
  select(columns: string): SitesQuery;
  eq(column: string, value: unknown): SitesQuery;
  limit(value: number): SitesQuery;
  update(values: Record<string, unknown>): SitesQuery;
  insertIfAbsent(values: Record<string, unknown>, options: { onConflict: string }): SitesQuery;
}
export interface SitesDatabase { from(table: string): SitesQuery }
interface Meter { start: number; count: number; owners: { id: string; count: number }[] }
interface Ledger { id: string; version: number; runs: SitesRun[]; meter: Meter }
export interface SitesLimits { totalRuns: number; userRuns: number; requestsPerMinute: number; userRequestsPerMinute: number }
// 官方 cloud-agents.mjs 的 coordinator 契约：read/write/assertHeld 必须由持久化状态支撑。
export interface SitesLockLease {
  read(): Promise<Record<string, unknown> | null>;
  write(record: Record<string, unknown>): Promise<void>;
  assertHeld(): Promise<void>;
}
export interface SitesCoordinator {
  withLock<T>(key: string, callback: (lease: SitesLockLease) => Promise<T>): Promise<T>;
}
export interface SitesLockOptions { waitMs?: number; retryMs?: number }
interface LockRow { lock_key: string; version: number; token: string; expires_at: number; record: Record<string, unknown> | null }

const defaultLimits: SitesLimits = { totalRuns: 20, userRuns: 4, requestsPerMinute: 120, userRequestsPerMinute: 30 };
const defaultLock = { waitMs: 5_000, retryMs: 25 };
const leaseMs = 60_000;
const states: RunState[] = ["creating", "ready", "sending", "submitted", "uncertain", "cancelled"];
const runtimeTable = "campusmate_runtime";
const locksTable = "campusmate_locks";
const columns = "id,version,runs,meter";
const lockColumns = "lock_key,version,token,expires_at,record";
const ledgerId = "campusmate-p0-v1";
const unavailable = () => new Error("sites_database_unavailable");

function resultRows(result: Result): Record<string, unknown>[] {
  if (result.error || !Array.isArray(result.data) || result.data.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw unavailable();
  return result.data;
}
function parse(row: Record<string, unknown>): Ledger {
  if (row.id !== ledgerId || !Number.isInteger(row.version) || Number(row.version) < 1 || Number(row.version) >= 2147483647 || !Array.isArray(row.runs)) throw unavailable();
  if (row.runs.length > 100 || row.runs.some(run => !run || typeof run.owner !== "string" || typeof run.id !== "string" ||
      typeof run.noticeHash !== "string" || !/^[a-f0-9]{64}$/.test(run.noticeHash) || !states.includes(run.state) ||
      (run.sessionId !== undefined && !/^sess_[A-Za-z0-9_-]{1,160}$/.test(run.sessionId)))) throw unavailable();
  const meter = row.meter as Meter;
  if (!meter || !Number.isSafeInteger(meter.start) || !Number.isSafeInteger(meter.count) || meter.count < 0 ||
      !Array.isArray(meter.owners) || meter.owners.length > 200 || meter.owners.some(item => typeof item.id !== "string" || !Number.isSafeInteger(item.count) || item.count < 0)) throw unavailable();
  return structuredClone(row) as unknown as Ledger;
}
function parseLock(row: Record<string, unknown>, key: string): LockRow {
  // bigint 列可能以十进制字符串返回；这里统一还原为数值后再判定租约。
  const expires = typeof row.expires_at === "string" && /^[0-9]{1,15}$/.test(row.expires_at) ? Number(row.expires_at) : row.expires_at;
  if (row.lock_key !== key || !Number.isInteger(row.version) || Number(row.version) < 1 || Number(row.version) >= 2147483647 ||
      typeof row.token !== "string" || !row.token || row.token.length > 200 ||
      !Number.isSafeInteger(expires) || Number(expires) < 0 ||
      !(row.record === null || row.record === undefined || (typeof row.record === "object" && !Array.isArray(row.record)))) throw unavailable();
  return {
    lock_key: key,
    version: Number(row.version),
    token: row.token,
    expires_at: Number(expires),
    record: row.record === null || row.record === undefined ? null : structuredClone(row.record as Record<string, unknown>),
  };
}
function cloneRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sites_invalid_lock_record");
  let text: string;
  try { text = JSON.stringify(value); } catch { throw new Error("sites_invalid_lock_record"); }
  if (text.length > 64 * 1024) throw new Error("sites_invalid_lock_record");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("sites_invalid_lock_record");
  return parsed as Record<string, unknown>;
}

export function createSitesDatabaseStore(db: SitesDatabase, options: { limits?: Partial<SitesLimits>; now?: () => number; lock?: SitesLockOptions } = {}) {
  const limits = { ...defaultLimits, ...options.limits };
  if (Object.values(limits).some(value => !Number.isInteger(value) || value < 1) || limits.totalRuns > 100 || limits.requestsPerMinute > 200) {
    throw new Error("sites_invalid_limits");
  }
  const lock = { waitMs: options.lock?.waitMs ?? defaultLock.waitMs, retryMs: options.lock?.retryMs ?? defaultLock.retryMs };
  if (!Number.isInteger(lock.waitMs) || lock.waitMs < 0 || lock.waitMs > 30_000 ||
      !Number.isInteger(lock.retryMs) || lock.retryMs < 0 || lock.retryMs > 1_000) {
    throw new Error("sites_invalid_lock_options");
  }
  const now = options.now ?? Date.now;
  async function read(): Promise<Ledger> {
    const rows = resultRows(await db.from(runtimeTable).select(columns).eq("id", ledgerId).limit(1));
    if (rows.length > 1) throw unavailable();
    return rows.length ? parse(rows[0]) : { id: ledgerId, version: 0, runs: [], meter: { start: now(), count: 0, owners: [] } };
  }
  async function change<T>(mutate: (ledger: Ledger) => { value: T; write: boolean }): Promise<T> {
    // 只有确认零行受影响的 CAS 冲突才重读；网络或 SDK 错误不重试写请求。
    for (let attempt = 0; attempt < 4; attempt++) {
      const ledger = await read();
      const expectedVersion = ledger.version;
      const { value, write } = mutate(ledger);
      if (!write) return value;
      const updated = { ...ledger, version: expectedVersion + 1 };
      const query = expectedVersion === 0
        ? db.from(runtimeTable).insertIfAbsent(updated, { onConflict: "id" })
        : db.from(runtimeTable).update(updated).eq("id", ledgerId).eq("version", expectedVersion);
      const affected = resultRows(await query.select("id,version"));
      if (affected.length === 1 && affected[0].id === ledgerId && affected[0].version === expectedVersion + 1) return value;
      if (affected.length !== 0) throw unavailable();
    }
    throw new Error("sites_database_busy");
  }
  const runs: SitesRunStore = {
    async reserve(run) {
      return change<Awaited<ReturnType<SitesRunStore["reserve"]>>>(ledger => {
        const existing = ledger.runs.find(item => item.owner === run.owner && item.id === run.id);
        if (existing) return { value: existing.noticeHash === run.noticeHash ? { kind: "exists", run: existing } : { kind: "conflict" }, write: false };
        if (run.state !== "creating" || run.sessionId) throw new Error("sites_invalid_reservation");
        if (ledger.runs.length >= limits.totalRuns || ledger.runs.filter(item => item.owner === run.owner).length >= limits.userRuns) {
          return { value: { kind: "limited" }, write: false };
        }
        ledger.runs.push(structuredClone(run));
        return { value: { kind: "created", run }, write: true };
      });
    },
    async get(owner, id) {
      const ledger = await read();
      return ledger.runs.find(run => run.owner === owner && run.id === id) ?? null;
    },
    async transition(owner, id, from, patch) {
      return change(ledger => {
        const run = ledger.runs.find(item => item.owner === owner && item.id === id);
        if (!run || run.state !== from) return { value: false, write: false };
        Object.assign(run, patch);
        return { value: true, write: true };
      });
    },
  };
  async function allowRequest(owner: string, _action: "read" | "write" | "stream") {
    return change(ledger => {
      if (now() - ledger.meter.start >= 60_000) ledger.meter = { start: now(), count: 0, owners: [] };
      const user = ledger.meter.owners.find(item => item.id === owner);
      if (ledger.meter.count >= limits.requestsPerMinute || (user?.count ?? 0) >= limits.userRequestsPerMinute) return { value: false, write: false };
      ledger.meter.count++;
      if (user) user.count++; else ledger.meter.owners.push({ id: owner, count: 1 });
      return { value: true, write: true };
    });
  }

  async function readLock(key: string): Promise<LockRow | null> {
    const rows = resultRows(await db.from(locksTable).select(lockColumns).eq("lock_key", key).limit(1));
    if (rows.length > 1) throw unavailable();
    return rows.length ? parseLock(rows[0], key) : null;
  }
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  // 加锁只写租约字段，绝不覆盖 record，避免抹掉未知的 creating/unknown 创建记录。
  async function acquire(key: string): Promise<string> {
    const deadline = Date.now() + lock.waitMs;
    for (;;) {
      const token = crypto.randomUUID();
      const row = await readLock(key);
      if (!row) {
        const values = { lock_key: key, version: 1, token, expires_at: now() + leaseMs, record: null };
        const inserted = resultRows(await db.from(locksTable).insertIfAbsent(values, { onConflict: "lock_key" }).select(lockColumns));
        if (inserted.length > 1) throw unavailable();
        if (inserted.length === 1 && inserted[0].lock_key === key && inserted[0].token === token && inserted[0].version === 1) return token;
      } else if (row.expires_at <= now()) {
        // 同一行 version CAS 决定谁能接管过期租约；落败方零行受影响后重试。
        const next = { ...row, version: row.version + 1, token, expires_at: now() + leaseMs };
        const affected = resultRows(await db.from(locksTable).update(next)
          .eq("lock_key", key).eq("version", row.version).eq("token", row.token).select(lockColumns));
        if (affected.length > 1) throw unavailable();
        if (affected.length === 1 && affected[0].lock_key === key && affected[0].token === token && affected[0].version === row.version + 1) return token;
      }
      if (Date.now() >= deadline) throw new Error("sites_database_busy");
      await sleep(lock.retryMs);
    }
  }
  function leaseFor(key: string, token: string): SitesLockLease {
    // 过期或 token 被替换都视为丢失租约；旧持有者因此无法 read/write/assertHeld。
    const held = (row: LockRow | null): row is LockRow => !!row && row.token === token && row.expires_at > now();
    return {
      async read() {
        const row = await readLock(key);
        if (!held(row)) throw new Error("sites_lock_lost");
        return row.record === null ? null : structuredClone(row.record);
      },
      async write(record) {
        const value = cloneRecord(record);
        const row = await readLock(key);
        if (!held(row)) throw new Error("sites_lock_lost");
        const next = { ...row, version: row.version + 1, record: value };
        const affected = resultRows(await db.from(locksTable).update(next)
          .eq("lock_key", key).eq("token", token).eq("version", row.version).select(lockColumns));
        if (affected.length !== 1 || affected[0].lock_key !== key || affected[0].token !== token || affected[0].version !== row.version + 1) {
          throw new Error("sites_lock_lost");
        }
      },
      async assertHeld() {
        if (!held(await readLock(key))) throw new Error("sites_lock_lost");
      },
    };
  }
  async function release(key: string, token: string) {
    try {
      const row = await readLock(key);
      if (!row || row.token !== token) return;
      const next = { ...row, version: row.version + 1, expires_at: 0 };
      resultRows(await db.from(locksTable).update(next).eq("lock_key", key).eq("token", token).eq("version", row.version).select("lock_key,version"));
    } catch { /* 释放失败不能覆盖回调结果；租约到期后由新持有者接管。 */ }
  }
  async function withLock<T>(key: string, callback: (lease: SitesLockLease) => Promise<T>): Promise<T> {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(key)) throw new Error("sites_invalid_lock_key");
    if (typeof callback !== "function") throw new Error("sites_invalid_lock_callback");
    const token = await acquire(key);
    try {
      return await callback(leaseFor(key, token));
    } finally {
      await release(key, token);
    }
  }
  // Read-only view of a durable binding record. It never acquires a lease, so
  // run routes can reuse a persisted binding without writing or initializing.
  async function readBinding(key: string): Promise<Record<string, unknown> | null> {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(key)) throw new Error("sites_invalid_lock_key");
    const rows = resultRows(await db.from(locksTable).select(lockColumns).eq("lock_key", key).limit(1));
    if (rows.length > 1) throw unavailable();
    if (!rows.length) return null;
    return parseLock(rows[0], key).record;
  }
  const coordinator: SitesCoordinator = { withLock };
  return { runs, allowRequest, limits: { ...limits }, coordinator, binding: { read: readBinding } };
}
