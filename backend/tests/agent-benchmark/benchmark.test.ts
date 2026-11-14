import { test } from "node:test";
import assert from "node:assert/strict";
import { runAll, computeMetrics, runCase } from "./runner.ts";
import { CASES } from "./cases.ts";
import { FailureLibrary, emptyRecord, CORE_CHALLENGE } from "./dogfooding.ts";

test("Benchmark 至少 30 个任务，覆盖 7 类", () => {
  assert.ok(CASES.length >= 30);
  const cats = new Set(CASES.map((c) => c.category));
  for (const k of ["planning", "long_horizon", "environment", "tool_reliability", "recovery", "evidence", "personalization"]) assert.ok(cats.has(k as never), k);
});

test("每个用例含完整元数据", () => {
  for (const c of CASES) {
    assert.ok(c.id && c.userGoal && c.environment);
    assert.ok(c.acceptanceCriteria.length >= 1);
    assert.ok(c.evaluationMethod);
  }
});

test("运行全部基准：确定性用例通过率 ≥ 90%", async () => {
  const results = await runAll();
  const m = computeMetrics(results);
  assert.equal(m.total, CASES.length);
  assert.ok(m.endToEndSuccessRate >= 0.9, `成功率 ${m.endToEndSuccessRate}`);
  assert.equal(m.failed, 0, `失败用例：${results.filter((r) => r.status === "FAILED").map((r) => r.id + ":" + r.failureReason).join(", ")}`);
});

test("Evidence 类确定性验证（非 LLM-judge）", async () => {
  const v01 = await runCase(CASES.find((c) => c.id === "V01")!);
  assert.equal(v01.status, "VERIFIED"); // propose_verification 调用 + 降级
  const v04 = await runCase(CASES.find((c) => c.id === "V04")!);
  assert.equal(v04.status, "VERIFIED"); // 冲突识别
});

test("Recovery 传输失败可读降级", async () => {
  const r01 = await runCase(CASES.find((c) => c.id === "R01")!);
  assert.equal(r01.status, "VERIFIED"); // mock 降级标记
});

test("指标聚合：分类/成本/时延/证据覆盖", async () => {
  const m = computeMetrics(await runAll());
  assert.ok(m.byCategory.planning.total >= 5);
  assert.ok(m.evidenceCoverage > 0);
  assert.ok(m.avgDurationMs >= 0);
  assert.ok(m.avgCostUsd >= 0);
});

test("Dogfooding 记录模板 + 失败库 → 回归", () => {
  const rec = emptyRecord("dev-a", "学校A");
  assert.equal(rec.userGoal, CORE_CHALLENGE);
  const lib = new FailureLibrary();
  lib.add({ id: "f1", taskId: "t1", category: "environment", symptom: "课表解析失败", rootCause: "未知格式", reproduction: "上传 x.xls", status: "open" });
  assert.equal(lib.open().length, 1);
  lib.markRegression("f1", "bench-E02");
  assert.equal(lib.get("f1")?.status, "regression_added");
  assert.equal(lib.open().length, 0);
});