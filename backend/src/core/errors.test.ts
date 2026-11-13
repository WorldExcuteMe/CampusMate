import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, isTransportError, LlmTransportError, classifyError, isRetryable } from "./errors.ts";

test("errorMessage 永不产出 [object Object]", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("invalid api key"), "invalid api key");
  const pg = { message: "duplicate key value", code: "23505", hint: "use upsert" };
  const s = errorMessage(pg);
  assert.match(s, /duplicate key value/);
  assert.match(s, /23505/);
  assert.ok(!s.includes("[object Object]"));
  const nested = errorMessage({ error: { message: "maximum context length exceeded" } });
  assert.match(nested, /maximum context length/);
  const circ: Record<string, unknown> = { a: 1 };
  circ.self = circ;
  assert.notEqual(errorMessage(circ), "[object Object]");
  assert.ok(!errorMessage(null).includes("[object Object]"));
});

test("LlmTransportError 分类", () => {
  assert.equal(isTransportError(new LlmTransportError("down")), true);
  assert.equal(isTransportError(new Error("db")), false);
  assert.equal(classifyError(new LlmTransportError("x")), "transport");
  assert.equal(classifyError(new Error("HTTP 429 too many requests")), "rate_limit");
  assert.equal(classifyError(new Error("401 invalid api key")), "permission");
  assert.equal(isRetryable("transport"), true);
  assert.equal(isRetryable("permission"), false);
});