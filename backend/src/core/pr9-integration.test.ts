import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_TOOLS, executeCloudTool } from './cloud-tools.ts';
import { parseSearchHits } from './web-search.ts';
import { CampusRecords } from './campus-records.ts';
import { argumentError } from './tool-arguments.ts';
test('integration keeps one definition per tool and both Inbox input contracts', async () => {
  const names = CLOUD_TOOLS.map(t => t.function.name);
  assert.equal(new Set(names).size, names.length);
  const inbox = CLOUD_TOOLS.find(t => t.function.name === 'save_to_inbox')!;
  assert.equal(argumentError(inbox.function.parameters, { title: '说明会', summary: '项目介绍', deadline: null }), null);
  const records = new CampusRecords();
  const ctx = { userId: 'owner', taskId: 'task', intent: '请保存说明会原始通知', campusRecords: records };
  assert.equal(JSON.parse(await executeCloudTool('save_to_inbox', { title: '说明会', summary: '项目介绍' }, ctx)).ok, true);
  assert(JSON.parse(await executeCloudTool('save_to_inbox', { title: '只有标题' }, ctx)).error);
});
test('integration preview policy blocks all added business writes before persistence', async () => {
  let writes = 0;
  const ctx = { userId: 'owner', taskId: 'task', intent: '只预览，不保存到任何地方', businessStore: { execute: async () => { writes++; return { ok: true as const, storage: 'postgres' as const }; } } };
  for (const name of ['create_daily_task','set_growth_goal','merge_inbox']) assert(JSON.parse(await executeCloudTool(name, {}, ctx)).error);
  assert.equal(writes, 0);
});
test('integration parses a result at the start of minimal Bing markup', () => {
  assert.equal(parseSearchHits('<h2><a href="https://school.example/">校园通知</a></h2>', 6).length, 1);
});
