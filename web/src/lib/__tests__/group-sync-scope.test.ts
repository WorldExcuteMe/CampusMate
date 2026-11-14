import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoRepository, resetDemo } from "../data/demo";
import { SupabaseRepository } from "../data/supabase";
import type { InboxItem, Opportunity, Repository, Task } from "../data/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dedupKey } from "../ingest/clean";
import { syncGroupRecords, type GroupRecord } from "../ingest/qq";

const LEGACY_KEY = "campusmate.group.seen";
const keyFor = (scope: string) => `campusmate.group.seen.v2.${encodeURIComponent(scope)}`;
const record: GroupRecord = {
  time: "2099-10-01 10:00:00", sender: "fixture", type: 1, reasons: ["keyword"],
  text: "2099年程序设计大赛报名通知，截止2099年11月25日",
  display: "2099年程序设计大赛报名通知，截止2099年11月25日",
};

function fixture(owner: string) {
  const inbox: InboxItem[] = [], tasks: Task[] = [], opportunities: Opportunity[] = [];
  const repo = {
    mode: "supabase", storageScope: `supabase:${owner}`,
    getProfile: vi.fn().mockRejectedValue(new Error("Scope must not depend on a profile request")),
    createInbox: vi.fn(async (item: InboxItem) => { const saved = { ...item, userId: owner }; inbox.push(saved); return saved; }),
    createTask: vi.fn(async (task: Task) => { tasks.push(task); return task; }),
    createOpportunity: vi.fn(async (opp: Opportunity) => { opportunities.push(opp); return opp; }),
    listInbox: vi.fn(async () => inbox), updateInbox: vi.fn(),
  };
  return { repo: repo as unknown as Repository, methods: repo, inbox, tasks, opportunities };
}

beforeEach(() => { localStorage.clear(); });

