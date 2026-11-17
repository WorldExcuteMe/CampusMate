import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { storageFixture, OWNER, OTHER } from '../runtime/storage-test-fixture.ts';
import { BUSINESS_TOOL_NAMES, planInboxMerges, type MergeNotice } from './business-tools.ts';
import { CLOUD_TOOLS, executeCloudTool } from './cloud-tools.ts';
import { buildManifest } from './manifest.ts';
import { manifestTools } from './tool-registry.ts';
import { Worker } from '../runtime/worker.ts';
import type { ChatResult } from './types.ts';
import { DEFAULT_BUDGET } from './types.ts';
import { CAMPUS_SYSTEM } from './system-prompt.ts';
import { idempotencyKey } from '../runtime/idempotency.ts';

test('四个业务工具均进入 Manifest；无数据库绝不回报保存成功', async () => {
  const names = new Set(CLOUD_TOOLS.map(t => t.function.name));
  for (const name of BUSINESS_TOOL_NAMES) {
    assert(names.has(name));
    const out = JSON.parse(await executeCloudTool(name, { title: '测试' }));
    assert(out.error); assert.notEqual(out.ok, true);
  }
});

test('SQL真实保存通知/日常/目标；重建Context、重试与跨用户隔离', async t => {
  const { first, second, rebuild, pool } = await storageFixture(t);
  const task = await first.store.createTask({ userId: OWNER, title: '业务工具测试' });
  const otherTask = await first.store.createTask({ userId: OTHER, title: '另一用户' });
  const call = async (name: string, args: Record<string, unknown>, ctx = first, userId = OWNER, taskId = task.id) => JSON.parse(await executeCloudTool(name, args, { userId, taskId, businessStore: ctx.businessStore }));
  const manifest = buildManifest({ registry: first.capabilityRegistry, userId: OWNER, taskId: task.id, budget: DEFAULT_BUDGET });
  for (const name of BUSINESS_TOOL_NAMES) assert(manifestTools(manifest, CLOUD_TOOLS).some(tool => tool.function.name === name));
  const args = { title: '班会通知', summary: '请按通知到教室参加班会', category: 'daily', source: '群 123，消息时间 2026-11-15', deadline: '2026-11-20', userId: OTHER };
  const inbox = await call('save_to_inbox', args);
  assert.equal(inbox.ok, true); assert.equal(inbox.storage, 'postgres');
  const row = (await pool.query('select * from inbox_items where id=$1', [inbox.id])).rows[0];
  assert.equal(row.user_id, OWNER); assert.equal(row.extraction_mock, false);
  assert.equal((row.extracted as any).category, 'notice'); assert.equal(row.status, 'pending_review');
  assert.match(String(row.raw_text), /群 123/);
  const duplicate = await call('save_to_inbox', args, second);
  assert.equal(duplicate.id, inbox.id); assert.equal(duplicate.deduped, true);
  const daily = await call('create_daily_task', { title: '参加班会', dueAt: '2026-11-20', timeText: '19:00 教三101', userId: OTHER });
  assert.equal(daily.ok, true);
  const savedDaily = (await pool.query('select * from tasks where id=$1', [daily.taskId])).rows[0];
  assert.equal(savedDaily.user_id, OWNER); assert.equal(savedDaily.kind, 'daily'); assert.equal(savedDaily.time_text, '19:00 教三101');
  assert.equal((await call('create_daily_task', { title: '未知日期事项' })).dueAt, null);
  for (const dueAt of ['2026-02-30', '明天', '2026-1-5']) assert((await call('create_daily_task', { title: '无效', dueAt })).error);
  assert((await call('save_to_inbox', { title: ' ', summary: '无效' })).error);
  const goal = await call('set_growth_goal', { goal: '完成竞赛作品', dueAt: '2026-11-30' });
  assert.equal(goal.ok, true);
  assert.equal((await pool.query('select title from goals where id=$1', [goal.goalId])).rows[0].title, '完成竞赛作品');
  assert((await pool.query<{ goals: string[] }>('select goals from profiles where id=$1', [OWNER])).rows[0].goals.includes('完成竞赛作品'));
  const rebuilt = rebuild();
  assert.equal((await call('set_growth_goal', { goal: '完成竞赛作品', dueAt: '2026-11-30' }, rebuilt)).deduped, true);
  assert((await call('create_daily_task', { title: '越权尝试' }, first, OTHER, task.id)).error);
  const other = await call('save_to_inbox', args, first, OTHER, otherTask.id);
  assert.notEqual(other.id, inbox.id);
  // Date and body changes are not swallowed by the Worker's invocation cache.
  assert.notEqual(idempotencyKey('set_growth_goal', { goal: '同一目标', dueAt: '2026-11-20' }, { userId: OWNER }), idempotencyKey('set_growth_goal', { goal: '同一目标', dueAt: '2026-12-20' }, { userId: OWNER }));
  assert.notEqual(idempotencyKey('save_to_inbox', { title: '同标题', summary: '第一条' }, { userId: OWNER }), idempotencyKey('save_to_inbox', { title: '同标题', summary: '第二条' }, { userId: OWNER }));
  // A completed existing task must not be silently reopened on retry.
  await pool.query("update tasks set status='done' where id=$1", [daily.taskId]);
  assert.equal((await call('create_daily_task', { title: '参加班会', dueAt: '2026-11-20', timeText: '19:00 教三101' })).status, 'done');
});

