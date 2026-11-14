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