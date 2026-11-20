// @vitest-environment node
// 使用官方 SDK 2 查询形状的受控响应；真实 Provider 及 Gateway 隔离仍需部署验证。
import { expect, it } from "vitest";
import { createSitesDatabaseStore, type SitesDatabase, type SitesLockLease, type SitesQuery } from "../../../functions/sites-database";
import type { SitesRun } from "../../../functions/sites-app";

// 两张表各自独立存储；update 先按 WHERE 匹配旧行，再用提交的整行替换，模拟条件更新。
function fixture() {
  const tables: Record<string, Record<string, unknown>[]> = { campusmate_runtime: [], campusmate_locks: [] };
  let failWrite = false, conflictWrites = 0;
  const writes: { table: string; method: string; filters: [string, unknown][]; data: Record<string, unknown> }[] = [];
  const db: SitesDatabase = { from(table) {
    const rows = tables[table];
    if (!rows) throw new Error(`unexpected_table:${table}`);
    let method = "read", data: Record<string, unknown> = {}, columns = "", conflict = "";
    const filters: [string, unknown][] = [];
    const project = (row: Record<string, unknown>) => Object.fromEntries(
      columns.split(",").filter(Boolean).map(key => [key, structuredClone(row[key])]),
    );
    const execute = async () => {
      if (method !== "read") {
        writes.push({ table, method, filters: [...filters], data: structuredClone(data) });
        if (failWrite) throw new Error("private-provider-error");
        if (conflictWrites > 0) { conflictWrites--; return { data: [], error: null }; }
      }
      if (method === "insert") {
        if (rows.some(row => row[conflict] === data[conflict])) return { data: [], error: null };
        rows.push(structuredClone(data));
        return { data: [project(data)], error: null };
      }
      if (method === "update") {
        const target = rows.find(row => filters.every(([key, value]) => row[key] === value));
        if (!target) return { data: [], error: null };
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, structuredClone(data));
        return { data: [project(target)], error: null };
      }
      return { data: rows.filter(row => filters.every(([key, value]) => row[key] === value)).map(project), error: null };
    };
    const query: SitesQuery = {
      select(value) { columns = value; return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      limit(value) { expect(value).toBe(1); return query; },
      update(value) { method = "update"; data = value; return query; },
      insertIfAbsent(value, options) { conflict = options.onConflict; method = "insert"; data = value; return query; },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    return query;
  } };
  return {
    db,
    writes,
    row: () => tables.campusmate_runtime[0] ?? null,
    lockRow: (key: string) => tables.campusmate_locks.find(row => row.lock_key === key) ?? null,
    seedLock: (row: Record<string, unknown>) => { tables.campusmate_locks.push(structuredClone(row)); },
    fail: () => { failWrite = true; },
    conflict: (count: number) => { conflictWrites = count; },
  };
}
const run = (id = "request_1234", owner = "owner-a"): SitesRun => ({ id, owner, state: "creating", noticeHash: "a".repeat(64) });

it("读取未初始化账本不创建业务记录；状态可由另一 store 实例读取", async () => {
  const f = fixture(), first = createSitesDatabaseStore(f.db), second = createSitesDatabaseStore(f.db);
  expect(await first.runs.get("owner-a", "request_1234")).toBeNull(); expect(f.writes).toHaveLength(0);
  expect((await first.runs.reserve(run())).kind).toBe("created");
  expect(await second.runs.get("owner-a", "request_1234")).toEqual(run());
  expect(await second.runs.get("owner-b", "request_1234")).toBeNull();
});
it("同用户同键幂等，异正文不覆盖；不同用户可使用相同键", async () => {
  const f = fixture(), store = createSitesDatabaseStore(f.db);
  await store.runs.reserve(run());
  expect((await store.runs.reserve(run())).kind).toBe("exists");
  expect((await store.runs.reserve({ ...run(), noticeHash: "b".repeat(64) })).kind).toBe("conflict");
  expect((await store.runs.reserve(run("request_1234", "owner-b"))).kind).toBe("created");
  expect(f.writes).toHaveLength(2);
});
it("并发实例只能创建一个预约，不依靠进程内锁", async () => {
  const f = fixture(), a = createSitesDatabaseStore(f.db), b = createSitesDatabaseStore(f.db);
  const result = await Promise.all([a.runs.reserve(run()), b.runs.reserve(run())]);
  expect(result.map(item => item.kind).sort()).toEqual(["created", "exists"]);
  expect((f.row()?.runs as unknown[])).toHaveLength(1);
});
it("总量检查与预约写在同一 CAS 中，并发不能越过最后一个名额", async () => {
  const f = fixture(), a = createSitesDatabaseStore(f.db, { limits: { totalRuns: 1 } }), b = createSitesDatabaseStore(f.db, { limits: { totalRuns: 1 } });
  const result = await Promise.all([a.runs.reserve(run("request_1111")), b.runs.reserve(run("request_2222", "owner-b"))]);
  expect(result.map(item => item.kind).sort()).toEqual(["created", "limited"]);
  expect((f.row()?.runs as unknown[])).toHaveLength(1);
});
it("用户额度独立，但失败或不确定记录不释放名额导致重复收费", async () => {
  const f = fixture(), store = createSitesDatabaseStore(f.db, { limits: { userRuns: 1 } });
  await store.runs.reserve(run());
  await store.runs.transition("owner-a", "request_1234", "creating", { state: "uncertain" });
  expect((await store.runs.reserve(run("request_2222"))).kind).toBe("limited");
  expect((await store.runs.reserve(run("request_1234", "owner-b"))).kind).toBe("created");
});
it("状态 CAS 比较 owner、run 与旧状态，SQL 更新自身带 id/version 谓词", async () => {
  const f = fixture(), store = createSitesDatabaseStore(f.db); await store.runs.reserve(run());
  expect(await store.runs.transition("owner-b", "request_1234", "creating", { state: "ready" })).toBe(false);
  expect(await store.runs.transition("owner-a", "request_1234", "creating", { state: "ready", sessionId: "sess_test" })).toBe(true);
  expect(await store.runs.transition("owner-a", "request_1234", "creating", { state: "uncertain" })).toBe(false);
  expect(f.writes[1].filters).toEqual([["id", "campusmate-p0-v1"], ["version", 1]]);
  expect(f.row()?.version).toBe(2);
});
it("写结果未知不进行第二次写调用", async () => {
  const f = fixture(), store = createSitesDatabaseStore(f.db); await store.runs.reserve(run()); f.fail();
  await expect(store.runs.transition("owner-a", "request_1234", "creating", { state: "ready" })).rejects.toThrow();
  expect(f.writes).toHaveLength(2);
});
it("仅确认零行的 CAS 冲突才重试，并有四次上限", async () => {
  const f = fixture(), store = createSitesDatabaseStore(f.db); f.conflict(10);
  await expect(store.runs.reserve(run())).rejects.toThrow("sites_database_busy");
  expect(f.writes).toHaveLength(4);
});
it("跨实例全站/用户频次限制与时间窗口重置", async () => {
  let now = 1000;
  const f = fixture(), options = { limits: { requestsPerMinute: 3, userRequestsPerMinute: 2 }, now: () => now };
  const a = createSitesDatabaseStore(f.db, options), b = createSitesDatabaseStore(f.db, options);
  expect(await a.allowRequest("a", "write")).toBe(true);
  expect(await b.allowRequest("a", "stream")).toBe(true);
  expect(await a.allowRequest("a", "read")).toBe(false);
  expect(await b.allowRequest("b", "read")).toBe(true);
  expect(await b.allowRequest("c", "read")).toBe(false);
  now += 60_000;
  expect(await a.allowRequest("a", "read")).toBe(true);
});
it("限制不能配置为无界或无效值", () => {
  const f = fixture();
  for (const value of [0, -1, 101, NaN, 1.5]) expect(() => createSitesDatabaseStore(f.db, { limits: { totalRuns: value } })).toThrow("sites_invalid_limits");
});
it("租约等待参数不能为负数或越界", () => {
  const f = fixture();
  for (const lock of [{ waitMs: -1 }, { waitMs: 30_001 }, { waitMs: 1.5 }, { retryMs: -1 }, { retryMs: 1_001 }]) {
    expect(() => createSitesDatabaseStore(f.db, { lock })).toThrow("sites_invalid_lock_options");
  }
});

it("withLock 返回回调结果并把记录持久化，释放后立即可再次加锁", async () => {
  const f = fixture(), store = createSitesDatabaseStore(f.db);
  const result = await store.coordinator.withLock("sites:agent:abc", async lease => {
    expect(await lease.read()).toBeNull();
    await lease.write({ state: "creating", fingerprint: "f".repeat(64), future: { nested: [1, 2] } });
    await lease.assertHeld();
    expect(await lease.read()).toEqual({ state: "creating", fingerprint: "f".repeat(64), future: { nested: [1, 2] } });
    return "ok";
  });
  expect(result).toBe("ok");
  expect(f.lockRow("sites:agent:abc")?.record).toEqual({ state: "creating", fingerprint: "f".repeat(64), future: { nested: [1, 2] } });
  expect(f.lockRow("sites:agent:abc")?.expires_at).toBe(0);
  await expect(store.coordinator.withLock("sites:agent:abc", async () => "again")).resolves.toBe("again");
});
it("接管过期租约时沿用 version CAS 并保留未知创建记录", async () => {
  const f = fixture();
  f.seedLock({ lock_key: "k", version: 7, token: "stale", expires_at: 0, record: { state: "unknown", fingerprint: "abc", extra: true } });
  const store = createSitesDatabaseStore(f.db);
  const seen = await store.coordinator.withLock("k", async lease => {
    expect(await lease.read()).toEqual({ state: "unknown", fingerprint: "abc", extra: true });
    await lease.assertHeld();
    return "done";
  });
  expect(seen).toBe("done");
  expect(f.lockRow("k")?.record).toEqual({ state: "unknown", fingerprint: "abc", extra: true });
  expect(f.lockRow("k")?.version).toBe(9);
});
it("60 秒租约到期后旧持有者的 read/write/assertHeld 全部失败", async () => {
  let now = 1000;
  const f = fixture(), store = createSitesDatabaseStore(f.db, { now: () => now });
  await store.coordinator.withLock("k", async lease => {
    await lease.write({ state: "creating" });
    now += 60_000;
    await expect(lease.assertHeld()).rejects.toThrow("sites_lock_lost");
    await expect(lease.read()).rejects.toThrow("sites_lock_lost");
    await expect(lease.write({ state: "ready" })).rejects.toThrow("sites_lock_lost");
  });
  expect(f.lockRow("k")?.record).toEqual({ state: "creating" });
});
it("新持有者接管后，过期旧持有者仍然不能写", async () => {
  let now = 1000;
  const f = fixture(), options = { now: () => now };
  let oldLease: SitesLockLease | undefined;
  await createSitesDatabaseStore(f.db, options).coordinator.withLock("k", async lease => {
    oldLease = lease;
    await lease.write({ state: "creating" });
    now += 60_000;
  });
  await createSitesDatabaseStore(f.db, options).coordinator.withLock("k", async lease => {
    await lease.write({ state: "creating" });
  });
  await expect(oldLease!.write({ state: "rejected" })).rejects.toThrow("sites_lock_lost");
  expect(f.lockRow("k")?.record).toEqual({ state: "creating" });
});
it("跨实例 withLock 串行执行，回调不重叠", async () => {
  const f = fixture(), options = { lock: { waitMs: 2_000, retryMs: 5 } };
  const a = createSitesDatabaseStore(f.db, options), b = createSitesDatabaseStore(f.db, options);
  let active = 0, peak = 0;
  const order: string[] = [];
  const work = (name: string) => async (lease: SitesLockLease) => {
    active++; peak = Math.max(peak, active);
    order.push(`${name}:start`);
    await new Promise(resolve => setTimeout(resolve, 10));
    await lease.assertHeld();
    await lease.write({ name });
    order.push(`${name}:end`);
    active--;
  };
  await Promise.all([a.coordinator.withLock("shared", work("a")), b.coordinator.withLock("shared", work("b"))]);
  expect(peak).toBe(1);
  expect(order).toHaveLength(4);
  expect(order[1]).toBe(`${order[0].slice(0, 1)}:end`);
});
it("租约未过期且等待超时时返回 busy，不并行执行回调", async () => {
  const f = fixture(), options = { lock: { waitMs: 40, retryMs: 5 } };
  const a = createSitesDatabaseStore(f.db, options), b = createSitesDatabaseStore(f.db, options);
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  let ran = false;
  const holding = a.coordinator.withLock("held", async () => { await gate; });
  await new Promise(resolve => setTimeout(resolve, 10));
  await expect(b.coordinator.withLock("held", async () => { ran = true; })).rejects.toThrow("sites_database_busy");
  expect(ran).toBe(false);
  releaseGate();
  await holding;
});
it("拒绝非法锁键与非法记录，且非法记录不被写入", async () => {
  const f = fixture(), store = createSitesDatabaseStore(f.db);
  await expect(store.coordinator.withLock("../bad", async () => undefined)).rejects.toThrow("sites_invalid_lock_key");
  expect(f.writes).toHaveLength(0);
  await expect(store.coordinator.withLock("ok", async lease => {
    await lease.write([] as unknown as Record<string, unknown>);
  })).rejects.toThrow("sites_invalid_lock_record");
  expect(f.lockRow("ok")?.record ?? null).toBeNull();
});
