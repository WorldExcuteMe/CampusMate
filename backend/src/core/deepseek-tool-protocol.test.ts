import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR, protocolSafeStream } from '../../../shared/tool-protocol.ts';
import { runAgentLoop } from './agent-loop.ts';
import { DeepSeekTransport } from './llm.ts';
import { CLOUD_TOOLS } from './cloud-tools.ts';
import { DEFAULT_BUDGET } from './types.ts';
import { buildContext, createApiServer } from '../app-context.ts';
import { signJwt } from '../api/jwt.ts';

const DSML = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="create_daily_task">\n<｜｜DSML｜｜ parameter name="args" string="false">{"title":"参加班会","dueAt":"2026-11-20"}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
test('DSML正文、截断和混合响应不执行、不回显、不冒充成功', async () => {
  for (const truncated of [false, true]) for (const mixed of [false, true]) {
    let calls = 0;
    const result = await runAgentLoop({ system: 'fixture', user: '创建班会待办', deps: { budget: DEFAULT_BUDGET, tools: CLOUD_TOOLS, executeTool: async () => { calls++; return '{"ok":true}'; }, transport: { chat: async () => ({ content: DSML, toolCalls: mixed ? [{ id: 'mix', type: 'function', function: { name: 'create_daily_task', arguments: '{"title":"不执行"}' } }] : [], usage: { input: 1, output: 1 }, model: 'fixture', truncated }) } } });
    assert.equal(calls, 0); assert.equal(result.error, 'tool_protocol_error'); assert.equal(result.reply, TOOL_PROTOCOL_ERROR);
    assert(!hasRawToolMarkup(result.reply));
  }
});
test('DSML任意字符分片不会泄漏到流式正文，普通回复仍可流式输出', () => {
  for (let size = 1; size < 24; size++) {
    let visible = ''; const safe = protocolSafeStream(text => { visible += text; });
    for (let i = 0; i < DSML.length; i += size) safe.push(DSML.slice(i, i + size));
    safe.finish(); assert.equal(visible, '');
  }
  let visible = ''; const safe = protocolSafeStream(text => { visible += text; }); safe.push('正常正文'); safe.finish(); assert.equal(visible, '正常正文');
});
test('已确认原生tools/tool_calls经过真实executor；显式关闭思考避免丢弃思考上下文', async () => {
  const requests: any[] = [];
  const transport = new DeepSeekTransport({ apiKey: 'fixture-key', capabilities: { tools: 'native', thinking: false, outputParameter: 'max_tokens' }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return new Response(JSON.stringify({ model: 'fixture-native', choices: [{ finish_reason: requests.length === 1 ? 'tool_calls' : 'stop', message: requests.length === 1 ? { content: '', tool_calls: [{ id: 'native-test', type: 'function', function: { name: 'create_daily_task', arguments: '{"title":"参加班会","dueAt":"2026-11-20"}' } }] } : { content: '待办已保存。' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  let executions = 0;
  const result = await runAgentLoop({ system: 'fixture', user: '创建班会待办', deps: { transport, tools: CLOUD_TOOLS, budget: DEFAULT_BUDGET, executeTool: async (name, args) => { assert.equal(name, 'create_daily_task'); assert.equal(args.dueAt, '2026-11-20'); executions++; return '{"ok":true,"taskId":"saved-fixture"}'; } } });
  assert.equal(executions, 1); assert.equal(result.reply, '待办已保存。');
  assert(requests[0].tools.some((t: any) => t.function.name === 'create_daily_task')); assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert(requests[1].messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'native-test'));
  assert(!requests[0].messages.some((m: any) => typeof m.content === 'string' && m.content.includes('工具协议：需要工具时仅输出JSON')));
});
test('API不再把历史DSML记录呈现为成功，不改原始审计记录、不重放', async t => {
  const ctx = buildContext({}), task = await ctx.store.createTask({ userId: 'fixture-owner', title: '旧的协议异常' });
  await ctx.store.updateTask(task.id, { status: 'running' });
  await ctx.store.updateTask(task.id, { status: 'succeeded', result: { summary: DSML, artifactIds: [], partial: false } });
  const server = createApiServer({ store: ctx.store, jwtSecret: 'fixture-secret' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as import('node:net').AddressInfo;
  const token = signJwt({ sub: 'fixture-owner', exp: Math.floor(Date.now() / 1000) + 60 }, 'fixture-secret');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/tasks/${task.id}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); const body = await response.json() as any;
  assert.equal(body.task.status, 'failed'); assert.equal(body.task.result.completion.reason, 'tool_protocol_error'); assert(!hasRawToolMarkup(body.task.result.summary));
  assert.equal((await ctx.store.getTask(task.id))!.status, 'succeeded');
});