test('成长目标事务失败整体回滚；合并原文/引用保留，跨用户与跨日期不误合并', async t => {
  const { first, second, pool } = await storageFixture(t);
  const task = await first.store.createTask({ userId: OWNER, title: '整理通知' });
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse(await executeCloudTool(name, args, { userId: OWNER, taskId: task.id, businessStore: first.businessStore }));
  await pool.exec(`create function fail_business_task() returns trigger language plpgsql as $$ begin if new.title='故障目标' then raise exception 'fixture failure'; end if; return new; end $$;
    create trigger fixture_task_failure before insert on tasks for each row execute function fail_business_task();`);
  const failed = await call('set_growth_goal', { goal: '故障目标' });
  assert(failed.error); assert.equal(failed.ok, undefined);
  assert.equal((await pool.query("select id from goals where title='故障目标'")).rows.length, 0);
  assert(!(await pool.query<{ goals: string[] }>('select goals from profiles where id=$1', [OWNER])).rows[0].goals.includes('故障目标'));
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const [i, id] of ids.entries()) await pool.query('insert into inbox_items(id,user_id,raw_text,extracted,classification,status) values($1,$2,$3,$4::jsonb,$5::jsonb,$6)', [id, i === 3 ? OTHER : OWNER, `原文${i}`, JSON.stringify({ title: i === 1 ? '关于班会通知' : '班会通知', deadline: i === 2 ? '2026-12-01' : '2026-11-20' }), '{}', i === 0 ? 'confirmed' : 'pending_review']);
  const link = randomUUID(); await pool.query("insert into tasks(id,user_id,title,inbox_item_id) values($1,$2,'关联任务',$3)", [link, OWNER, ids[1]]);
  const merged = await call('merge_inbox', { userId: OTHER });
  assert.equal(merged.ok, true); assert.equal(merged.merged, 1);
  assert.deepEqual((await pool.query('select merged_from from inbox_items where id=$1', [ids[0]])).rows[0].merged_from, [ids[1]]);
  assert.equal((await pool.query('select inbox_item_id from tasks where id=$1', [link])).rows[0].inbox_item_id, ids[0]);
  const archived = (await pool.query('select raw_text,status from inbox_items where id=$1', [ids[1]])).rows[0];
  assert.equal(archived.raw_text, '原文1'); assert.equal(archived.status, 'archived');
  for (const id of ids.slice(2)) assert.equal((await pool.query('select status from inbox_items where id=$1', [id])).rows[0].status, 'pending_review');
  const again = await second.businessStore!.execute('merge_inbox', {}, { userId: OWNER, taskId: task.id });
  assert.equal(again.merged, 0);
  // An injected archive failure must roll back canonical provenance and task relinking too.
  const extra = randomUUID(); await pool.query('insert into inbox_items(id,user_id,raw_text,extracted,classification) values($1,$2,\'原文新副本\',$3::jsonb,\'{}\')', [extra, OWNER, JSON.stringify({ title: '班会通知', deadline: '2026-11-20' })]);
  await pool.exec(`create function fail_archive() returns trigger language plpgsql as $$ begin if new.status='archived' then raise exception 'fixture failure'; end if; return new; end $$;
    create trigger fixture_archive_failure before update on inbox_items for each row execute function fail_archive();`);
  assert((await call('merge_inbox', {})).error);
  assert.equal((await pool.query('select status from inbox_items where id=$1', [extra])).rows[0].status, 'pending_review');
  assert.deepEqual((await pool.query('select merged_from from inbox_items where id=$1', [ids[0]])).rows[0].merged_from, [ids[1]]);
});

