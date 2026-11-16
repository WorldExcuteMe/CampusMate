import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildContext, createApiServer } from '../app-context.ts';
import { signJwt } from './jwt.ts';
import { MAX_IMAGES_PER_MESSAGE } from '../../../shared/attachments.ts';

test('任务图片必须全部接收或全部拒绝：边界、顺序、非法元素和幂等重试', async t => {
  const ctx = buildContext({}), owner = randomUUID(), sessionId = randomUUID();
  const server = createApiServer({ ...ctx, jwtSecret: 'images-test' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await ctx.dispose(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${signJwt({ sub: owner, exp: Math.floor(Date.now() / 1000) + 60 }, 'images-test')}` };
  await ctx.sessionStore.create({ userId: owner, id: sessionId, title: '图片测试' });
  const images = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 2 }, (_, i) => `https://images.example/${i}.png`);
  const post = (value: unknown, turnId = randomUUID()) => fetch(base + '/v1/tasks', { method: 'POST', headers, body: JSON.stringify({ title: '检查所有附件', sessionId, turnId, images: value }) });

  for (const value of [images.slice(0, 5), images, null, 'not-array', {}, [images[0], 1], [images[0], null], [''], ['  ']]) {
    const response = await post(value);
    assert.equal(response.status, 400);
    assert.ok((await response.json() as { error: string }).error);
    assert.equal((await ctx.store.listTasksByUser(owner)).length, 0);
    assert.equal((await ctx.sessionStore.listMessages(owner, sessionId)).length, 0);
  }
  const overLimit = await post(images);
  assert.match((await overLimit.json() as { error: string }).error, /最多 4 张图片.*6 张/);

  const turnId = randomUUID(), accepted = await post(images.slice(0, 4), turnId);
  assert.equal(accepted.status, 201);
  const saved = await accepted.json() as { taskId: string };
  assert.deepEqual((await ctx.store.getTask(saved.taskId))?.images, images.slice(0, 4));
  const rejectedRetry = await post(images.slice(0, 5), turnId);
  assert.equal(rejectedRetry.status, 400); // Never dedupe away an extra image.
  const retry = await post(images.slice(0, 4), turnId);
  assert.equal(retry.status, 201);
  assert.equal((await retry.json() as { taskId: string }).taskId, saved.taskId);
  assert.equal((await ctx.store.listTasksByUser(owner)).length, 1);

  for (const value of [[], undefined]) assert.equal((await post(value)).status, 201);
});
