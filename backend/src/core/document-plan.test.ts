import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalRequirements } from "./document-plan.ts";
test("用户中文数字/范围字数、指定章节优先于默认模板", () => {
  const chinese = proposalRequirements("请写策划书，至少三千字，不超过五千字。章节：问题、方案、预算");
  assert.equal(chinese.minChars, 3000); assert.equal(chinese.maxChars, 5000); assert.deepEqual(chinese.sections, ["问题", "方案", "预算"]);
  const range = proposalRequirements("写策划书，2000至3000字，无需引用"); assert.equal(range.minChars, 2000); assert.equal(range.maxChars, 3000); assert.equal(range.requireSources, false);
});
