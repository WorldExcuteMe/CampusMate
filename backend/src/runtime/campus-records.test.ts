import { test } from "node:test";
import assert from "node:assert/strict";
import { contextFor, storageFixture, OWNER, OTHER } from "./storage-test-fixture.ts";
import { executeCloudTool, CLOUD_TOOLS } from "../core/cloud-tools.ts";
const notice = { title: "CM验收讲座", rawText: "11月23日14:00–16:00 图书馆101；报名截止更正为11月22日18:00", summary: "提交报名表；旧截止已更正", deadline: "2026-11-22T18:00:00+08:00", location: "图书馆101", category: "activity" };
for (const mode of ["memory", "postgres"] as const) test(`${mode}: explicit deadline correction preserves identity across dates, retry and owner boundaries`, async t => {
  const fixture = mode === "postgres" ? await storageFixture(t) : undefined;
  const ctx = fixture?.first ?? contextFor();
  const original = await ctx.campusRecords.saveInbox(OWNER, notice);
  const args = { itemId: original.id, deadline: "2026-11-21", deadlineTime: "12:00" };
  const update = async (userId = OWNER, intent = "把刚才这条截止改为11月21日12:00，只更新已有记录") => JSON.parse(await executeCloudTool("update_inbox", args, { taskId: "correction", userId, intent, campusRecords: ctx.campusRecords }));
  const corrected = await update();
  assert.equal(corrected.ok, true);
  assert.equal(corrected.item.id, original.id);
  assert.equal(corrected.item.extracted.deadline, "2026-11-21T12:00:00+08:00");
  assert.equal(corrected.item.rawText, original.rawText);
  assert.equal((await update()).item.id, original.id);
  assert.equal((await ctx.campusRecords.listInbox(OWNER)).length, 1);
  assert.match((await update(OTHER)).error, /不存在|无权/);
  assert.match((await update(OWNER, "只预览更正，不要写入")).error, /禁止写入/);
  // A second independent occurrence must remain distinct; removing the date
  // from a create identity would silently conflate these two events.
  await ctx.campusRecords.saveInbox(OWNER, { ...notice, deadline: "2026-12-22", rawText: "另一场同名讲座，12月22日截止" });
  assert.equal((await ctx.campusRecords.listInbox(OWNER)).length, 2);
  if (fixture) {
    await fixture.pool.query("update inbox_items set status='confirmed' where id=$1", [original.id]);
    assert.match((await update()).error, /已确认/);
  }
});

test("an explicit bracketed notice title is preserved rather than abbreviated by the model", async () => {
  const ctx = contextFor();
  const saved = await ctx.campusRecords.saveInbox(OWNER, { ...notice, title: "CM对话", rawText: "①【CM对话通知】11月30日14:00 图书馆报告厅，报名截止11月22日18:00" });
  assert.equal(saved.extracted.title, "CM对话通知");
});
for (const mode of ["memory", "postgres"] as const) test(`${mode}: cloud inbox writes the actual inbox, deduplicates across tasks and isolates owners`, async t => {
  const fixture = mode === "postgres" ? await storageFixture(t) : undefined;
  const ctx = fixture?.first ?? contextFor();
  const save = async (userId: string, taskId: string) => JSON.parse(await executeCloudTool("save_to_inbox", notice, { userId, taskId, campusRecords: ctx.campusRecords }));
  assert(CLOUD_TOOLS.some(x => x.function.name === "save_to_inbox"));
  const first = await save(OWNER, "task1"), again = await save(OWNER, "task2"), other = await save(OTHER, "task3");
  assert.equal(first.ok, true); assert.equal(first.destination, "inbox"); assert.equal(first.item.id, again.item.id); assert.notEqual(first.item.id, other.item.id);
  assert.equal(first.item.extracted.deadline, notice.deadline); assert.equal(first.item.extracted.sourceUrl, null); assert.equal(first.item.extractionMock, false);
  assert.equal(first.item.status, "pending_review"); assert.equal((await ctx.opportunityStore.listByUser(OWNER)).length, 0);
  const local = await ctx.campusRecords.saveInbox(OWNER, { ...notice, deadline: "2026-11-22T18:00:00" });
  const utc = await ctx.campusRecords.saveInbox(OWNER, { ...notice, deadline: "2026-11-22T10:00:00Z" });
  assert.equal(local.id, first.item.id); assert.equal(utc.id, first.item.id);
  await assert.rejects(ctx.campusRecords.saveInbox(OWNER, { ...notice, deadline: "2026-02-30T18:00:00" }), /截止时间/);
  if (fixture) { const rows = await fixture.pool.query<{ user_id: string; count: number }>("select user_id,count(*)::int as count from inbox_items group by user_id"); assert.deepEqual(rows.rows.map(r => r.count).sort(), [1, 1]); const rebuilt = fixture.rebuild(); assert.equal((await rebuilt.campusRecords.saveInbox(OWNER, notice)).id, first.item.id); }
});

