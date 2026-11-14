import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER, OTHER, storageFixture } from "./storage-test-fixture.ts";
import type { PostgresOpportunityStore } from "./postgres-opportunity-store.ts";

// Break caught: buildContext selecting process-local stores despite an injected shared PostgreSQL pool.
test("共享数据库：API 创建的任务可由独立 Worker context 读取", async (t) => {
  const { first, second } = await storageFixture(t);
  const task = await first.store.createTask({ userId: OWNER, title: "共享任务" });
  assert.equal((await second.store.getTask(task.id))?.intent, "共享任务", "独立 context 不能丢失已提交任务");
});

test("共享数据库：审批决定在另一 context 与重建后可见，其他用户不能审批", async (t) => {
  const { first, second, rebuild } = await storageFixture(t);
  const task = await first.store.createTask({ userId: OWNER, title: "审批任务" });
  const pending = await first.approvals.create({ taskId: task.id, userId: OWNER, toolName: "write_file", args: { path: "proposal.md" }, idempotencyKey: "write-proposal", risk: "写入文件" });
  assert.equal((await second.approvals.get(pending.id))?.status, "pending", "审批不能只存在于 Worker 内存");
  assert.equal(await second.approvals.decide(pending.id, OTHER, "approved"), null);
  await second.approvals.decide(pending.id, OWNER, "approved");
  assert.equal((await rebuild().approvals.get(pending.id))?.status, "approved");
  assert.equal((await first.approvals.decide(pending.id, OWNER, "rejected"))?.status, "approved");
  assert.equal((await first.approvals.create({ taskId: task.id, userId: OWNER, toolName: "write_file", args: { path: "proposal.md" }, idempotencyKey: "write-proposal", risk: "写入文件" })).id, pending.id);
  await assert.rejects(() => first.approvals.create({ taskId: task.id, userId: OTHER, toolName: "write_file", args: {}, idempotencyKey: "foreign", risk: "x" }), /owner|forbidden|归属/i);
});

test("共享数据库：证据及核验结果在独立 context 和重建后保留", async (t) => {
  const { first, second, rebuild } = await storageFixture(t);
  const task = await first.store.createTask({ userId: OWNER, title: "核验证据" });
  const evidence = await first.evidenceStore.add({ taskId: task.id, userId: OWNER, sourceUrl: "https://school.example/competition", excerpt: "2026年校园创新比赛报名开放", supports: "报名已开放" });
  assert.equal((await second.evidenceStore.get(evidence.id))?.supports, "报名已开放", "证据不能只留在采集进程");
  await second.evidenceStore.markVerified(evidence.id, true);
  assert.equal((await rebuild().evidenceStore.listByTask(task.id))[0]?.verified, true);
  await assert.rejects(() => first.evidenceStore.add({ taskId: task.id, userId: OTHER, sourceUrl: "https://school.example", excerpt: "x", supports: "x" }), /owner|forbidden|归属/i);
});

test("共享数据库：画像与真实课表由独立 context 读取，父学期 owner 强制隔离", async (t) => {
  const { first, second, rebuild } = await storageFixture(t);
  await first.personalContext.setProfile({ userId: OWNER, university: "示例大学", major: "计算机", grade: "大二", skills: ["Python"], interests: ["人工智能"], goals: ["参加创新竞赛"], preferences: {}, updatedAt: 1 });
  assert.equal((await second.personalContext.getProfile(OWNER))?.major, "计算机", "结构化画像必须是共享事实来源");
  const term = await first.personalContext.createTerm({ userId: OWNER, institutionId: "example", name: "秋季", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20, timezone: "Asia/Shanghai" });
  const rows = await first.personalContext.saveSchedules(OWNER, term.id, [{ courseId: "", courseName: "算法", weekday: 2, startTime: "08:00", endTime: "09:40", startWeek: 1, endWeek: 16, weekPattern: "odd" }]);
  await first.personalContext.addException({ userId: OWNER, termId: term.id, scheduleId: rows[0].id, kind: "cancel", date: "2026-11-17" });
  assert.equal((await rebuild().personalContext.listSchedules(OWNER, term.id))[0]?.weekPattern, "odd");
  assert.equal((await second.personalContext.listExceptions(OWNER, term.id))[0]?.kind, "cancel");
  assert.deepEqual(await second.personalContext.listSchedules(OTHER, term.id), []);
  await assert.rejects(() => second.personalContext.saveSchedules(OTHER, term.id, [{ courseId: "", courseName: "越界", weekday: 1, startTime: "08:00", endTime: "09:00", startWeek: 1, endWeek: 2, weekPattern: "every" }]), /owner|forbidden|归属/i);
});

