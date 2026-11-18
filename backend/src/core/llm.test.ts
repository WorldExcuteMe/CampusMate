import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSeekTransport, reasoningParams } from "./llm.ts";
import { isTransportError } from "./errors.ts";

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

test("reasoningParams 按模型映射安全参数", () => {
  assert.deepEqual(reasoningParams("o3-mini", "medium"), { reasoning_effort: "medium" });
  assert.deepEqual(reasoningParams("qwen-max", "low"), { enable_thinking: false });
  assert.deepEqual(reasoningParams("deepseek-chat", "high"), {});
});

test("DeepSeekTransport 解析 content/toolCalls/usage", async () => {
  const fetchImpl = (async () => res(200, {
    choices: [{ message: { content: "你好", tool_calls: [] } }],
    usage: { prompt_tokens: 3, completion_tokens: 5 }, model: "deepseek-flash",
  })) as unknown as typeof fetch;
  const t = new DeepSeekTransport({ apiKey: "k", fetchImpl });
  const r = await t.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.content, "你好");
  assert.equal(r.model, "deepseek-flash");
  assert.deepEqual(r.usage, { input: 3, output: 5 });
});

test("503 退避重试后成功", async () => {
  let n = 0;
  const fetchImpl = (async () => { n++; return n < 2 ? res(503, { error: "busy" }) : res(200, { choices: [{ message: { content: "ok" } }], usage: {} }); }) as unknown as typeof fetch;
  const t = new DeepSeekTransport({ apiKey: "k", fetchImpl, maxRetries: 3 });
  const r = await t.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.content, "ok");
  assert.equal(n, 2);
});

test("上游错误对象 → 可读 LlmTransportError（非 [object Object]）", async () => {
  const fetchImpl = (async () => res(401, { error: { message: "invalid api key", code: "invalid_api_key" } })) as unknown as typeof fetch;
  const t = new DeepSeekTransport({ apiKey: "k", fetchImpl, maxRetries: 0 });
  await assert.rejects(() => t.chat({ messages: [{ role: "user", content: "hi" }] }), (e: unknown) => {
    assert.equal(isTransportError(e), true);
    assert.match((e as Error).message, /invalid api key/);
    assert.ok(!(e as Error).message.includes("[object Object]"));
    return true;
  });
});

test("非 JSON 响应 → LlmTransportError", async () => {
  const fetchImpl = (async () => ({ ok: true, status: 200, text: async () => "<html>not json</html>" })) as unknown as typeof fetch;
  const t = new DeepSeekTransport({ apiKey: "k", fetchImpl, maxRetries: 0 });
  await assert.rejects(() => t.chat({ messages: [{ role: "user", content: "hi" }] }), (e: unknown) => isTransportError(e));
});

test("缺密钥构造即抛错", () => {
  assert.throws(() => new DeepSeekTransport({ apiKey: "" }), /LLM_API_KEY missing/);
});

test("上游回显凭证被清除，缺失真实model保持unknown，协议错误拒绝", async () => {
  const key = "dummy-sensitive-credential";
  const t = new DeepSeekTransport({ apiKey: key, maxRetries: 0, fetchImpl: async () => res(200, { choices: [{ message: { content: `echo ${key}` } }] }) });
  const reply = await t.chat({ messages: [] });
  assert.ok(!JSON.stringify(reply).includes(key));
  assert.equal(reply.model, "unknown");
  const bad = new DeepSeekTransport({ apiKey: key, maxRetries: 0, fetchImpl: async () => res(200, { status: "ok" }) });
  await assert.rejects(() => bad.chat({ messages: [] }), /协议无效/);
});

test("供应商响应ID与USD金额进入telemetry，可与用量明细精确对齐", async () => {
  const fetchImpl = (async () => res(200, {
    id: "req-provider-123",
    choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 2, cost: 0.000021, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    model: "self-dploy/DeepSeek-V4-Flash",
  })) as unknown as typeof fetch;
  const t = new DeepSeekTransport({ apiKey: "k", fetchImpl, maxRetries: 0 });
  const r = await t.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.telemetry?.providerRequestId, "req-provider-123");
  assert.equal(r.telemetry?.usage.costUsd, 0.000021);
  assert.equal(r.telemetry?.usage.cacheRead, 0);
  assert.equal(r.telemetry?.usage.cacheWrite, 0);
});

test("用量缺少金额字段时costUsd保持未知，不按猜测价格折算", async () => {
  const fetchImpl = (async () => res(200, { choices: [{ message: { content: "ok", tool_calls: [] } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })) as unknown as typeof fetch;
  const t = new DeepSeekTransport({ apiKey: "k", fetchImpl, maxRetries: 0 });
  const r = await t.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.telemetry?.usage.costUsd, null);
  assert.equal(r.telemetry?.providerRequestId, null);
});