test("preview and destination constraints reject writes before reaching either store", async () => {
  const ctx = contextFor();
  const wrong = JSON.parse(await executeCloudTool("save_opportunity", { title: "CM验收" }, { taskId: "x", userId: OWNER, intent: "保存到信息中心", opportunityStore: ctx.opportunityStore }));
  assert.match(wrong.error, /不同去处/); assert.equal((await ctx.opportunityStore.listByUser(OWNER)).length, 0);
  const preview = JSON.parse(await executeCloudTool("save_to_inbox", notice, { taskId: "x", userId: OWNER, intent: "只预览，不保存", campusRecords: ctx.campusRecords }));
  assert.match(preview.error, /禁止写入/);
});
test("preview-only restrictions also prevent document side effects even if a model requests them", async () => {
  const ctx = contextFor();
  const task = await ctx.store.createTask({ userId: OWNER, title: "预览边界", intent: "先预览，不保存到任何地方" });
  const result = JSON.parse(await executeCloudTool("document_create", { title: "CM预览边界", blocks: [{ type: "paragraph", text: "仅供预览的建议草稿", claimType: "proposal" }] }, { taskId: task.id, userId: OWNER, intent: task.intent, artifactStore: ctx.artifactStore, documents: ctx.documents }));
  assert.match(result.error ?? "", /禁止写入/);
  assert.equal((await ctx.artifactStore.listByTask(OWNER, task.id)).length, 0);
  const allowed = JSON.parse(await executeCloudTool("document_create", { title: "CM文档专用请求", blocks: [{ type: "paragraph", text: "建议草稿", claimType: "proposal" }] }, { taskId: task.id, userId: OWNER, intent: "不要保存到信息中心，只生成Word文件", artifactStore: ctx.artifactStore, documents: ctx.documents }));
  assert.equal(typeof allowed.artifactId, "string");
});

test("a model's Z suffix cannot shift a deadline explicitly stated in Beijing time", async () => {
  const ctx = contextFor();
  const saved = await ctx.campusRecords.saveInbox(OWNER, { ...notice, deadline: "2026-11-22T18:00:00Z" }, "截止2026年11月22日18:00，按北京时间");
  assert.equal(saved.extracted.deadline, "2026-11-22T18:00:00+08:00");
  const utc = await ctx.campusRecords.saveInbox(OTHER, { ...notice, deadline: "2026-11-22T18:00:00Z" }, "UTC截止2026年11月22日18:00");
  assert.equal(utc.extracted.deadline, "2026-11-22T18:00:00Z");
});

test("a pending legacy inbox timestamp is corrected in place from explicit source time", async t => {
  const fixture = await storageFixture(t), oldId = "33333333-3333-4333-8333-333333333333";
  await fixture.pool.query("insert into inbox_items(id,user_id,raw_text,extracted,classification,status,extraction_mock) values($1,$2,$3,$4::jsonb,'{}','pending_review',false)", [oldId, OWNER, notice.rawText, JSON.stringify({ ...notice, deadline: "2026-11-22T18:00:00Z" })]);
  const saved = await fixture.first.campusRecords.saveInbox(OWNER, notice, "最新截止2026年11月22日18:00，保留一条");
  assert.equal(saved.id, oldId); assert.equal(saved.extracted.deadline, notice.deadline); assert.equal(saved.rawText, notice.rawText);
  assert.equal((await fixture.pool.query("select id from inbox_items where user_id=$1", [OWNER])).rows.length, 1);
  await fixture.pool.query("update inbox_items set status='confirmed',extracted=jsonb_set(extracted,'{deadline}','\"2026-11-22T19:00:00+08:00\"'::jsonb) where id=$1", [oldId]);
  assert.equal((await fixture.first.campusRecords.saveInbox(OWNER, notice, "最新截止2026年11月22日18:00")).extracted.deadline, "2026-11-22T19:00:00+08:00");
});
