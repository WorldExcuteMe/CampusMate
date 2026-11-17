import { test } from "node:test";
import assert from "node:assert/strict";
import { contextFor, OWNER, storageFixture } from "./storage-test-fixture.ts";
import { Worker } from "./worker.ts";
import { CLOUD_TOOLS } from "../core/cloud-tools.ts";
import { sha256 } from "./idempotency.ts";
import type { ChatMessage, ChatResult } from "../core/types.ts";
import { inspectDocument, type DocumentAst } from "../../../shared/document.ts";
test("真实Worker：策划书不能凭一句好的被判为成功，普通聊天仍正常", async () => {
  const ctx = contextFor();
  const task = await ctx.store.createTask({ userId: OWNER, title: "策划书", intent: "请写一份校园创新竞赛项目策划书，项目为校园信息助手" });
  const worker = new Worker({ store: ctx.store, artifactStore: ctx.artifactStore, transport: { chat: async () => ({ content: "好的", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture-model" }) }, tools: [], buildSystem: () => "test", executeTool: async () => "{}", concurrency: 1 });
  await worker.tick();
  const final = (await ctx.store.getTask(task.id))!;
  assert.equal(final.status, "failed"); assert.equal(final.result?.completion?.state, "partial");
  assert.ok(final.result?.completion?.checks?.some((c) => !c.passed));
  const chat = await ctx.store.createTask({ userId: OWNER, title: "你好" }); await worker.tick(); assert.equal((await ctx.store.getTask(chat.id))?.status, "succeeded");
});

function scriptedModel(stopChapter = -1, jsonTools = false) {
  const calls: string[] = []; let stopped = false;
  const source = "S" + sha256("https://school.example/competition").slice(0, 10);
  return { calls, transport: { async chat(opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const prompt = String(opts.messages.findLast((m) => m.role === "user" && String(m.content).includes("[document-stage:"))?.content ?? "");
    const stage = prompt.match(/\[document-stage:([^\]]+)\]/)?.[1] ?? "unknown"; calls.push(stage);
    const chapter = stage.match(/chapter-(\d+)/);
    let content = "", toolCalls: ChatResult["toolCalls"] = [];
    if (stage === "research") {
      if (opts.messages.at(-1)?.role !== "tool" && !String(opts.messages.at(-1)?.content).startsWith("[工具观测")) { if (jsonTools) content = '{"tool":"web_fetch","args":{"url":"https://school.example/competition"}}'; else toolCalls = [{ id: "fetch-source", type: "function", function: { name: "web_fetch", arguments: '{"url":"https://school.example/competition"}' } }]; }
      else content = "已取得主办方网页正文，项目目标与参赛材料有明确说明，具体费用采用估算，截止要求需要人工再次核对。";
    } else if (stage === "outline") content = JSON.stringify({ title: "CampusMate校园信息助手项目策划书", outline: "围绕校园信息分散的问题，提出可验证的信息整理方案，明确目标、执行步骤、团队分工、时间、预算和风险，按要求逐章撰写。" });
    else if (chapter) {
      const index = Number(chapter[1]);
      if (index === stopChapter && !stopped) { stopped = true; return { content: '{"blocks":[', toolCalls: [], usage: { input: 3, output: 3 }, model: "fixture-model", truncated: true }; }
      content = JSON.stringify({ blocks: [{ type: "paragraph", text: `第${index + 1}章围绕实际校园场景展开。` + "项目采用先调研、再实现、后验收的方式，由团队分别承担资料整理、界面设计和测试工作，每周记录进度与问题，并对经费、数据授权及信息准确性做明确核对。".repeat(2), claimType: "proposal", sourceIds: [source] }] });
    }
    return { content, toolCalls, usage: { input: 3, output: 3 }, model: "fixture-model" };
  } } };
}
const fetchSource = async () => JSON.stringify({ url: "https://school.example/competition", status: 200, text: "主办方明确要求参赛项目提交问题背景、技术方案、项目进度与团队分工，并在答辩中展示可以复核的系统实现和过程材料。" });
test("策划书真实Worker按资料/提纲/7章/检查/交付保存同版文档及可追踪阶段", async () => {
  const ctx = contextFor(), model = scriptedModel();
  const task = await ctx.store.createTask({ userId: OWNER, title: "撰写项目策划书", intent: "请写一份校园创新竞赛项目策划书，至少500字，项目方向是校园信息管理助手" });
  await new Worker({ store: ctx.store, artifactStore: ctx.artifactStore, transport: model.transport, tools: CLOUD_TOOLS, executeTool: fetchSource, buildSystem: () => "fixture", concurrency: 1 }).tick();
  const final = (await ctx.store.getTask(task.id))!;
  assert.equal(final.status, "succeeded", final.error); assert.equal(final.result?.completion?.state, "complete");
  const artifact = (await ctx.artifactStore.get(OWNER, final.result!.artifactIds[0]))!;
  const document = artifact.inline as DocumentAst;
  assert.equal(document.blocks.filter((b) => b.type === "heading").length, 7); assert.equal(document.sources[0].status, "retrieved");
  const checkpoint = (await ctx.store.latestCheckpoint(task.id))!; assert.equal(checkpoint.state.documentRun?.plan.acceptanceFrozen, true);
  assert.ok(checkpoint.state.documentRun?.plan.steps.every((s) => s.acceptance.length));
  assert.ok(inspectDocument(document, checkpoint.state.documentRun!.requirements).every((c) => c.passed));
  const stages = (await ctx.store.listEvents(task.id)).filter(e => e.type === "step.finished");
  assert.equal(stages.filter(e => e.payload.stepId !== "prepare").length, 11);
  assert.equal(stages.filter(e => e.payload.stepId === "prepare" && e.payload.passed).length, 1);
});
test("不支持原生tool_calls的JSON工具路径仍能记录已取得来源", async () => {
  const ctx = contextFor(), model = scriptedModel(-1, true);
  const task = await ctx.store.createTask({ userId: OWNER, title: "请写校园竞赛项目策划书" });
  await new Worker({ store: ctx.store, artifactStore: ctx.artifactStore, transport: model.transport, tools: CLOUD_TOOLS, executeTool: fetchSource, buildSystem: () => "fixture", concurrency: 1 }).tick();
  const final = (await ctx.store.getTask(task.id))!; assert.equal(final.status, "succeeded", final.error);
  assert.equal(((await ctx.artifactStore.get(OWNER, final.result!.artifactIds[0]))?.inline as DocumentAst).sources.length, 1);
});
test("章节输出中断后从检查点续写，已完成章节不重做且草稿版本可读", async () => {
  const ctx = contextFor(), model = scriptedModel(2);
  const session = await ctx.sessionStore.create({ userId: OWNER });
  const { task } = await ctx.store.createSessionTask!({ userId: OWNER, sessionId: session.id, turnId: crypto.randomUUID(), title: "请写校园竞赛项目策划书" }, ctx.sessionStore);
  const worker = new Worker({ store: ctx.store, sessionStore: ctx.sessionStore, artifactStore: ctx.artifactStore, transport: model.transport, tools: CLOUD_TOOLS, executeTool: fetchSource, buildSystem: () => "fixture", concurrency: 1 });
  await worker.tick();
  const partial = (await ctx.store.getTask(task.id))!; assert.equal(partial.status, "paused"); assert.equal(partial.result?.completion?.reason, "output_incomplete"); assert.ok(partial.result?.artifactIds.length);
  const draftId = partial.result!.artifactIds[0];
  await ctx.store.resumeSessionTask!(task.id, OWNER); await worker.tick();
  const final = (await ctx.store.getTask(task.id))!; assert.equal(final.status, "succeeded", final.error);
  assert.equal(model.calls.filter((s) => s === "chapter-0").length, 1); assert.equal(model.calls.filter((s) => s === "chapter-2").length, 2);
  assert.ok(await ctx.artifactStore.get(OWNER, draftId)); assert.notEqual(final.result?.artifactIds[0], draftId);
  assert.equal((await ctx.sessionStore.listMessages(OWNER, session.id)).filter((m) => m.role === "user").length, 1);
});
test("缺失实质正文只能尝试一次修订，仍不满足则保留未完成草稿", async () => {
  const ctx = contextFor(), model = scriptedModel();
  const transport = { chat: async (opts: Parameters<typeof model.transport.chat>[0]) => { const response = await model.transport.chat(opts); if (model.calls.at(-1)?.startsWith("chapter-")) return { ...response, content: JSON.stringify({ blocks: [{ type: "paragraph", text: "好的" }] }) }; return response; } };
  const task = await ctx.store.createTask({ userId: OWNER, title: "请写竞赛项目策划书，至少三千字" });
  await new Worker({ store: ctx.store, artifactStore: ctx.artifactStore, transport, tools: CLOUD_TOOLS, executeTool: fetchSource, buildSystem: () => "fixture", concurrency: 1 }).tick();
  const final = (await ctx.store.getTask(task.id))!; assert.equal(final.status, "failed"); assert.ok(final.result?.artifactIds.length);
  assert.equal(model.calls.filter((s) => s === "revision").length, 1); assert.equal(final.result?.completion?.checks?.find((c) => c.id === "length")?.passed, false);
});
test("Postgres重建Worker后继续文档章节，CP与旧/新产物版本均保留", async (t) => {
  const fixture = await storageFixture(t), model = scriptedModel(1), ctx = fixture.first;
  const session = await ctx.sessionStore.create({ userId: OWNER });
  const { task } = await ctx.store.createSessionTask!({ userId: OWNER, sessionId: session.id, turnId: crypto.randomUUID(), title: "请写竞赛项目策划书" }, ctx.sessionStore);
  const workerFor = (context: typeof ctx) => new Worker({ store: context.store, sessionStore: context.sessionStore, artifactStore: context.artifactStore, transport: model.transport, tools: CLOUD_TOOLS, executeTool: fetchSource, buildSystem: () => "fixture", concurrency: 1 });
  await workerFor(ctx).tick(); const first = (await ctx.store.getTask(task.id))!; assert.equal(first.status, "paused");
  const next = fixture.rebuild(); await next.store.resumeSessionTask!(task.id, OWNER); await workerFor(next).tick();
  const final = (await next.store.getTask(task.id))!; assert.equal(final.status, "succeeded", final.error);
  assert.equal(model.calls.filter((s) => s === "chapter-0").length, 1); assert.equal((await next.artifactStore.listByTask(OWNER, task.id)).length, 2);
  assert.ok((await next.store.latestCheckpoint(task.id))?.state.documentRun?.plan.acceptanceFrozen);
});