test('合并规则不因同源URL/无日期桥接而跨年度跨轮次误归档', () => {
  const make = (id: string, title: string, deadline: string | null): MergeNotice => ({ id, title, deadline, sourceUrl: 'https://school.example/event', status: 'pending_review', mergedFrom: [] });
  const a = make('a', '2025年创新赛', '2025-11-20'), b = make('b', '2026年创新赛', '2026-11-20');
  assert.equal(planInboxMerges([a, b]).length, 0);
  const dated = [make('a', '班会通知', '2026-11-20'), make('b', '班会通知', null), make('c', '班会通知', '2026-11-21')];
  for (const permutation of [dated, [...dated].reverse(), [dated[1], dated[2], dated[0]]]) {
    const plans = planInboxMerges(permutation); assert.equal(plans.length, 1); assert.equal(plans[0].duplicates.length, 1);
    assert.equal(plans[0].canonical.id, 'a');
  }
  assert.equal(planInboxMerges([make('a', '第11届创新赛', null), make('b', '第12届创新赛', null)]).length, 0);
});

test('真实SQL Worker通过四个工具写库；写库失败时模型口头成功仍标失败', async t => {
  const { first: ctx, pool } = await storageFixture(t);
  const task = await ctx.store.createTask({ userId: OWNER, title: '保存通知、创建待办、设置成长目标、合并通知' });
  let index = 0;
  const calls = [
    ['save_to_inbox', { title: '项目说明会', summary: '11月20日参加说明会' }],
    ['create_daily_task', { title: '参加项目说明会', dueAt: '2026-11-20' }],
    ['set_growth_goal', { goal: '完成项目作品', dueAt: '2026-12-20' }],
    ['merge_inbox', {}],
  ] as const;
  const transport = { async chat(): Promise<ChatResult> { const next = calls[index++]; return { content: next ? '' : '已保存', toolCalls: next ? [{ id: `call-${index}`, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }] : [], usage: { input: 1, output: 1 }, model: 'fixture-only' }; } };
  const worker = new Worker({ store: ctx.store, transport, tools: CLOUD_TOOLS, capabilityRegistry: ctx.capabilityRegistry, buildSystem: () => CAMPUS_SYSTEM, executeTool: (task, name, args) => executeCloudTool(name, args, { taskId: task.id, userId: task.userId, businessStore: ctx.businessStore }), concurrency: 1 });
  await worker.tick();
  const saved = (await ctx.store.getTask(task.id))!;
  assert.equal(saved.status, 'succeeded', saved.error);
  assert.equal((await pool.query('select id from inbox_items where user_id=$1', [OWNER])).rows.length, 1);
  assert.equal((await pool.query('select id from tasks where user_id=$1', [OWNER])).rows.length, 2);
  assert.equal((await pool.query('select id from goals where user_id=$1', [OWNER])).rows.length, 1);
  const failed = await ctx.store.createTask({ userId: OWNER, title: '无效日期保存测试' });
  let first = true;
  const liar = { async chat(): Promise<ChatResult> { const call = first; first = false; return { content: call ? '' : '保存成功了', toolCalls: call ? [{ id: 'bad', type: 'function', function: { name: 'create_daily_task', arguments: JSON.stringify({ title: '错误日期', dueAt: '2026-02-30' }) } }] : [], usage: { input: 1, output: 1 }, model: 'fixture-only' }; } };
  await new Worker({ store: ctx.store, transport: liar, tools: CLOUD_TOOLS, buildSystem: () => CAMPUS_SYSTEM, executeTool: (task, name, args) => executeCloudTool(name, args, { taskId: task.id, userId: task.userId, businessStore: ctx.businessStore }), concurrency: 1 }).tick();
  const rejected = (await ctx.store.getTask(failed.id))!;
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.result?.completion?.reason, 'business_tools_failed');
  assert.doesNotMatch(rejected.result?.summary ?? '', /保存成功了/);
  assert.match(rejected.result?.summary ?? '', /未全部确认成功/);
  assert.equal((await pool.query("select id from tasks where title='错误日期'")).rows.length, 0);
});
