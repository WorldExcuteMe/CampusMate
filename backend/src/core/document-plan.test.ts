import { test } from "node:test";
import assert from "node:assert/strict";
import { proposalRequirements, isProposalRequest } from "./document-plan.ts";
test("previewing a proposal plan does not start full document delivery before confirmation", () => {
  assert.equal(isProposalRequest('为“CM探索助手”做竞赛策划书。3人4周，硬件0元。不要联网、不保存，先列需求和10步依赖计划。'), false);
  assert.equal(isProposalRequest('写一份策划书，先只给提纲，等我确认后再写正文。'), false);
  assert.equal(isProposalRequest('写一份策划书，先资料和提纲，再逐章写正文，最后生成Word和PDF。'), true);
  assert.equal(isProposalRequest('不要保存到信息中心，请直接写完策划书并导出Word。'), true);
});
test("用户中文数字/范围字数、指定章节优先于默认模板", () => {
  const chinese = proposalRequirements("请写策划书，至少三千字，不超过五千字。章节：问题、方案、预算");
  assert.equal(chinese.minChars, 3000); assert.equal(chinese.maxChars, 5000); assert.deepEqual(chinese.sections, ["问题", "方案", "预算"]);
  const range = proposalRequirements("写策划书，2000至3000字，无需引用"); assert.equal(range.minChars, 2000); assert.equal(range.maxChars, 3000); assert.equal(range.requireSources, false);
});
