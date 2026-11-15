import { test } from "node:test";
import assert from "node:assert/strict";
import { planGoal, defaultAcceptance, freezeAcceptance, revisePlan, validateDag, nextReadyStep, transitionStep } from "./planner.ts";

test("业务任务默认非空验收（不退化为文本即完成）", () => {
  assert.ok(defaultAcceptance("info").length >= 1);
  assert.ok(defaultAcceptance("opportunity").some((c) => c.kind === "evidence_verified"));
  assert.ok(defaultAcceptance("plan").some((c) => c.kind === "no_expired"));
  const p = planGoal("收集竞赛", "opportunity");
  assert.ok(p.steps.some((s) => s.acceptance.length > 0));
});

test("planGoal 生成 DAG（依赖存在、无环）", () => {
  const p = planGoal("收集竞赛", "info");
  assert.equal(p.steps.length, 3);
  assert.equal(validateDag(p.steps).ok, true);
  assert.ok(p.steps[1].dependsOn.includes(p.steps[0].id));
});

test("validateDag 检测环与缺失依赖", () => {
  const p = planGoal("x");
  const cyclic = p.steps.map((s, i) => ({ ...s, dependsOn: [p.steps[(i + 1) % p.steps.length].id] }));
  assert.equal(validateDag(cyclic).ok, false);
  const missing = [{ ...p.steps[0], dependsOn: ["nonexistent"] }];
  assert.match(validateDag(missing).reason ?? "", /依赖不存在/);
});

test("验收冻结 + Plan Revision 升版本", () => {
  const p = planGoal("x");
  assert.equal(p.acceptanceFrozen, false);
  const frozen = freezeAcceptance(p);
  assert.equal(frozen.acceptanceFrozen, true);
  const revised = revisePlan(frozen, frozen.steps);
  assert.equal(revised.version, 2);
  assert.equal(revised.acceptanceFrozen, false);
});

test("nextReadyStep 依赖门控 + 并发1（取 seq 最小）", () => {
  let p = planGoal("x");
  const first = nextReadyStep(p);
  assert.equal(first?.seq, 1); // 只有 s1 无依赖
  p = transitionStep(p, first!.id, "ready");
  p = transitionStep(p, first!.id, "running");
  p = transitionStep(p, first!.id, "succeeded");
  const second = nextReadyStep(p);
  assert.equal(second?.seq, 2); // s1 完成后 s2 就绪
});

test("Runtime 状态转换：非法转换抛错（模型不得直接改）", () => {
  const p = planGoal("x");
  assert.throws(() => transitionStep(p, p.steps[0].id, "succeeded"), /非法步骤状态转换/); // pending→succeeded 非法
});