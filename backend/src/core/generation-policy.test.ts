import { test } from "node:test";
import assert from "node:assert/strict";
import { stageForIntent, generationPolicy, stepResponseInstruction } from "./generation-policy.ts";
test("automatic reasoning follows the requested action rather than words inside a project title", () => {
  const prompts = [
    '为“校园通知可信核验助手”做竞赛策划书。不要联网、不保存，先列需求和10步依赖计划。',
    '第5步列可信核验规则：主办方、域名、通知年份分别怎么确认？别联网。',
    '第6步列5个风险与失败恢复方案，不能承诺已解决。',
    '第7步做4周3人分工表，覆盖研发、验证和试用。',
    '第9步只写完整正文：方案与工具、风险与验收。下一轮再保存。',
    '按完整正文生成文档，用document_inspect检查并导出Word和PDF。',
  ];
  for (const prompt of prompts) assert.equal(generationPolicy({ reasoning: "chat_template_kwargs" }, "auto", stageForIntent(prompt), 8192).effective, "off", prompt);
  assert.equal(stageForIntent('请核验这个活动的官网和报名条件'), "verify");
  assert.equal(stageForIntent('请写完整项目策划书'), "plan");
  assert.equal(generationPolicy({ reasoning: "chat_template_kwargs" }, "high", stageForIntent(prompts[0]), 8192).effective, "on");
});
test("incremental steps stay brief while explicitly requested long body and document delivery retain their scope", () => {
  assert(stepResponseInstruction("第5步列可信核验规则，别联网"));
  assert(stepResponseInstruction("先列需求和10步依赖计划"));
  assert.equal(stepResponseInstruction("第9步写700–1100字完整正文"), undefined);
  assert.equal(stepResponseInstruction("第10步生成文档并导出Word和PDF"), undefined);
});

test("reasoning_effort 支持 minimal..max 枚举，小输出预算自动降档", () => {
  const caps = { reasoning: "reasoning_effort" };
  assert.deepEqual(generationPolicy(caps, "max", "plan", 32768).params, { reasoning_effort: "max" });
  assert.equal(generationPolicy(caps, "max", "plan", 32768).effective, "max");
  assert.equal(generationPolicy(caps, "xhigh", "simple", 32768).effective, "xhigh");
  assert.equal(generationPolicy(caps, "minimal", "simple", 32768).effective, "minimal");
  assert.equal(generationPolicy(caps, "max", "simple", 512).effective, "medium");
  assert.equal(generationPolicy(caps, "auto", "verify", 32768).effective, "high");
  assert.equal(generationPolicy({ reasoning: "deepseek_thinking" }, "max", "plan", 32768).effective, "max");
  assert.deepEqual(generationPolicy({ reasoning: "chat_template_kwargs" }, "max", "simple", 32768).params, { chat_template_kwargs: { enable_thinking: true } });
  assert.equal(generationPolicy(caps, "bogus", "simple", 32768).requested, "auto");
});
