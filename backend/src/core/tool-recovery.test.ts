import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from './agent-loop.ts';
import { assessToolOutcomes } from './tool-outcomes.ts';
import { toolResultView } from './task-events.ts';
import { CLOUD_TOOLS, executeCloudTool } from './cloud-tools.ts';
import { DEFAULT_BUDGET, type ChatMessage, type ChatResult, type ToolDef } from './types.ts';
import { Worker } from '../runtime/worker.ts';
import { storageFixture, OWNER } from '../runtime/storage-test-fixture.ts';
import { contextFor } from '../runtime/storage-test-fixture.ts';

const save = (title = '同一机会', deadline: unknown = null) => ({ title, deadline, sourceUrl: 'https://school.example/competition', type: 'competition' });
const call = (id: string, args: Record<string, unknown>, name = 'save_opportunity') => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
function transport(script: Partial<ChatResult>[]) { let index = 0; return { async chat(): Promise<ChatResult> { const next = script[index++]; assert(next, 'Unexpected model request'); return { content: '', toolCalls: [], usage: { input: 1, output: 1 }, model: 'fixture', ...next }; } }; }
const observations = (first: Record<string, unknown> = save(), second: Record<string, unknown> = save(), raw = '{"error":"temporary"}', name = 'save_opportunity'): ChatMessage[] => [
  { role: 'assistant', content: '', tool_calls: [call('failed', first, name)] }, { role: 'tool', content: raw, tool_call_id: 'failed' },
  { role: 'assistant', content: '', tool_calls: [call('ok', second, name)] }, { role: 'tool', content: '{"ok":true}', tool_call_id: 'ok' },
];

test('真实SQL：null/省略/空字符串截止日期可保存，非法日期不能落库', async t => {
  const { first } = await storageFixture(t);
  for (const [index, deadline] of [null, undefined, ''].entries()) {
    const task = await first.store.createTask({ userId: OWNER, title: '日期兼容' });
    const args = deadline === undefined ? { title: `未知日期${index}`, sourceUrl: 'https://school.example' } : { ...save(`未知日期${index}`, deadline) };
    const result = await runAgentLoop({ system: 's', user: '存机会', deps: { transport: transport([{ toolCalls: [call('save', args)] }, { content: '已保存' }]), tools: CLOUD_TOOLS, budget: DEFAULT_BUDGET, executeTool: (name, value) => executeCloudTool(name, value, { userId: OWNER, taskId: task.id, opportunityStore: first.opportunityStore }) } });
    assert.equal(result.toolErrors, 0);
  }
  assert.equal((await first.opportunityStore.listByUser(OWNER)).length, 3);
  for (const deadline of ['2026-02-30', '明天', 123, '2027-13-01']) {
    const out = JSON.parse(await executeCloudTool('save_opportunity', save('非法日期', deadline), { userId: OWNER, taskId: 'unused', opportunityStore: first.opportunityStore }));
    assert.equal(out.class, 'tool_validation');
  }
  assert.equal((await first.opportunityStore.listByUser(OWNER)).length, 3);
});

test('Worker：同一机会参数修正后真正保存成功，不再误报整轮失败，保留两次审计事件', async () => {
  const ctx = contextFor(), task = await ctx.store.createTask({ userId: OWNER, title: '保存未知日期机会' });
  await new Worker({ store: ctx.store, transport: transport([{ toolCalls: [call('bad', save('同一机会', 123))] }, { toolCalls: [call('good', save())] }, { content: '已保存到机会雷达，日期未知留空。' }]), tools: CLOUD_TOOLS, buildSystem: () => 's', executeTool: (_task, name, args) => executeCloudTool(name, args, { userId: OWNER, taskId: task.id, opportunityStore: ctx.opportunityStore }) }).tick();
  const done = await ctx.store.getTask(task.id), events = await ctx.store.listEvents(task.id);
  assert.equal(done?.status, 'succeeded', done?.error);
  assert.equal((await ctx.opportunityStore.listByUser(OWNER)).length, 1);
  assert.deepEqual(events.filter(e => e.type === 'tool.result').map(e => e.payload.ok), [false, true]);
  assert.equal(events.filter(e => e.type === 'tool.recovered').length, 1);
  assert.match(done?.result?.certificate?.criteria.find(c => c.id === 'runtime_execution')?.note ?? '', /成功重试恢复/);
});