test("共享数据库：Agent 机会可跨 context 查询，其他用户与重建不丢失隔离", async (t) => {
  const { first, second, rebuild } = await storageFixture(t);
  const opportunity = await first.opportunityStore.create({ userId: OWNER, title: "校园创新赛", sourceUrl: "https://school.example/contest" });
  assert.equal((await second.opportunityStore.get(OWNER, opportunity.id))?.title, "校园创新赛", "Agent 保存的机会必须对 API 可见");
  assert.equal(await second.opportunityStore.get(OTHER, opportunity.id), null);
  assert.equal((await rebuild().opportunityStore.listByUser(OWNER))[0]?.id, opportunity.id);
});

test("共享数据库：private正文按owner分开去重，public收藏共用目录且RLS直接查询不泄漏", async (t) => {
  const { pool, first, second } = await storageFixture(t);
  const a = await first.opportunityStore.create({ userId: OWNER, title: "尚未公开的项目创意", description: "私人草稿" });
  const b = await second.opportunityStore.create({ userId: OTHER, title: "尚未公开的项目创意", description: "私人草稿" });
  assert.notEqual(a.id, b.id, "private相同内容不能借跨owner去重泄漏");
  assert.equal((await first.opportunityStore.create({ userId: OWNER, title: "尚未公开的项目创意", description: "私人草稿" })).id, a.id);
  const publicId = "44444444-4444-4444-8444-444444444444";
  await pool.query("insert into opportunities(id,title,type,source_url) values($1,'公开校赛','competition','https://school.example/public')", [publicId]);
  const one = first.opportunityStore as PostgresOpportunityStore;
  const two = second.opportunityStore as PostgresOpportunityStore;
  assert.equal((await one.savePublic(OWNER, publicId)).id, publicId);
  assert.equal((await two.savePublic(OTHER, publicId)).id, publicId);
  await assert.rejects(() => two.savePublic(OTHER, a.id), /owner|forbidden|public/i);
  assert.equal(Number((await pool.query<{ n: string }>("select count(*) as n from opportunities where id=$1", [publicId])).rows[0].n), 1);
  await pool.exec("create role storage_reader; grant usage on schema public,auth to storage_reader; grant select on opportunities,user_opportunities,user_llm_providers to storage_reader; grant execute on function auth.uid() to storage_reader;");
  await pool.transaction(async (client) => {
    await client.query("set local role storage_reader");
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [OTHER]);
    const rows = await client.query<{ id: string }>("select id from opportunities order by id");
    assert.deepEqual(rows.rows.map((r) => r.id).sort(), [b.id, publicId].sort());
    assert.equal((await client.query("select * from user_llm_providers")).rows.length, 0);
    await client.query("select set_config('request.jwt.claim.sub','',true)");
    assert.deepEqual((await client.query<{ id: string }>("select id from opportunities")).rows.map((r) => r.id), [publicId]);
  });
});

test("共享数据库：调课不能引用跨owner或跨term课程，用户URL不晋升全局白名单", async (t) => {
  const { first, pool } = await storageFixture(t);
  const termInput = { institutionId: "example", name: "秋季", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20, timezone: "Asia/Shanghai" };
  const own = await first.personalContext.createTerm({ ...termInput, userId: OWNER });
  const other = await first.personalContext.createTerm({ ...termInput, userId: OTHER });
  const [foreign] = await first.personalContext.saveSchedules(OTHER, other.id, [{ courseId: "", courseName: "他人课程", weekday: 1, startTime: "08:00", endTime: "09:00", startWeek: 1, endWeek: 10, weekPattern: "every" }]);
  await assert.rejects(() => first.personalContext.addException({ userId: OWNER, termId: own.id, scheduleId: foreign.id, kind: "cancel", date: "2026-11-16" }), /owner|forbidden|归属/i);
  await assert.rejects(() => first.personalContext.addException({ userId: OWNER, termId: other.id, kind: "holiday", date: "2026-11-16" }), /owner|forbidden|归属/i);
  await first.personalContext.addSource({ userId: OWNER, name: "用户输入站点", kind: "campus_website", url: "https://unreviewed.example", enabled: true });
  assert.equal((await first.personalContext.listSources(OWNER))[0]?.url, "https://unreviewed.example");
  assert.equal((await pool.query("select id from information_sources where url='https://unreviewed.example'")).rows.length, 0);
});
