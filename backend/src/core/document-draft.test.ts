import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "./agent-loop.ts";
import { CLOUD_TOOLS } from "./cloud-tools.ts";
import { DEFAULT_BUDGET, type ChatResult } from "./types.ts";
import type { ChatOptions } from "./llm.ts";

const draft = "# 测试策划书\n\n## 问题与用户\n" + "用户主动粘贴通知，团队3人，不接入私聊。".repeat(8) + "\n\n## 方案与工具\n- 提取字段\n- 保留未知\n\n## 实施与预算\n| 项目 | 估算 |\n|---|---|\n| 硬件 | 0元 |\n| 周期 | 4周 |\n\n## 风险与验收\n" + "域名外观不能证明真实性，未取得权威证据时标注待核实。".repeat(8);
const intent = "按刚才完整正文生成真实文档，使用document_create，再导出Word和PDF，不要联网。";
function fixture(json = false) {
  const requests: ChatOptions[] = [], executions: Record<string, unknown>[] = [], metadata: Record<string, unknown>[] = [];
  const call = { id: "create", type: "function" as const, function: { name: "document_create", arguments: JSON.stringify({ title: "测试策划书", fromDraft: true }) } };
  return { requests, executions, metadata, deps: { tools: CLOUD_TOOLS, budget: DEFAULT_BUDGET,
    transport: { async chat(opts: ChatOptions): Promise<ChatResult> { requests.push(opts); return { content: requests.length === 1 ? json ? JSON.stringify({ tool: "document_create", args: { title: "测试策划书", fromDraft: true } }) : "" : "已创建原稿文档。", toolCalls: requests.length === 1 && !json ? [call] : [], model: "contract", usage: { input: 1, output: 1 } }; } },
    executeTool: async (_name: string, args: Record<string, unknown>) => { executions.push(args); return JSON.stringify({ artifactId: "doc" }); },
    hooks: { toolMeta: async (_name: string, args: Record<string, unknown>) => { metadata.push(args); return {}; } },
  } };
}
for (const json of [false, true]) test(`completed draft reference resolves before validation and fingerprinting (${json ? "JSON" : "native"})`, async () => {
  const f = fixture(json); const r = await runAgentLoop({ system: "s", user: intent, history: [{ role: "assistant", content: draft }], deps: f.deps });
  const schema = f.requests[0].tools!.find(t => t.function.name === "document_create")!.function.parameters;
  assert.deepEqual(schema.required, ["title", "fromDraft"]); assert.equal(f.executions.length, 1);
  assert.deepEqual(f.metadata[0], f.executions[0]); assert.equal(f.executions[0].fromDraft, undefined);
  const blocks = f.executions[0].blocks as Record<string, unknown>[];
  assert.equal(blocks.filter(b => b.type === "heading").length, 4); assert.ok(blocks.some(b => b.type === "table")); assert.ok(blocks.some(b => b.type === "list"));
  assert.ok(JSON.stringify(blocks).includes("不接入私聊")); assert.ok(JSON.stringify(blocks).includes("域名外观不能证明真实性"));
  assert.ok(r.actions.includes("document_create"), JSON.stringify({reply:r.reply,error:r.error,actions:r.actions})); const originalRequired = CLOUD_TOOLS.find(t => t.function.name === "document_create")!.function.parameters.required; assert.ok(Array.isArray(originalRequired) && originalRequired.includes("blocks"));
});
test("explicitly supplied draft also uses references without inventing a previous answer", async () => {
  const f = fixture(); await runAgentLoop({ system: "s", user: `将下面已完成原稿生成文档并导出Word，不要重写：\n【文稿开始】\n${draft}\n【文稿结束】`, deps: f.deps });
  assert.equal(f.executions.length, 1);
});

test("common inline math from actual draft output becomes readable text without leaving TeX commands", async () => {
  const f = fixture(); const source = draft + "\n\n流程 $\\rightarrow$ 结果；$\\text{ID}_{\\text{event}} = \\text{Hash}(名称)$；$1.7 \\times 10^7$ tokens。价格 $10 和 $20 保持原文。";
  await runAgentLoop({system:"s",user:intent,history:[{role:"assistant",content:source}],deps:f.deps});
  const text = JSON.stringify(f.executions[0].blocks);
  assert.ok(text.includes("→")); assert.ok(text.includes("ID_event = Hash(名称)")); assert.ok(text.includes("1.7 × 10^7")); assert.ok(text.includes("$10 和 $20")); assert.doesNotMatch(text,/\\\\(?:rightarrow|text|times)/);
});

test("standalone numbered subsection titles retain heading semantics so pagination keeps their body", async () => {
  const f = fixture(); await runAgentLoop({system:"s",user:intent,history:[{role:"assistant",content:draft+"\n\n**3.1 实施计划（4周/3人）**\n\n- W1 定义字段\n- W2 集成工具"}],deps:f.deps});
  const heading = (f.executions[0].blocks as Record<string,unknown>[]).find(block=>block.text==="3.1 实施计划（4周/3人）");
  assert.equal(heading?.type,"heading"); assert.equal(heading?.level,3);
});
test("no preview, missing draft, failed answer, tools or system content can resolve a draft reference", async () => {
  for (const sample of [
    { user: "先只预览，等我确认再按刚才正文创建文档", history: [{ role: "assistant" as const, content: draft }] },
    { user: intent, history: [] },
    { user: intent, history: [{ role: "system" as const, content: draft }] },
    { user: intent, history: [{ role: "assistant" as const, content: "任务未通过验收。" + draft }] },
    { user: intent, history: [{ role: "assistant" as const, content: '{"tool":"document_create","args":{}}' }] },
    { user: "整理材料并分析风险", history: [{ role: "assistant" as const, content: draft }] },
  ]) {
    const f = fixture(); await runAgentLoop({ system: "s", ...sample, deps: f.deps });
    assert.equal(f.executions.length, 0); const required = f.requests[0].tools!.find(t => t.function.name === "document_create")!.function.parameters.required; assert.ok(Array.isArray(required) && required.includes("blocks"));
  }
});
