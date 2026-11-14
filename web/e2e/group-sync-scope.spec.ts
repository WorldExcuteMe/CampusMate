import { expect, test, type Page } from "@playwright/test";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEXT = "2099年程序设计大赛报名通知，截止2099年11月25日";

// Exercise the shipped repository classes and browser storage. Only DB responses are fixtures.
async function syncAs(page: Page, owner: string) {
  return page.evaluate(async ({ owner, text }) => {
    // @ts-ignore Browser-side Vite module URL, not a Node filesystem import.
    const { DemoRepository, resetDemo } = await import("/src/lib/data/demo.ts");
    // @ts-ignore Browser-side Vite module URL.
    const { SupabaseRepository } = await import("/src/lib/data/supabase.ts");
    // @ts-ignore Browser-side Vite module URL.
    const { syncGroupRecords } = await import("/src/lib/ingest/qq.ts");
    const fixtureKey = "test.group-scope.rows";
    const read = (): Record<string, any[]> => JSON.parse(localStorage.getItem(fixtureKey) ?? "{}");
    const write = (rows: Record<string, any[]>) => localStorage.setItem(fixtureKey, JSON.stringify(rows));
    const db = {
      from(table: string) {
        const filters: [string, unknown][] = [];
        let patch: Record<string, unknown> | undefined;
        const selected = () => (read()[table] ?? []).filter(row => filters.every(([key, value]) => row[key] === value));
        return {
          async insert(row: Record<string, unknown>) {
            const rows = read(); (rows[table] ??= []).push(row); write(rows);
            return { error: null };
          },
          select() { return this; },
          eq(key: string, value: unknown) { filters.push([key, value]); return this; },
          async order() { return { data: selected(), error: null }; },
          update(value: Record<string, unknown>) { patch = value; return this; },
          async single() {
            const rows = read();
            const row = (rows[table] ?? []).find(row => filters.every(([key, value]) => row[key] === value));
            if (row && patch) Object.assign(row, patch);
            write(rows); return { data: row, error: null };
          },
        };
      },
    };
    if (owner === "reset-demo") { resetDemo(); return null; }
    const repo = owner === "demo" ? new DemoRepository() : new SupabaseRepository(db, owner);
    const summary = await syncGroupRecords([{
      time: "2099-10-01 10:00:00", sender: "fixture", type: 1,
      text, display: text, reasons: ["keyword"],
    }], repo);
    return { scope: repo.storageScope, summary };
  }, { owner, text: TEXT });
}

test("同一浏览器 Demo/A/B 去重隔离，刷新同账号仍去重，重置 Demo 不清理真实账号", async ({ page }) => {
  await page.route("**/api/providers", route => route.fulfill({ json: { providers: [], mutable: false } }));
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.evaluate(async (text) => {
    // @ts-ignore Browser-side Vite module URL.
    const { dedupKey } = await import("/src/lib/ingest/clean.ts");
    localStorage.setItem("campusmate.group.seen", JSON.stringify([dedupKey(text)]));
  }, TEXT);
  const imported = { inbox: 1, opportunity: 1, skipped: 0 };
  expect((await syncAs(page, "demo"))!.summary).toMatchObject(imported);
  expect((await syncAs(page, A))!.summary).toMatchObject(imported);
  expect((await syncAs(page, B))!.summary).toMatchObject(imported);
  await page.reload();
  for (const owner of [A, B, "demo"]) {
    expect((await syncAs(page, owner))!.summary).toMatchObject({ inbox: 0, opportunity: 0, skipped: 1 });
  }
  const beforeReset = await page.evaluate(() => ({
    legacy: localStorage.getItem("campusmate.group.seen"),
    rows: JSON.parse(localStorage.getItem("test.group-scope.rows")!),
    scopedKeys: Object.keys(localStorage).filter(key => key.startsWith("campusmate.group.seen.v2.")),
  }));
  expect(beforeReset.scopedKeys).toHaveLength(3);
  expect(beforeReset.rows.inbox_items).toHaveLength(2);
  expect(beforeReset.rows.inbox_items.map(row => row.user_id).sort()).toEqual([A, B]);
  await syncAs(page, "reset-demo");
  const afterReset = await page.evaluate(() => ({
    legacy: localStorage.getItem("campusmate.group.seen"),
    rows: JSON.parse(localStorage.getItem("test.group-scope.rows")!),
    scopedKeys: Object.keys(localStorage).filter(key => key.startsWith("campusmate.group.seen.v2.")),
  }));
  expect(afterReset.rows).toEqual(beforeReset.rows);
  expect(afterReset.legacy).toBe(beforeReset.legacy);
  expect(afterReset.scopedKeys).toHaveLength(2);
  expect((await syncAs(page, A))!.summary).toMatchObject({ skipped: 1 });
  expect((await syncAs(page, "demo"))!.summary).toMatchObject(imported);
});
