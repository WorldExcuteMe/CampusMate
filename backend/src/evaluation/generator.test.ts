// 场景矩阵生成器单测：展开数量、占位替换、去重、截断、确定性、非法 blueprint、parseSuite 兼容。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseSuite } from "./dataset.ts";
import { expandBlueprint, validateBlueprint, writeGeneratedSuite } from "./generator.ts";
import type { Blueprint } from "./generator.ts";

function blueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    schemaVersion: 1,
    id: "matrix-demo",
    name: "演示场景矩阵",
    axes: { channel: ["群通知", "邮件"], goal: ["提取", "保存"] },
    template: {
      prompt: "请处理来自{{channel}}的校园通知，任务是{{goal}}，先说明依据再执行。",
      category: "planning",
      difficulty: "medium",
      tags: ["generated", "matrix"],
      acceptanceNotes: ["只验证回答可读与工具编排，不硬编码业务断言。"],
    },
    ...overrides,
  };
}

test("validateBlueprint：合法 blueprint 通过", () => {
  const result = validateBlueprint(blueprint());
  assert.deepEqual(result.errors, []);
  assert.ok(result.blueprint);
  assert.equal(result.blueprint.id, "matrix-demo");
  assert.deepEqual(result.blueprint.axes, { channel: ["群通知", "邮件"], goal: ["提取", "保存"] });
});

test("expandBlueprint：笛卡尔积展开数量与 case id 序号", () => {
  const suite = expandBlueprint(blueprint({
    axes: { a: ["1", "2", "3"], b: ["x", "y"] },
    template: { prompt: "组合 {{a}}-{{b}} 的问题。", category: "planning" },
  }));
  assert.equal(suite.cases.length, 6);
  assert.deepEqual(suite.cases.map((c) => c.id), [
    "matrix-demo-001", "matrix-demo-002", "matrix-demo-003",
    "matrix-demo-004", "matrix-demo-005", "matrix-demo-006",
  ]);
  assert.equal(suite.source, "generated");
  assert.ok(suite.cases.every((c) => c.source === "generated" && c.exploratory === true));
});

test("expandBlueprint：占位符全部替换，无 {{...}} 残留", () => {
  const suite = expandBlueprint(blueprint());
  assert.equal(suite.cases.length, 4);
  for (const c of suite.cases) {
    assert.ok(!c.prompt.includes("{{"), `prompt 仍有占位符：${c.prompt}`);
    assert.ok(c.prompt.includes("请处理来自"));
  }
  const prompts = suite.cases.map((c) => c.prompt);
  assert.ok(prompts.includes("请处理来自群通知的校园通知，任务是提取，先说明依据再执行。"));
  assert.ok(prompts.includes("请处理来自邮件的校园通知，任务是保存，先说明依据再执行。"));
});

test("expandBlueprint：同一 prompt 去重（模板未引用维度时不重复生成）", () => {
  const suite = expandBlueprint(blueprint({
    axes: { unused: ["甲", "乙", "丙"] },
    template: { prompt: "固定的场景问题：整理通知。", category: "planning" },
  }));
  assert.equal(suite.cases.length, 1);
  assert.equal(suite.cases[0].prompt, "固定的场景问题：整理通知。");
});

test("expandBlueprint：重复维度值也被去重", () => {
  const suite = expandBlueprint(blueprint({
    axes: { channel: ["群通知", "群通知", "邮件"] },
    template: { prompt: "处理{{channel}}。", category: "planning" },
  }));
  assert.deepEqual(suite.cases.map((c) => c.prompt), ["处理群通知。", "处理邮件。"]);
});

test("expandBlueprint：maxCases 截断且按种子确定性抽样", () => {
  const bp = blueprint({
    axes: { a: ["1", "2", "3", "4", "5"], b: ["x", "y", "z"] },
    template: { prompt: "组合 {{a}}-{{b}} 的规划问题。", category: "planning" },
    limits: { maxCases: 5, seed: 42 },
  });
  const first = expandBlueprint(bp);
  assert.equal(first.cases.length, 5);
  assert.equal(new Set(first.cases.map((c) => c.prompt)).size, 5);
  // 同 seed 同结果（含抽样后的顺序与 id）。
  const second = expandBlueprint(bp);
  assert.deepEqual(second, first);
  // id 仍是 001 起的连续序号。
  assert.deepEqual(first.cases.map((c) => c.id), ["matrix-demo-001", "matrix-demo-002", "matrix-demo-003", "matrix-demo-004", "matrix-demo-005"]);
});