test('成功保存B不掩盖A的失败；工具失败不能标成模型不可达', async () => {
  const ctx = contextFor(), task = await ctx.store.createTask({ userId: OWNER, title: '两条不同机会' });
  await new Worker({ store: ctx.store, transport: transport([{ toolCalls: [call('bad', save('机会A', 123))] }, { toolCalls: [call('good', save('机会B'))] }, { content: '仅B保存成功。' }]), tools: CLOUD_TOOLS, buildSystem: () => 's', executeTool: (_task, name, args) => executeCloudTool(name, args, { userId: OWNER, taskId: task.id, opportunityStore: ctx.opportunityStore }) }).tick();
  const done = await ctx.store.getTask(task.id); assert.equal(done?.status, 'failed');
  assert.equal(done?.result?.certificate?.criteria.find(c => c.id === 'model_reachable')?.passed, true);
  assert.match(done?.error ?? '', /仍有1次工具失败未恢复/); assert.doesNotMatch(done?.error ?? '', /模型不可达/);
});

test('只匹配同一操作，不跨来源/格式/目标吞错；不确定副作用始终保留', () => {
  assert.equal(assessToolOutcomes(observations()).count, 0);
  assert.equal(assessToolOutcomes(observations(save('A'), save('B'))).count, 1);
  assert.equal(assessToolOutcomes(observations(save(), { ...save(), sourceUrl: 'https://other.example' })).count, 1);
  assert.equal(assessToolOutcomes(observations({ artifactId: 'doc', format: 'pdf' }, { artifactId: 'doc', format: 'docx' }, '{"error":"no browser"}', 'document_export')).count, 1);
  assert.equal(assessToolOutcomes(observations(save(), save(), '{"error":"timeout","class":"tool_result_uncertain"}')).count, 1);
  assert.equal(assessToolOutcomes(observations(), 3).count, 2);
});

test('恢复旧checkpoint：失败原文可证明已恢复时清零；缺失的旧错误不能清零', async () => {
  const old: ChatMessage[] = [ { role: 'assistant', content: '', tool_calls: [call('failed', save())] }, { role: 'tool', content: '{"error":"temporary"}', tool_call_id: 'failed' } ];
  const checkpoints: number[] = [];
  const result = await runAgentLoop({ system: 's', user: '继续', resumeTranscript: old, resumeMessages: old, resumeToolErrors: 1, deps: { transport: transport([{ toolCalls: [call('retry', save())] }, { content: '重试成功' }]), tools: CLOUD_TOOLS, budget: DEFAULT_BUDGET, executeTool: async () => '{"ok":true}', hooks: { onCheckpoint: state => { checkpoints.push(state.toolErrors ?? -1); } } } });
  assert.equal(result.toolErrors, 0); assert.equal(checkpoints.at(-1), 0);
  assert.equal(assessToolOutcomes([], 1).count, 1);
});

test('JSON工具回退的失败与成功重试同样能够配对，不能把pending算成功', async () => {
  const result = await runAgentLoop({ system: 's', user: '保存', deps: { transport: transport([{ content: JSON.stringify({ tool: 'save_opportunity', args: save('同一机会', 123) }) }, { content: JSON.stringify({ tool: 'save_opportunity', args: save() }) }, { content: '已保存' }]), tools: CLOUD_TOOLS, budget: DEFAULT_BUDGET, executeTool: async () => '{"ok":true}' } });
  assert.equal(result.toolErrors, 0);
  const rows = observations(); rows[3].content = '{"error":"等待审批","__approval_pending__":true}';
  assert.equal(assessToolOutcomes(rows).count, 1);
});

test('进度摘要区分日期参数、检索质量、不确定副作用；不暴露上游凭证', () => {
  assert.match(toolResultView('{"error":"工具参数无效：args.deadline类型应为string/null"}').summary, /args.deadline/);
  assert.match(toolResultView('{"error":"secret-provider-key-123","class":"tool_result_uncertain"}').summary, /未确认/);
  assert.doesNotMatch(toolResultView('{"error":"secret-provider-key-123"}').summary, /secret/);
  assert.equal(toolResultView('{"results":[],"warning":"x","quality":"degraded"}').warning, true);
});
