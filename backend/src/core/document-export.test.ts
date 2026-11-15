import { test } from "node:test";
import assert from "node:assert/strict";
import { richDocument } from "../../tests/fixtures/document.ts";
import { contextFor, OWNER, OTHER } from "../runtime/storage-test-fixture.ts";
import { DocumentService, saveFetchedSource } from "./document-service.ts";
import { inspectExport, renderDocument } from "./document-renderer.ts";
import { CLOUD_TOOLS, executeCloudTool } from "./cloud-tools.ts";
import { Worker } from "../runtime/worker.ts";
import type { ChatMessage, ChatResult } from "./types.ts";
import type { DocumentAst } from "../../../shared/document.ts";

test("同一中文长文含跨页表格/图片/图表/引用，实际DOCX/PDF复读及同版缓存", async () => {
  const ast = richDocument(), ctx = contextFor(), task = await ctx.store.createTask({ userId: OWNER, title: "文档测试" });
  for (const format of ["docx", "pdf"] as const) { const bytes = await renderDocument(ast, format), check = await inspectExport(ast, bytes, format); assert.equal(check.passed, true, JSON.stringify(check)); if (format === "pdf") assert.ok(check.pages! >= 3); else assert.equal(bytes.subarray(0, 2).toString(), "PK"); }
  const service = ctx.documents;
  const document = await service.create(OWNER, task.id, { title: "无外部引用的项目说明", blocks: [{ type: "paragraph", text: "这是一份可核对的本地计划，具体执行时间与费用需要讨论。", claimType: "proposal" }] });
  const [a, b] = await Promise.all([service.export(OWNER, document.id, "docx"), service.export(OWNER, document.id, "docx")]);
  assert.equal(a.id, b.id); assert.equal(service.file(a).sha256, service.file(b).sha256);
  await assert.rejects(() => service.export(OTHER, document.id, "docx"));
  assert.deepEqual(new DocumentService(ctx.artifactStore, { pdfEnabled: false }).formats(), ["md", "docx"]);
  await assert.rejects(() => service.create(OWNER, task.id, { title: "虚构来源", blocks: [{ type: "paragraph", text: "外部事实", claimType: "fact", sourceIds: ["MadeUp"] }] }), /引用/);
});
test("真实Worker经Manifest调用create/inspect/export，文件与聊天产物接线", async () => {
  const ctx = contextFor(), task = await ctx.store.createTask({ userId: OWNER, title: "为我生成项目说明文档" });
  let step = 0, artifactId = "";
  const transport = { async chat(opts: { messages: ChatMessage[] }): Promise<ChatResult> {
    const previous = opts.messages.at(-1); if (previous?.role === "tool") { const data = JSON.parse(String(previous.content)); if (data.documentId) artifactId = data.artifactId; }
    const calls = ["document_create", "document_inspect", "document_export"];
    const name = calls[step++];
    const args = name === "document_create" ? { title: "项目说明", blocks: [{ type: "paragraph", text: "计划先验证真实需求，再按阶段实现并检查结果。", claimType: "proposal" }] } : { artifactId, ...(name === "document_export" ? { format: "docx" } : {}) };
    return { content: name ? "" : "文档已经真实生成并可下载。", toolCalls: name ? [{ id: `call-${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] : [], usage: { input: 1, output: 1 }, model: "fixture-model" };
  } };
  await new Worker({ store: ctx.store, artifactStore: ctx.artifactStore, capabilityRegistry: ctx.capabilityRegistry, transport, tools: CLOUD_TOOLS, buildSystem: () => "fixture", executeTool: async (_task, name, args) => executeCloudTool(name, args, { userId: OWNER, taskId: task.id, artifactStore: ctx.artifactStore, documents: ctx.documents }), concurrency: 1 }).tick();
  const final = (await ctx.store.getTask(task.id))!; assert.equal(final.status, "succeeded", final.error); assert.ok(final.result?.artifactIds.includes(artifactId));
  assert.ok((await ctx.artifactStore.listByTask(OWNER, task.id)).some((a) => a.kind === "document-export"));
  const source = await saveFetchedSource(ctx.artifactStore, OWNER, task.id, { url: "https://school.example/official", text: "实际抓取资料的合成测试正文，明确说明项目提交材料和评审流程，不代表任何真实高校已发布此通知。" });
  assert.ok(source); assert.ok(await ctx.documents.create(OWNER, task.id, { title: "有实际材料", blocks: [{ type: "paragraph", text: "来源中的测试要求", claimType: "fact", sourceIds: [source!] }] }));
});
test("PDF环境明确不可用时，模型自称完成也不能把导出失败标成功", async () => {
  const ctx = contextFor(), task = await ctx.store.createTask({ userId: OWNER, title: "导出PDF文档" });
  const document = await ctx.documents.create(OWNER, task.id, { title: "导出测试", blocks: [{ type: "paragraph", text: "需要实际导出文件。" }] });
  let first = true;
  const transport = { async chat(): Promise<ChatResult> { if (first) { first = false; return { content: "", toolCalls: [{ id: "export-pdf", type: "function", function: { name: "document_export", arguments: JSON.stringify({ artifactId: document.id, format: "pdf" }) } }], usage: { input: 1, output: 1 }, model: "fixture-model" }; } return { content: "PDF已经完成。", toolCalls: [], usage: { input: 1, output: 1 }, model: "fixture-model" }; } };
  const documents = new DocumentService(ctx.artifactStore, { pdfEnabled: false });
  await new Worker({ store: ctx.store, artifactStore: ctx.artifactStore, transport, tools: CLOUD_TOOLS, buildSystem: () => "fixture", executeTool: async (_task, name, args) => executeCloudTool(name, args, { userId: OWNER, taskId: task.id, artifactStore: ctx.artifactStore, documents }), concurrency: 1 }).tick();
  const final = (await ctx.store.getTask(task.id))!; assert.equal(final.status, "failed"); assert.equal(final.result?.completion?.checks?.find((c) => c.id === "document_tools")?.passed, false);
});