describe("group ingestion account-scoped dedup", () => {
  it("A → B → A imports once for each owner and only skips A's own replay", async () => {
    const a = fixture("A"), b = fixture("B");
    expect(await syncGroupRecords([record], a.repo)).toMatchObject({ inbox: 1, opportunity: 1, skipped: 0 });
    expect(await syncGroupRecords([record], b.repo)).toMatchObject({ inbox: 1, opportunity: 1, skipped: 0 });
    expect(await syncGroupRecords([record], a.repo)).toMatchObject({ inbox: 0, opportunity: 0, skipped: 1 });
    expect(a.inbox).toHaveLength(1); expect(b.inbox).toHaveLength(1);
    expect(a.methods.getProfile).not.toHaveBeenCalled();
    expect(localStorage.getItem(keyFor("supabase:A"))).not.toBeNull();
    expect(localStorage.getItem(keyFor("supabase:B"))).not.toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
  it("Demo → real account → Demo keeps their histories separate", async () => {
    const demo = new DemoRepository(), a = fixture("A");
    expect(await syncGroupRecords([record], demo)).toMatchObject({ inbox: 1, opportunity: 1 });
    expect(await syncGroupRecords([record], a.repo)).toMatchObject({ inbox: 1, opportunity: 1 });
    expect(await syncGroupRecords([record], demo)).toMatchObject({ skipped: 1 });
    expect((await demo.listInbox()).filter((item) => item.rawText === record.display)).toHaveLength(1);
    expect(a.inbox).toHaveLength(1);
  });
  it("does not inherit or delete an unattributed legacy cache for Demo or any account", async () => {
    const legacy = JSON.stringify([dedupKey(record.display)]);
    localStorage.setItem(LEGACY_KEY, legacy);
    for (const repo of [new DemoRepository(), fixture("A").repo, fixture("B").repo]) {
      expect(await syncGroupRecords([record], repo)).toMatchObject({ inbox: 1, opportunity: 1, skipped: 0 });
    }
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacy);
  });
  it("recreating a repository for the same owner keeps dedup stable", async () => {
    await syncGroupRecords([record], fixture("A").repo);
    const recreated = fixture("A");
    expect(await syncGroupRecords([record], recreated.repo)).toMatchObject({ inbox: 0, opportunity: 0, skipped: 1 });
    expect(recreated.methods.createInbox).not.toHaveBeenCalled();
  });
  it("a pending A sync cannot write B's dedup cache after the active account changes", async () => {
    const a = fixture("A"), b = fixture("B");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    a.methods.createInbox.mockImplementationOnce(async (item: InboxItem) => { await pending; a.inbox.push(item); return item; });
    const runningA = syncGroupRecords([record], a.repo);
    await vi.waitFor(() => expect(a.methods.createInbox).toHaveBeenCalledTimes(1));
    expect(await syncGroupRecords([record], b.repo)).toMatchObject({ inbox: 1, skipped: 0 });
    const cacheB = localStorage.getItem(keyFor("supabase:B"));
    expect(cacheB).not.toBeNull();
    release(); await runningA;
    expect(localStorage.getItem(keyFor("supabase:A"))).not.toBeNull();
    expect(localStorage.getItem(keyFor("supabase:B"))).toBe(cacheB);
    expect(await syncGroupRecords([record], fixture("A").repo)).toMatchObject({ skipped: 1 });
  });
  it("a failed first write marks neither owner seen and can be retried independently", async () => {
    const a = fixture("A"), b = fixture("B");
    a.methods.createInbox.mockRejectedValueOnce(new Error("fixture database unavailable"));
    await expect(syncGroupRecords([record], a.repo)).rejects.toThrow("fixture database unavailable");
    expect(localStorage.getItem(keyFor("supabase:A"))).toBeNull();
    expect(await syncGroupRecords([record], b.repo)).toMatchObject({ inbox: 1, skipped: 0 });
    expect(await syncGroupRecords([record], a.repo)).toMatchObject({ inbox: 1, skipped: 0 });
    expect(a.inbox).toHaveLength(1); expect(b.inbox).toHaveLength(1);
  });
  it("resetDemo clears only Demo group cache and preserves other owners and the legacy cache", () => {
    for (const key of [keyFor("demo"), keyFor("supabase:A"), keyFor("supabase:B"), LEGACY_KEY]) localStorage.setItem(key, '["fixture"]');
    resetDemo();
    expect(localStorage.getItem(keyFor("demo"))).toBeNull();
    for (const key of [keyFor("supabase:A"), keyFor("supabase:B"), LEGACY_KEY]) expect(localStorage.getItem(key)).toBe('["fixture"]');
  });
  it.each(["broken-json", "null", '{"unexpected":true}', '[12,null,"other-notice"]'])("handles an invalid scoped cache without consulting other owners: %s", async (value) => {
    localStorage.setItem(keyFor("supabase:A"), value);
    localStorage.setItem(keyFor("supabase:B"), '["B-private"]');
    expect(await syncGroupRecords([record], fixture("A").repo)).toMatchObject({ inbox: 1 });
    expect(JSON.parse(localStorage.getItem(keyFor("supabase:A"))!)).toContain(dedupKey(record.display));
    expect(localStorage.getItem(keyFor("supabase:B"))).toBe('["B-private"]');
  });
  it("fails before any data access if a repository has no stable scope", async () => {
    const a = fixture("A");
    delete (a.repo as unknown as Record<string, unknown>).storageScope;
    await expect(syncGroupRecords([record], a.repo)).rejects.toThrow(/作用域/);
    expect(a.methods.createInbox).not.toHaveBeenCalled();
    expect(a.methods.listInbox).not.toHaveBeenCalled();
  });
  it("production repositories expose stable distinct scopes without fetching a profile", () => {
    const db = {} as SupabaseClient;
    const scope = (repo: Repository) => repo.storageScope;
    expect(scope(new DemoRepository())).toBe("demo");
    expect(scope(new SupabaseRepository(db, "A"))).toBe("supabase:A");
    expect(scope(new SupabaseRepository(db, "B"))).toBe("supabase:B");
    expect(scope(new SupabaseRepository(db, "A"))).toBe(scope(new SupabaseRepository(db, "A")));
  });
});
