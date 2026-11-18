import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContext } from "../app-context.ts";
import { canonicalArgs, sha256 } from "./idempotency.ts";
import { collectSource, linkedSourceTools, validateSourceGrants } from "./linked-sources.ts";
import { executeWorkspaceTool } from "./workspace-tools.ts";
import { createSourceFixture } from "../evaluation/targets/source-fixture.ts";
import { scheduleKey } from "../../../shared/calendar.ts";

test("群源实际 HTTP 翻页去重，存储哈希与下载文件哈希分开，其他用户不能读取", async (t) => {
  const fixture = await createSourceFixture("group-cursor", "pagination-test");
  t.after(fixture.close);
  const ctx = buildContext({});
  const task = await ctx.store.createTask({ userId: randomUUID(), title: "test" });
  const other = await ctx.store.createTask({ userId: randomUUID(), title: "test" });
  const item = linkedSourceTools(ctx, userId => userId === task.userId ? fixture.grants : []).find(item => item.definition.function.name === "source_collect")!;
  const args = { sourceId: fixture.sourceId, from: "2026-11-01", to: "2026-11-17" };
  assert.match(await executeWorkspaceTool(item, args, other), /没有该数据源授权/);
  assert.equal(fixture.served(), 0);
  const read = JSON.parse(await executeWorkspaceTool(item, args, task));
  assert.ok(read.artifactId, JSON.stringify(read));
  assert.equal(read.records, 480);
  assert.equal(read.pages, 10);
  assert.equal(read.contentSha256, fixture.hash);
  const stored = await ctx.artifactStore.get(task.userId, read.artifactId);
  assert.equal(stored?.sha256, sha256(canonicalArgs(stored!.inline as Record<string, unknown>)));
  assert.equal(await ctx.artifactStore.get(other.userId, read.artifactId), null);
});

for (const format of ["semester-csv", "semester-ics"] as const) {
  test(`${format} 产物生成覆盖全部周次的可回读预览`, async (t) => {
    const fixture = await createSourceFixture(format, "calendar-test");
    t.after(fixture.close);
    const ctx = buildContext({});
    const userId = randomUUID();
    const task = await ctx.store.createTask({ userId, title: "test" });
    const term = await ctx.personalContext.createTerm({ userId, institutionId: "fixture", name: "秋季学期", startDate: "2026-09-07", endDate: "2027-02-21", totalWeeks: 24, timezone: "Asia/Shanghai" });
    const items = linkedSourceTools(ctx, () => fixture.grants);
    const run = (name: string, args: Record<string, unknown>) =>
      executeWorkspaceTool(items.find(item => item.definition.function.name === name)!, args, task).then(raw => JSON.parse(raw));
    const source = await run("source_collect", { sourceId: fixture.sourceId });
    assert.ok(source.artifactId, JSON.stringify(source));
    const data = await run("source_timetable_preview", { artifactId: source.artifactId, termId: term.id });
    assert.equal(data.errorCount, 0, JSON.stringify(data));
    const job = await ctx.personalContext.getImportJob(userId, new URL(data.previewUrl, "http://localhost").searchParams.get("import")!);
    const keys = job?.preview?.schedules.map(scheduleKey).sort() ?? [];
    assert.equal(keys.length, 24);
    assert.equal(sha256(JSON.stringify(keys)), fixture.scheduleDigest);
    assert.deepEqual(await ctx.personalContext.listSchedules(userId, term.id), []);
  });
}

test("来源拒绝登录页、短页和重复游标，生产授权拒绝明文 HTTP", async () => {
  const grant = { id: "group", label: "目标群", dataset: "messages", url: "https://example.test/messages", format: "json-cursor" } as const;
  assert.throws(() => validateSourceGrants([{ ...grant, url: "http://127.0.0.1/messages" }]), /HTTPS/);
  await assert.rejects(() => collectSource(grant, {}, async () => new Response("<form>login</form>", { headers: { "Content-Type": "text/html" } })), /登录页/);
  await assert.rejects(() => collectSource(grant, {}, async () => Response.json({ records: [{ id: "1" }], nextCursor: null, total: 2 })), /总数不符/);
  await assert.rejects(() => collectSource(grant, {}, async () => Response.json({ records: [{ id: "1" }], nextCursor: "same" })), /游标重复/);
});
