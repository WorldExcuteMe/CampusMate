import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";
import { InMemoryEvidenceStore } from "../core/evidence.ts";
import { Evaluator } from "../core/evaluator.ts";
import { executeCloudTool } from "../core/cloud-tools.ts";
import type { LlmTransport } from "../core/llm.ts";
import type { ChatResult, ToolDef, ChatMessage, AcceptanceCriterion } from "../core/types.ts";

const tools: ToolDef[] = [{ type: "function", function: { name: "propose_verification", description: "x", parameters: { type: "object", properties: {} } } }];
const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const acceptance: AcceptanceCriterion[] = [{ id: "ev", kind: "evidence_verified", params: { min: 1 }, required: true }];

// 模型先 propose_verification（带证据），再收尾。
class VerifyTransport implements LlmTransport {
  evidence: { sourceUrl: string; excerpt: string; supports: string }[];
  constructor(evidence: { sourceUrl: string; excerpt: string; supports: string }[]) { this.evidence = evidence; }
  async chat(opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const hasResult = opts.messages.some((m) => m.role === "tool");
    if (hasResult) return { content: "已提交核验提案。", toolCalls: [], usage: { input: 1, output: 1 }, model: "fake" };
    return { content: "", toolCalls: [tc("propose_verification", { opportunityId: "o1", proposedStatus: "VERIFIED", summary: "核验", evidence: this.evidence }, `c${opts.messages.length}`)], usage: { input: 1, output: 1 }, model: "fake" };
  }
}

function makeWorker(store: InMemoryStore, evidenceStore: InMemoryEvidenceStore, transport: LlmTransport, fetchBody: string) {
  const ev = new Evaluator({ evidenceStore, fetchImpl: async () => ({ status: 200, text: fetchBody }) });
  return new Worker({
    store, transport, tools, evidenceStore, acceptance: () => acceptance,
    evaluator: async (task, result) => ev.evaluate(task.id, acceptance, { artifacts: [], evidence: await evidenceStore.listByTask(task.id), fields: {}, counts: {}, expiredCount: 0, citedSources: [], reply: result.reply }),
    buildSystem: () => "s",
    executeTool: async (task, name, args) => executeCloudTool(name, args, { taskId: task.id, userId: task.userId, evidenceStore }),
    workerId: "w1", heartbeatMs: 1e9,
  });
}

test("声称 VERIFIED 但证据幻觉（重抓不符）→ Evaluator 拒绝 → failed", async () => {
  const store = new InMemoryStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const t = await store.createTask({ userId: "u1", title: "核验机会" });
  const transport = new VerifyTransport([{ sourceUrl: "https://example.org/comp", excerpt: "报名截止2026年11月30日", supports: "deadline" }]);
  const w = makeWorker(store, evidenceStore, transport, "完全无关的页面，没有截止日期");
  await w.tick();
  const done = await store.getTask(t.id);
  assert.equal(done?.status, "failed"); // 执行 Agent 声称成功，Evaluator 拒绝
  assert.equal(done?.result?.certificate?.passed, false);
  assert.ok((await evidenceStore.listByTask(t.id)).every((e) => !e.verified));
});

test("证据独立重抓一致 → Evaluator 通过 → succeeded", async () => {
  const store = new InMemoryStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const t = await store.createTask({ userId: "u1", title: "核验机会" });
  const transport = new VerifyTransport([{ sourceUrl: "https://example.org/comp", excerpt: "报名截止2026年11月30日", supports: "deadline" }]);
  const w = makeWorker(store, evidenceStore, transport, "2026计算机竞赛：报名截止2026年11月30日。");
  await w.tick();
  const done = await store.getTask(t.id);
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.result?.certificate?.passed, true);
  assert.ok((await evidenceStore.listByTask(t.id)).some((e) => e.verified));
});

test("无证据声称成功 → evidence_verified 拒绝 → failed", async () => {
  const store = new InMemoryStore();
  const evidenceStore = new InMemoryEvidenceStore();
  const t = await store.createTask({ userId: "u1", title: "核验机会" });
  const transport = new VerifyTransport([]); // 无证据
  const w = makeWorker(store, evidenceStore, transport, "任意正文");
  await w.tick();
  assert.equal((await store.getTask(t.id))?.status, "failed");
});

test("propose_verification 自填 VERIFIED → acceptedStatus 降级 UNVERIFIED，证据入库", async () => {
  const evidenceStore = new InMemoryEvidenceStore();
  const out = await executeCloudTool("propose_verification", { opportunityId: "o1", proposedStatus: "VERIFIED", summary: "x", evidence: [{ sourceUrl: "https://a", excerpt: "e", supports: "s" }] }, { taskId: "t1", userId: "u1", evidenceStore });
  const parsed = JSON.parse(out);
  assert.equal(parsed.acceptedStatus, "UNVERIFIED");
  assert.equal(parsed.evidenceIds.length, 1);
  assert.equal((await evidenceStore.listByTask("t1")).length, 1);
});