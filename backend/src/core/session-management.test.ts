import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { contextFor, storageFixture, OWNER, OTHER } from '../runtime/storage-test-fixture.ts';
import { createApiServer } from '../api/server.ts';
import { signJwt } from '../api/jwt.ts';
import { publicConversation } from './session-management.ts';

for (const kind of ['memory', 'sql']) test(`${kind}: metadata CAS、归档恢复、软删除与旧窗口防复活`, async t => {
  const ctx = kind === 'sql' ? (await storageFixture(t)).first : contextFor();
  const s = await ctx.sessionStore.create({ userId: OWNER, title: '原始会话' });
  const renamed = await ctx.sessionStore.patch(OWNER, s.id, { title: '重命名后的会话', expectedRevision: 0 });
  assert.equal(renamed.revision, 1);
  await assert.rejects(() => ctx.sessionStore.patch(OWNER, s.id, { title: '旧窗口覆盖', expectedRevision: 0 }), /其他窗口/);
  await assert.rejects(() => ctx.sessionStore.patch(OTHER, s.id, { title: '越权', expectedRevision: 1 }));
  await assert.rejects(() => ctx.sessionStore.remove(OTHER, s.id, 1));
  const archived = await ctx.sessionStore.patch(OWNER, s.id, { archived: true, expectedRevision: 1 }); assert(archived.archived);
  const restored = await ctx.sessionStore.patch(OWNER, s.id, { archived: false, mode: 'daily', expectedRevision: 2 }); assert.equal(restored.mode, 'daily'); assert(!restored.archived);
  const { task } = await ctx.store.createSessionTask!({ userId: OWNER, sessionId: s.id, turnId: randomUUID(), title: '尚未结束的任务' }, ctx.sessionStore);
  await assert.rejects(() => ctx.sessionStore.remove(OWNER, s.id, 3), /未结束任务/);
  await ctx.store.updateTask(task.id, { status: 'cancelled' });
  const deleted = await ctx.sessionStore.remove(OWNER, s.id, 3); assert(deleted.deletedAt);
  assert((await ctx.sessionStore.list(OWNER)).some(r => r.id === s.id && r.deletedAt));
  assert.equal((await ctx.sessionStore.list(OTHER)).length, 0);
  await assert.rejects(() => ctx.sessionStore.create({ userId: OWNER, id: s.id }), /已删除/);
  await assert.rejects(() => ctx.store.createSessionTask!({ userId: OWNER, sessionId: s.id, turnId: randomUUID(), title: '旧窗口误提交' }, ctx.sessionStore));
  assert(await ctx.store.getTask(task.id), '任务和审计记录保留');
});
test('SQL上下文重建后会话与导入记录仍在，导入不生成任务、不进入Worker上下文', async t => {
  const { first, second, pool } = await storageFixture(t);
  const s = await first.sessionStore.create({ userId: OWNER, title: '本地历史' });
  await first.sessionStore.importLegacy(OWNER, s.id, [{ role: 'user', content: '以前的请求' }, { role: 'assistant', content: '以前的答复' }]);
  await first.sessionStore.importLegacy(OWNER, s.id, [{ role: 'user', content: '以前的请求' }, { role: 'assistant', content: '以前的答复' }]);
  assert.equal((await second.sessionStore.legacyHistory(OWNER, s.id)).length, 2);
  assert.equal((await second.sessionStore.listMessages(OWNER, s.id)).length, 0);
  assert.equal((await second.store.listTasksByUser(OWNER)).length, 0);
  await assert.rejects(() => second.sessionStore.importLegacy(OWNER, s.id, [{ role: 'user', content: '冲突覆盖' }]), /不同/);
  await assert.rejects(() => second.sessionStore.importLegacy(OTHER, s.id, []));
  assert.equal((await second.sessionStore.legacyHistory(OTHER, s.id)).length, 0);
  assert.equal((await pool.query('select count(*)::int as n from agent_tasks')).rows[0].n, 0);
});
test('会话API恢复超过40轮完整记录、不泄漏思考，跨账号/身份切换拒绝', async t => {
  const ctx = contextFor(), s = await ctx.sessionStore.create({ userId: OWNER });
  for (let i = 0; i < 45; i++) {
    const { task } = await ctx.store.createSessionTask!({ userId: OWNER, sessionId: s.id, turnId: randomUUID(), title: `标题${i}`, intent: `完整请求${i}` }, ctx.sessionStore);
    await ctx.store.updateTask(task.id, { status: 'running' });
    await ctx.store.updateTask(task.id, { status: 'succeeded', result: { summary: `完整答复${i}`, artifactIds: [] } });
  }
  await ctx.sessionStore.appendMessage({ userId: OWNER, sessionId: s.id, turnId: 'opaque', messageKey: 'opaque', role: 'assistant', content: '无任务的普通记录', reasoning_content: 'private-fixture', reasoning_source: 'private-scope' });
  const server = createApiServer({ store: ctx.store, sessionStore: ctx.sessionStore, jwtSecret: 'fixture-secret' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const call = (path: string, uid = OWNER, init: RequestInit = {}) => fetch(base+path, { ...init, headers: { Authorization: `Bearer ${signJwt({ sub: uid, exp: Date.now()/1000+60 }, 'fixture-secret')}`, 'Content-Type': 'application/json', ...init.headers } });
  const r = await call(`/v1/sessions/${s.id}/history`); assert.equal(r.status, 200); const text = await r.text();
  assert(!text.includes('private-fixture')); assert(!text.includes('reasoning_content')); assert(text.includes('完整请求0')); assert(text.includes('完整答复44'));
  const data = JSON.parse(text); assert.equal(data.tasks.length, 45); assert.equal(data.messages.length, 91);
  assert.equal((await call(`/v1/sessions/${s.id}/history`, OTHER)).status, 404);
  assert.equal((await call('/v1/sessions', OTHER, { headers: { 'X-Session-Owner': OWNER } })).status, 403);
  assert.equal((await call(`/v1/sessions/${s.id}`, OWNER, { method: 'PATCH', body: JSON.stringify({ title: '同步名称', expectedRevision: 0 }) })).status, 200);
  assert.equal((await call(`/v1/sessions/${s.id}`, OWNER, { method: 'PATCH', body: JSON.stringify({ title: '旧名称', expectedRevision: 0 }) })).status, 409);
  assert.equal((await call(`/v1/sessions/${s.id}`, OWNER, { method: 'DELETE', body: JSON.stringify({ expectedRevision: 1 }) })).status, 200);
  assert.equal((await call(`/v1/sessions/${s.id}/history`)).status, 404);
});
test('显示投影不重复展示原生工具中间消息，DSML不能标完成', () => {
  const tasks = [{ id: 't', intent: '请求', status: 'succeeded', createdAt: 1, result: { summary: '<｜｜DSML｜｜ calls>bad</｜｜DSML｜｜ calls>' } }] as any;
  const messages = publicConversation(tasks, [], []); assert.equal(messages.length, 2); assert(messages[1].failed); assert(!messages[1].content.includes('DSML'));
});
