import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DeepSeekTransport } from './llm.ts';
import { generationPolicy } from './generation-policy.ts';
import { runAgentLoop } from './agent-loop.ts';
import { CLOUD_TOOLS, executeCloudTool } from './cloud-tools.ts';
import { DEFAULT_BUDGET, type ChatMessage, type CheckpointState } from './types.ts';
import { messagesTokens, trimToBudget } from './context.ts';
import { storageFixture, OWNER, OTHER } from '../runtime/storage-test-fixture.ts';
import { sessionHistory } from './session-context.ts';
import { Worker } from '../runtime/worker.ts';
import { createApiServer } from '../api/server.ts';
import { signJwt } from '../api/jwt.ts';

const caps = { tools: 'native', reasoning: 'deepseek_thinking', outputParameter: 'max_tokens' };
const trace = 'server-only-fixture-continuation';
function reply(content: string, reasoning: string, tool = false) {
  return new Response(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: tool ? 'tool_calls' : 'stop', message: { content, reasoning_content: reasoning, ...(tool ? { tool_calls: [{ id: 'fixture-tool', type: 'function', function: { name: 'create_daily_task', arguments: '{"title":"思考协议测试班会","dueAt":"2026-11-20"}' } }] } : {}) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } });
}
test('DeepSeek自动/低/中/高均启用思考，映射low/high/max并报告预算降档', () => {
  for (const [preference, effort] of [['low', 'low'], ['medium', 'high'], ['high', 'max']]) {
    const policy = generationPolicy(caps, preference, 'simple', 8192);
    assert.deepEqual(policy.params, { thinking: { type: 'enabled' }, reasoning_effort: effort }); assert.equal(policy.effective, effort);
  }
  assert.equal(generationPolicy(caps, 'auto', 'simple', 8192).effective, 'low');
  assert.equal(generationPolicy(caps, 'auto', 'verify', 8192).effective, 'max');
  assert.equal(generationPolicy(caps, 'high', 'plan', 512).effective, 'high');
});
test('原生工具轮次完整回传思考；新transport/其他模型不误用续接内容', async () => {
  let calls = 0; const bodies: any[] = [], deltas: string[] = [];
  const transport = new DeepSeekTransport({ apiKey: 'fixture-secret', model: 'deepseek-flash', capabilities: { ...caps, thinking: false }, fetchImpl: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    assert.equal(body.thinking.type, 'enabled');
    if (calls++ === 0) return reply('', trace, true);
    const assistant = body.messages.find((m: any) => m.tool_calls?.length);
    assert.equal(assistant.reasoning_content, trace); assert.equal(assistant.reasoning_source, undefined);
    assert(body.messages.some((m: any) => m.role === 'tool')); return reply('已保存', trace + '-final');
  } });
  const out = await runAgentLoop({ system: 'fixture', user: '创建班会', deps: { transport, budget: DEFAULT_BUDGET, tools: CLOUD_TOOLS, executeTool: async () => '{"ok":true}', hooks: { onEvent: (type, payload) => { deltas.push(JSON.stringify({ type, payload })); } } } });
  assert.equal(out.reply, '已保存'); assert(!JSON.stringify(deltas).includes(trace));
  assert.equal(out.transcript.at(-1)?.reasoning_content, trace + '-final');
  const wire = async (model: string, reasoning: string) => {
    let body: any;
    const next = new DeepSeekTransport({ apiKey: 'fixture-secret', model, capabilities: { ...caps, reasoning }, fetchImpl: async (_url, init) => { body = JSON.parse(String(init?.body)); return reply('继续', 'next'); } });
    await next.chat({ messages: out.transcript, tools: CLOUD_TOOLS }); return body;
  };
  const same = await wire('deepseek-flash', 'deepseek_thinking'); assert(same.messages.some((m: any) => m.reasoning_content === trace));
  const different = await wire('different-model', 'deepseek_thinking'); assert(!JSON.stringify(different).includes(trace));
  const generic = await wire('generic-model', 'reasoning_effort'); assert(!JSON.stringify(generic).includes('reasoning_content'));
});
test('SSE分片保存思考但不输出到正文/事件；旧普通回复显式空续接', async () => {
  const frame = (data: unknown) => 'data: ' + JSON.stringify(data) + '\n\n';
  const stream = frame({ choices: [{ delta: { reasoning_content: 'server-only-' } }] }) + frame({ choices: [{ delta: { reasoning_content: 'continuation', content: '正文' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  const visible: string[] = [];
  const transport = new DeepSeekTransport({ apiKey: 'fixture-secret', capabilities: { ...caps, streaming: true }, fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)); assert.equal(body.messages[0].reasoning_content, ''); return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }); } });
  const result = await transport.chat({ messages: [{ role: 'assistant', content: '旧的非思考回复' }], onDelta: text => { visible.push(text); } });
  assert.equal(result.reasoningContent, 'server-only-continuation'); assert.equal(result.content, '正文'); assert.equal(visible.join(''), '正文');
  const base: ChatMessage = { role: 'assistant', content: '正文' };
  assert(messagesTokens([{ ...base, reasoning_content: trace }]) > messagesTokens([base]));
  const kept = trimToBudget([{ role: 'system', content: 'instructions' }, { ...base, reasoning_content: trace }], 20000, 0, 1000);
  assert.equal(kept.messages.at(-1)?.reasoning_content, trace);
});
test('checkpoint恢复可继续原生工具轮次，不丢思考、不重复执行副作用', async () => {
  let checkpoint: CheckpointState | undefined, executions = 0;
  const first = new DeepSeekTransport({ apiKey: 'fixture-secret', model: 'deepseek-flash', capabilities: caps, fetchImpl: async () => reply('', trace, true) });
  const paused = await runAgentLoop({ system: 'fixture', user: '创建班会', deps: { transport: first, tools: CLOUD_TOOLS, budget: { ...DEFAULT_BUDGET, toolCalls: 1 }, executeTool: async () => { executions++; return '{"ok":true}'; }, hooks: { onCheckpoint: state => { checkpoint = structuredClone(state); } } } });
  assert(paused.budgetExceeded); assert(checkpoint); assert(JSON.stringify(checkpoint.messages).includes(trace));
  const resumed = new DeepSeekTransport({ apiKey: 'fixture-secret', model: 'deepseek-flash', capabilities: caps, fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)); assert(body.messages.some((m: any) => m.reasoning_content === trace)); return reply('恢复完成', trace + '-resumed'); } });
  const result = await runAgentLoop({ system: 'fixture', user: '创建班会', resumeMessages: checkpoint.messages, resumeTranscript: checkpoint.transcript, initialUsage: checkpoint.usage, deps: { transport: resumed, tools: CLOUD_TOOLS, budget: DEFAULT_BUDGET, executeTool: async () => { executions++; return '{"ok":true}'; } } });
  assert.equal(result.reply, '恢复完成'); assert.equal(executions, 1);
});
test('SQL重建后跨轮保留思考；API/最终回复/事件不泄漏私有上下文，其他账号隔离', async t => {
  const { first: ctx, second, pool } = await storageFixture(t);
  const session = await ctx.sessionStore.create({ userId: OWNER });
  const created = await ctx.store.createSessionTask!({ userId: OWNER, sessionId: session.id, turnId: randomUUID(), title: '创建班会' }, ctx.sessionStore);
  let step = 0;
  const transport = new DeepSeekTransport({ apiKey: 'fixture-secret', model: 'deepseek-flash', capabilities: caps, fetchImpl: async () => step++ === 0 ? reply('', trace, true) : reply('班会已保存', trace + '-final') });
  await new Worker({ store: ctx.store, sessionStore: ctx.sessionStore, transport, tools: CLOUD_TOOLS, capabilityRegistry: ctx.capabilityRegistry, buildSystem: () => 'fixture', executeTool: (task, name, args) => executeCloudTool(name, args, { userId: task.userId, taskId: task.id, businessStore: ctx.businessStore }), concurrency: 1 }).tick();
  const saved = await second.store.getTask(created.task.id); assert.equal(saved?.status, 'succeeded');
  const rows = await second.sessionStore.listMessages(OWNER, session.id);
  assert(rows.some(m => m.reasoning_content === trace)); assert(rows.some(m => m.reasoning_content === trace + '-final'));
  assert.equal((await second.sessionStore.listMessages(OTHER, session.id)).length, 0);
  const next = await second.store.createSessionTask!({ userId: OWNER, sessionId: session.id, turnId: randomUUID(), title: '再问一轮' }, second.sessionStore);
  const history = sessionHistory(rows, await second.store.listTasksByUser(OWNER), next.task);
  assert(history.some(m => m.reasoning_content === trace));
  const check = new DeepSeekTransport({ apiKey: 'fixture-secret', model: 'deepseek-flash', capabilities: caps, fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)); assert(body.messages.some((m: any) => m.reasoning_content === trace + '-final')); return reply('连续对话成功', trace + '-second'); } });
  await new Worker({ store: second.store, sessionStore: second.sessionStore, transport: check, tools: CLOUD_TOOLS, buildSystem: () => 'fixture', executeTool: async () => '{"ok":true}', concurrency: 1 }).tick();
  assert.equal((await second.store.getTask(next.task.id))?.status, 'succeeded');
  assert(!JSON.stringify((await second.store.getTask(next.task.id))?.result).includes(trace));
  assert(!JSON.stringify(await second.store.listEvents(next.task.id)).includes(trace));
  assert((await pool.query("select id from agent_session_messages where user_id=$1 and content ? 'reasoning_content'", [OWNER])).rows.length >= 3);
  const server = createApiServer({ store: second.store, sessionStore: second.sessionStore, jwtSecret: 'fixture-jwt' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const token = signJwt({ sub: OWNER, exp: Date.now() / 1000 + 60 }, 'fixture-jwt');
  const response = await fetch(`${base}/v1/sessions/${session.id}/messages`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text(); assert.equal(response.status, 200); assert(!text.includes(trace)); assert(!text.includes('reasoning_content')); assert(!text.includes('reasoning_source'));
});

test('SQL checkpoint暂停后重建Worker继续思考，已保存待办不重复执行', async t => {
  const { first: ctx, second, pool } = await storageFixture(t);
  const session = await ctx.sessionStore.create({ userId: OWNER });
  const { task } = await ctx.store.createSessionTask!({ userId: OWNER, sessionId: session.id, turnId: randomUUID(), title: '暂停恢复班会', budget: { ...DEFAULT_BUDGET, toolCalls: 1 } }, ctx.sessionStore);
  let executions = 0;
  const initial = new DeepSeekTransport({ apiKey: 'fixture-secret', model: 'deepseek-flash', capabilities: caps, fetchImpl: async () => reply('', trace, true) });
  const execute = async (task: { id: string; userId: string }, name: string, args: Record<string, unknown>) => { executions++; return executeCloudTool(name, args, { taskId: task.id, userId: task.userId, businessStore: ctx.businessStore }); };
  await new Worker({ store: ctx.store, sessionStore: ctx.sessionStore, transport: initial, tools: CLOUD_TOOLS, buildSystem: () => 'fixture', executeTool: execute, concurrency: 1 }).tick();
  assert.equal((await ctx.store.getTask(task.id))?.status, 'paused');
  const checkpoint = await second.store.latestCheckpoint(task.id); assert(checkpoint); assert(JSON.stringify(checkpoint.state.messages).includes(trace));
  await second.store.resumeSessionTask!(task.id, OWNER, DEFAULT_BUDGET);
  const resumed = new DeepSeekTransport({ apiKey: 'fixture-secret', model: 'deepseek-flash', capabilities: caps, fetchImpl: async (_url, init) => { const body = JSON.parse(String(init?.body)); assert(body.messages.some((m: any) => m.reasoning_content === trace)); return reply('恢复后完成', trace + '-resumed'); } });
  await new Worker({ store: second.store, sessionStore: second.sessionStore, transport: resumed, tools: CLOUD_TOOLS, buildSystem: () => 'fixture', executeTool: execute, concurrency: 1 }).tick();
  assert.equal((await second.store.getTask(task.id))?.status, 'succeeded'); assert.equal(executions, 1);
  assert.equal((await pool.query('select id from tasks where user_id=$1', [OWNER])).rows.length, 1);
});