test("expandBlueprint：maxCases 大于展开数时不截断", () => {
  const suite = expandBlueprint(blueprint({
    axes: { a: ["1", "2"] },
    template: { prompt: "问题 {{a}}", category: "planning" },
    limits: { maxCases: 99, seed: 7 },
  }));
  assert.equal(suite.cases.length, 2);
});

test("expandBlueprint：确定性（同输入同输出）", () => {
  const bp = blueprint({ limits: { seed: 123 } });
  assert.deepEqual(expandBlueprint(bp), expandBlueprint(structuredClone(bp)));
});

test("expandBlueprint：默认检查为安全的最小检查，不硬编码业务断言", () => {
  const suite = expandBlueprint(blueprint());
  for (const c of suite.cases) {
    assert.ok(c.checks.length >= 2);
    assert.equal(c.checks[0].kind, "status");
    assert.equal(c.checks[1].kind, "max_duration_ms");
    assert.ok(!c.checks.some((check) => check.kind === "reply_includes" || check.kind === "tool_called"));
  }
});

test("validateBlueprint：非法 blueprint 报错而非抛异常", () => {
  const missingId = validateBlueprint({ schemaVersion: 1, name: "x", axes: { a: ["1"] }, template: { prompt: "q", category: "c" } });
  assert.ok(missingId.errors.some((e) => e.includes("id 无效")));

  const emptyAxes = validateBlueprint({ schemaVersion: 1, id: "ok-id", name: "x", axes: {}, template: { prompt: "q", category: "c" } });
  assert.ok(emptyAxes.errors.some((e) => e.includes("axes 至少需要一个维度")));

  const badDifficulty = validateBlueprint({
    schemaVersion: 1, id: "ok-id", name: "x", axes: { a: ["1"] },
    template: { prompt: "问题 {{a}}", category: "c", difficulty: "impossible" },
  });
  assert.ok(badDifficulty.errors.some((e) => e.includes("difficulty")));

  const missingPlaceholder = validateBlueprint({
    schemaVersion: 1, id: "ok-id", name: "x", axes: { a: ["1"] },
    template: { prompt: "问题 {{unknown}}", category: "c" },
  });
  assert.ok(missingPlaceholder.errors.some((e) => e.includes("未声明的占位符")));

  const wrongVersion = validateBlueprint({ schemaVersion: 2, id: "ok-id", name: "x", axes: { a: ["1"] }, template: { prompt: "q", category: "c" } });
  assert.ok(wrongVersion.errors.some((e) => e.includes("schemaVersion")));

  assert.equal(validateBlueprint(null).blueprint, undefined);
});

test("expandBlueprint：非法 blueprint 抛错", () => {
  assert.throws(() => expandBlueprint(blueprint({ axes: {} })), /Blueprint 校验失败/);
  assert.throws(() => expandBlueprint(blueprint({ template: { prompt: "问题 {{missing}}", category: "c" } })), /未声明的占位符/);
});

test("生成结果可被 dataset.parseSuite 加载（含 JSON 往返）", () => {
  const suite = expandBlueprint(blueprint());
  const reloaded = parseSuite(JSON.parse(JSON.stringify(suite)));
  assert.equal(reloaded.id, "matrix-demo");
  assert.equal(reloaded.cases.length, 4);
  assert.ok(reloaded.cases.every((c) => c.exploratory === true));
});

test("writeGeneratedSuite：落盘 + 回读校验 + 统计", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "campusmate-generator-"));
  try {
    const outFile = path.join(dir, "generated-demo.json");
    const result = writeGeneratedSuite(blueprint({
      axes: { a: ["1", "2", "3"] },
      template: { prompt: "问题 {{a}}", category: "planning" },
    }), outFile);
    assert.ok(fs.existsSync(outFile));
    assert.equal(result.stats.total, 3);
    assert.deepEqual(result.stats.byCategory, { planning: 3 });
    assert.equal(result.stats.exploratory, 3);
    const loaded = parseSuite(JSON.parse(fs.readFileSync(outFile, "utf8")), outFile);
    assert.deepEqual(loaded, result.suite);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
