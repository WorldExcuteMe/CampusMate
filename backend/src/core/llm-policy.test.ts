import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekTransport } from "./llm.ts";

const reply = (usage?: unknown, finish = "stop") => new Response(JSON.stringify({ model: "actual", choices: [{ message: { content: "完成" }, finish_reason: finish }], ...(usage ? { usage } : {}) }));
test("端点能力而非模型正则决定参数，high生效，缺失usage保留null", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return reply(); };
  const t = new DeepSeekTransport({ apiKey: "fixture", model: "Gemma-any-name", capabilities: { reasoning: "reasoning_effort", temperature: false, outputParameter: "max_completion_tokens", maxOutputTokens: 4000 }, fetchImpl });
  const result = await t.chat({ messages: [{ role: "user", content: "规划" }], reasoning: "high", maxOutputTokens: 2000, stage: "plan" });
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.equal(bodies[0].max_completion_tokens, 2000);
  assert.ok(!("temperature" in bodies[0]));
  assert.equal(result.telemetry?.usage.inputTotal, null);
  assert.equal(result.telemetry?.usage.cacheRead, null);
  const unknown = new DeepSeekTransport({ apiKey: "fixture", model: "qwen-new", capabilities: {}, fetchImpl });
  await unknown.chat({ messages: [], reasoning: "high" });
  assert.ok(!("enable_thinking" in bodies[1]) && !("reasoning_effort" in bodies[1]));
});
test("cache与reasoning是usage分量，0和缺失可区分，不重复计数", async () => {
  const t = new DeepSeekTransport({ apiKey: "fixture", fetchImpl: async () => reply({ prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } }) });
  const result = await t.chat({ messages: [] });
  assert.equal(result.telemetry?.usage.cacheRead, 0);
  assert.equal(result.telemetry?.usage.cacheWrite, null);
  assert.equal(result.telemetry?.usage.reasoning, 20);
  assert.equal(result.usage.input + result.usage.output, 130);
});
test("总deadline覆盖慢响应体，401不重试", async () => {
  let calls = 0;
  const slow = new DeepSeekTransport({ apiKey: "fixture", timeoutMs: 20, maxRetries: 0, fetchImpl: async () => ({ ok: true, status: 200, text: async () => { await new Promise((r) => setTimeout(r, 120)); return await reply().text(); } }) as Response });
  const started = Date.now();
  await assert.rejects(() => slow.chat({ messages: [] }), /超时|deadline|abort/i);
  assert.ok(Date.now() - started < 100);
  const unauthorized = new DeepSeekTransport({ apiKey: "fixture", maxRetries: 2, fetchImpl: async () => { calls++; return new Response('{"error":{"message":"invalid key"}}', { status: 401 }); } });
  await assert.rejects(() => unauthorized.chat({ messages: [] }), /401/);
  assert.equal(calls, 1);
});
test("SSE只消费正文，拼接工具delta，断流和length为未完成", async () => {
  const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
  const stream = chunk({ model: "stream-model", choices: [{ delta: { content: "正文", reasoning_content: "私密思维" } }] }) + chunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 5 } }) + "data: [DONE]\n\n";
  const deltas: string[] = [];
  const t = new DeepSeekTransport({ apiKey: "fixture", capabilities: { streaming: true }, fetchImpl: async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }) });
  const result = await t.chat({ messages: [], onDelta: (text) => { deltas.push(text); } });
  assert.equal(result.content, "正文");
  assert.deepEqual(deltas, ["正文"]);
  assert.ok(!JSON.stringify(result).includes("私密思维"));
  const broken = new DeepSeekTransport({ apiKey: "fixture", capabilities: { streaming: true }, fetchImpl: async () => new Response(chunk({ choices: [{ delta: { content: "草稿" } }] }), { headers: { "Content-Type": "text/event-stream" } }) });
  assert.equal((await broken.chat({ messages: [] })).truncated, true);
  const length = new DeepSeekTransport({ apiKey: "fixture", fetchImpl: async () => reply({}, "length") });
  assert.equal((await length.chat({ messages: [] })).truncated, true);
  const toolsStream = chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":' } }] } }] }) + chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"竞赛"}' } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
  const tools = new DeepSeekTransport({ apiKey: "fixture", capabilities: { streaming: true }, fetchImpl: async () => new Response(toolsStream, { headers: { "Content-Type": "text/event-stream" } }) });
  assert.deepEqual((await tools.chat({ messages: [] })).toolCalls, [{ id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"竞赛"}' } }]);
});
test("Retry-After受总deadline约束，错误也保留实际attempt", async () => {
  let calls = 0;
  const rateLimit = new DeepSeekTransport({ apiKey: "fixture", maxRetries: 2, timeoutMs: 40, fetchImpl: async () => { calls++; return new Response("{}", { status: 429, headers: { "Retry-After": "1" } }); } });
  await assert.rejects(() => rateLimit.chat({ messages: [] }), (error: any) => { assert.equal(error.telemetry.attempts, 1); assert.equal(error.telemetry.usage.inputTotal, null); return /deadline/.test(error.message); });
  assert.equal(calls, 1);
  calls = 0;
  const retry = new DeepSeekTransport({ apiKey: "fixture", maxRetries: 2, fetchImpl: async () => { calls++; return calls < 3 ? new Response("{}", { status: 503, headers: { "Retry-After": "0" } }) : reply(); } });
  assert.equal((await retry.chat({ messages: [] })).telemetry?.attempts, 3);
  assert.equal(calls, 3);
});
