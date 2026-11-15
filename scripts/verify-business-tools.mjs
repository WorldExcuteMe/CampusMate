// Local Docker integration only. Uses disposable Auth users, never the developer account.
// No paid model requests. Exercises real Postgres commits/rollback and browser REST/RLS.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildContext } from '../backend/src/app-context.ts';
import { PgPool, transactionPool } from '../backend/src/runtime/sql.ts';
import { PostgresStore } from '../backend/src/runtime/postgres-store.ts';
import { PostgresBusinessStore } from '../backend/src/runtime/postgres-business-store.ts';
import { executeCloudTool } from '../backend/src/core/cloud-tools.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/supabase/dist/supabase.js'), '--workdir', path.join(root, '.local/dev'), 'status', '-o', 'json'], { windowsHide: true });
const info = JSON.parse(stdout), api = info.API_URL, db = new URL(info.DB_URL);
for (const value of [new URL(api), db]) assert(['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname), 'Only localhost targets are allowed');
db.searchParams.set('sslmode', 'disable');
const pool = new PgPool(db.href, { ssl: false });
const ctx = buildContext({}, { pool });
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = createClient(api, info.SERVICE_ROLE_KEY, options), password = randomBytes(24).toString('hex');
const users = [];
const ok = r => { if (r.error) throw new Error('Local REST/Auth check failed'); return r.data; };
const check = (label, condition) => { assert(condition, label); console.log('PASS', label); };
try {
  const clients = [];
  for (let index = 0; index < 2; index++) {
    const email = `business-smoke-${randomUUID()}@example.com`;
    const user = ok(await admin.auth.admin.createUser({ email, password, email_confirm: true })).user;
    users.push(user);
    const client = createClient(api, info.ANON_KEY, options);
    ok(await client.auth.signInWithPassword({ email, password })); clients.push(client);
  }
  const [a, b] = clients, [owner, other] = users;
  // Publish a paused task atomically, so the normal background Worker cannot claim
  // this fixture and accidentally make a paid model request.
  const task = await pool.transaction(async client => {
    const tasks = new PostgresStore(transactionPool(client));
    const task = await tasks.createTask({ userId: owner.id, title: 'isolated-business-smoke' });
    await client.query("update agent_tasks set status='paused' where id=$1", [task.id]); return task;
  });
  const call = async (name, args, store = ctx.businessStore, userId = owner.id) => JSON.parse(await executeCloudTool(name, args, { taskId: task.id, userId, businessStore: store }));
  const inbox = await call('save_to_inbox', { title: '本地验证班会通知', summary: '合成测试通知，不代表真实活动。', deadline: '2026-11-20', category: 'daily', source: '合成测试群 123', userId: other.id });
  check('Inbox tool committed to real REST-visible user table', inbox.ok && ok(await a.from('inbox_items').select('id,raw_text,extracted').eq('id', inbox.id)).length === 1);
  check('Another account cannot read saved notice', ok(await b.from('inbox_items').select('id').eq('id', inbox.id)).length === 0);
  const dailyArgs = { title: '本地验证待办', dueAt: '2026-11-20', timeText: '19:00 教三101', userId: other.id };
  const responses = await Promise.all(Array.from({ length: 6 }, () => call('create_daily_task', dailyArgs)));
  check('Concurrent duplicate daily requests yield one persisted task', responses.every(r => r.ok && r.taskId === responses[0].taskId) && ok(await a.from('tasks').select('id').eq('title', dailyArgs.title)).length === 1);
  check('Other owner cannot read daily task', ok(await b.from('tasks').select('id').eq('id', responses[0].taskId)).length === 0);
  check('Forged task owner is rejected', Boolean((await call('create_daily_task', { title: 'must-not-save' }, ctx.businessStore, other.id)).error));
  const goal = await call('set_growth_goal', { goal: '本地验证成长目标', dueAt: '2026-12-20' });
  check('Goal, profile goal and corresponding task all persist', goal.ok && ok(await a.from('goals').select('id').eq('id', goal.goalId)).length === 1 && ok(await a.from('profiles').select('goals').single()).goals.includes('本地验证成长目标') && ok(await a.from('tasks').select('id').eq('id', goal.taskId)).length === 1);
  const rebuilt = buildContext({}, { pool });
  check('Rebuilt backend deduplicates against persisted SQL', (await call('set_growth_goal', { goal: '本地验证成长目标', dueAt: '2026-12-20' }, rebuilt.businessStore)).deduped === true);
  const failingPool = { query: pool.query.bind(pool), end: async () => {}, transaction: fn => pool.transaction(client => fn({ query: async (sql, params) => { if (sql.startsWith('insert into tasks') && params?.includes('rollback-only-goal')) throw new Error('fixture injected failure'); return client.query(sql, params); } })) };
  check('Injected persistence failure is not reported as success', Boolean((await call('set_growth_goal', { goal: 'rollback-only-goal' }, new PostgresBusinessStore(failingPool))).error));
  check('Goal transaction rollback left no partial goal/profile writes', ok(await a.from('goals').select('id').eq('title', 'rollback-only-goal')).length === 0 && !ok(await a.from('profiles').select('goals').single()).goals.includes('rollback-only-goal'));
  const duplicateId = randomUUID();
  ok(await a.from('inbox_items').insert({ id: duplicateId, user_id: owner.id, raw_text: '保留的重复原文', extracted: { title: '本地验证班会通知', deadline: '2026-11-20' }, classification: {}, status: 'confirmed' }));
  const linkedTaskId = randomUUID();
  ok(await a.from('tasks').insert({ id: linkedTaskId, user_id: owner.id, title: '关联测试待办', inbox_item_id: inbox.id }));
  const merged = await call('merge_inbox', {});
  check('Merge commits archive + provenance + task references together', merged.ok && merged.merged === 1 && ok(await a.from('inbox_items').select('status').eq('id', inbox.id).single()).status === 'archived' && ok(await a.from('inbox_items').select('merged_from').eq('id', duplicateId).single()).merged_from.includes(inbox.id) && ok(await a.from('tasks').select('inbox_item_id').eq('id', linkedTaskId).single()).inbox_item_id === duplicateId);
  check('Archived raw content retained', Boolean(ok(await a.from('inbox_items').select('raw_text').eq('id', inbox.id).single()).raw_text));
  check('Invalid date rejected without a saved task', Boolean((await call('create_daily_task', { title: 'invalid-date-fixture', dueAt: '2026-02-30' })).error) && ok(await a.from('tasks').select('id').eq('title', 'invalid-date-fixture')).length === 0);
  console.log('LOCAL_BUSINESS_TOOLS_VERIFIED (no paid model call)');
} finally {
  let cleanupFailed = false;
  for (const user of users) { const r = await admin.auth.admin.deleteUser(user.id); if (r.error) cleanupFailed = true; }
  await pool.end();
  if (cleanupFailed) throw new Error('Fixture cleanup incomplete; inspect temporary business-smoke accounts');
  console.log('PASS temporary users and their fixture data cleaned; existing user data untouched');
}
