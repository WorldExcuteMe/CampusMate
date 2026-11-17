import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { DeepSeekTransport } from "./llm.ts";

const frame = (delta: unknown, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
function fixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const transport = new DeepSeekTransport({ apiKey: "fixture", timeoutMs: 100, maxRetries: 0, capabilities: { streaming: true }, fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
  return { transport, send: (s: string) => controller.enqueue(new TextEncoder().encode(s)) };
}

test("active SSE generation may exceed the connection timeout within the caller's task deadline", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture(), result = f.transport.chat({ messages: [], deadlineAt: Date.now() + 500 });
  await setImmediate();
  for (const text of ["第", "一", "章"]) { t.mock.timers.tick(80); f.send(frame({ content: text })); await setImmediate(); }
  f.send(frame({}, "stop") + "data: [DONE]\n\n");
  const r = await result;
  assert.equal(r.content, "第一章"); assert.equal(r.truncated, false);
});

test("empty heartbeat frames cannot keep an unresponsive model alive", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture();
  const failed = assert.rejects(f.transport.chat({ messages: [], deadlineAt: Date.now() + 500 }), (e: any) => e.reason === "timeout");
  await setImmediate(); t.mock.timers.tick(80); f.send(frame({ role: "assistant", content: "" })); await setImmediate();
  t.mock.timers.tick(30); await failed;
});

test("stream progress never extends the task deadline or ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture(), result = f.transport.chat({ messages: [], deadlineAt: Date.now() + 150 });
  await setImmediate(); t.mock.timers.tick(80); f.send(frame({ content: "草稿" })); await setImmediate();
  t.mock.timers.tick(80); assert.equal((await result).truncated, true);
  const g = fixture(), cancel = new AbortController();
  const cancelled = assert.rejects(g.transport.chat({ messages: [], deadlineAt: Date.now() + 500, signal: cancel.signal }), (e: any) => e.reason === "cancelled");
  await setImmediate(); cancel.abort(); await cancelled;
});

test("tool argument deltas count as progress and standalone requests keep their total timeout", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture(), result = f.transport.chat({ messages: [], deadlineAt: Date.now() + 500 });
  await setImmediate(); t.mock.timers.tick(80); f.send(frame({ tool_calls: [{ index: 0, id: "a", function: { name: "document_create", arguments: '{"content":' } }] })); await setImmediate();
  t.mock.timers.tick(80); f.send(frame({ tool_calls: [{ index: 0, function: { arguments: '"正文"}' } }] }, "tool_calls") + "data: [DONE]\n\n");
  assert.equal((await result).truncated, false);
  const g = fixture(), bounded = g.transport.chat({ messages: [] });
  await setImmediate(); t.mock.timers.tick(80); g.send(frame({ content: "正文" })); await setImmediate();
  t.mock.timers.tick(30); assert.equal((await bounded).truncated, true);
});
