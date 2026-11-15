import { test } from "node:test";
import assert from "node:assert/strict";
import { canTaskTransition, assertTaskTransition, canStepTransition, canMarkSucceeded } from "./state-machine.ts";
import { idempotencyKey, canonicalArgs, sha256 } from "./idempotency.ts";

test("任务状态机合法/非法转换", () => {
  assert.equal(canTaskTransition("queued", "running"), true);
  assert.equal(canTaskTransition("running", "succeeded"), true);
  assert.equal(canTaskTransition("succeeded", "running"), false);
  assert.equal(canTaskTransition("queued", "succeeded"), false);
  assert.throws(() => assertTaskTransition("succeeded", "running"), /非法任务状态转换/);
  assert.equal(canStepTransition("pending", "ready"), true);
  assert.equal(canStepTransition("succeeded", "running"), false);
});

test("succeeded 仅当 Evaluator 通过", () => {
  assert.equal(canMarkSucceeded(true), true);
  assert.equal(canMarkSucceeded(false), false);
});

test("canonicalArgs 键序无关", () => {
  assert.equal(canonicalArgs({ b: 1, a: 2 }), canonicalArgs({ a: 2, b: 1 }));
  assert.equal(sha256("x").length, 64);
});

test("幂等键：同自然键稳定，不同输入不同", () => {
  const ctx = { userId: "u1" };
  const a = idempotencyKey("save_to_inbox", { title: "竞赛讲座", deadline: "2026-11-20", source: "g1" }, ctx);
  const b = idempotencyKey("save_to_inbox", { title: "竞赛讲座", deadline: "2026-11-20", source: "g1" }, ctx);
  const c = idempotencyKey("save_to_inbox", { title: "另一个", deadline: "2026-11-20", source: "g1" }, ctx);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^inbox:u1:/);
  assert.match(idempotencyKey("create_opportunity", { title: "x", type: "competition" }, ctx), /^opp:/);
});