import type { ArtifactStore, StoredArtifact } from "./storage-contracts.ts";
import { createHash } from "node:crypto";
import { canonicalArgs, sha256 } from "../runtime/idempotency.ts";
import { documentErrors, publicSourceUrl, type DocumentAst, type DocumentBlock, type DocumentSource } from "../../../shared/document.ts";
import { availableDocumentFormats, DocumentRenderUnavailable, inspectExport, MIME, renderDocument, RENDERER_VERSION, type DocumentFormat } from "./document-renderer.ts";

export const sourceId = (id: string): string => "R" + id.replace(/-/g, "");
function uuid(hash: string): string { return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`; }
interface FileInline { format: DocumentFormat; mime: string; base64: string; fileSha256: string; sourceArtifactId: string; sourceSha256: string; renderer: string; inspection: Awaited<ReturnType<typeof inspectExport>>; }
export class DocumentService {
  private artifacts: ArtifactStore; private pdfEnabled: boolean;
  private inFlight = new Map<string, Promise<StoredArtifact>>(); private active = 0; private queue: (() => void)[] = [];
  constructor(artifacts: ArtifactStore, options: { pdfEnabled?: boolean } = {}) { this.artifacts = artifacts; this.pdfEnabled = options.pdfEnabled ?? true; }
  formats(ast?: DocumentAst): DocumentFormat[] { const formats = availableDocumentFormats(this.pdfEnabled); return ast?.blocks.some((b) => b.type === "chart") && !formats.includes("pdf") ? ["md"] : formats; }
  async create(userId: string, taskId: string, input: { title: string; blocks: DocumentBlock[]; sourceIds?: string[]; previousArtifactId?: string }) {
    const requested = new Set([...(input.sourceIds ?? []), ...input.blocks.flatMap((b) => b.type === "reference" ? [b.sourceId] : "sourceIds" in b ? b.sourceIds ?? [] : [])]);
    const rawSources = (await this.artifacts.listByTask(userId, taskId)).filter((s) => s.kind === "web-source" && requested.has(sourceId(s.id)));
    const sources: DocumentSource[] = rawSources.map((s) => { const value = s.inline as { url: string; title: string; excerpt: string; retrievedAt: number }; return { id: sourceId(s.id), ...value, status: "retrieved" }; });
    if (sources.length !== requested.size) throw new Error("引用必须关联本任务实际抓取的sourceId；不能自行声明来源已经核实");
    const inline: DocumentAst = { schemaVersion: 1, title: input.title, kind: "document", blocks: input.blocks, sources };
    const errors = documentErrors(inline); if (errors.length) throw new Error(errors[0]);
    if (JSON.stringify(inline).length > 4000000) throw new Error("文档超过4MB上限");
    const digest = sha256(canonicalArgs(inline)); let documentId = uuid(sha256(taskId + digest)), revision = 1;
    if (input.previousArtifactId) { const previous = await this.artifacts.get(userId, input.previousArtifactId); if (!previous || previous.taskId !== taskId || previous.kind !== "document") throw new Error("前一版本不存在或不属于当前任务"); documentId = previous.documentId; revision = Math.max(...(await this.artifacts.listByTask(userId, taskId)).filter((a) => a.kind === "document" && a.documentId === documentId).map((a) => a.revision)) + 1; }
    return this.artifacts.create({ userId, taskId, documentId, revision, kind: "document", inline, sha256: digest });
  }
  private async owned(userId: string, id: string) { const source = await this.artifacts.get(userId, id); if (!source || source.kind !== "document" || documentErrors(source.inline).length) throw new Error("文档不存在或结构无效"); return source; }
  async inspect(userId: string, id: string) { const a = await this.owned(userId, id), ast = a.inline as DocumentAst; return { artifactId: a.id, revision: a.revision, sourceSha256: a.sha256, schemaValid: true, blocks: ast.blocks.length, sources: ast.sources.length, availableFormats: this.formats(ast), note: "结构检查不等于事实和视觉验收" }; }
  async export(userId: string, id: string, format: DocumentFormat): Promise<StoredArtifact> {
    const source = await this.owned(userId, id), ast = source.inline as DocumentAst;
    if (!this.formats(ast).includes(format)) throw new DocumentRenderUnavailable("该格式未启用，或所需固定浏览器/中文字体不可用；请在仓库根目录运行 npm run documents:setup 和 npm run documents:check");
    const documentId = uuid(sha256(`${id}:${format}:${RENDERER_VERSION}`));
    const existing = async () => (await this.artifacts.listByTask(userId, source.taskId)).find((a) => a.kind === "document-export" && a.documentId === documentId);
    const cached = await existing(); if (cached) return cached;
    const key = `${userId}:${documentId}`, pending = this.inFlight.get(key); if (pending) return pending;
    const operation = (async () => {
      if (this.queue.length >= 8) throw new DocumentRenderUnavailable("文档导出队列繁忙，请稍后重试");
      if (this.active >= 2) await new Promise<void>((resolve) => this.queue.push(resolve));
      this.active++;
      try {
        const bytes = await renderDocument(ast, format), inspection = await inspectExport(ast, bytes, format);
        if (!inspection.passed) throw new Error(`导出内容复读不一致：${inspection.missing.join("；")}`);
        const inline: FileInline = { format, mime: MIME[format], base64: bytes.toString("base64"), fileSha256: inspection.sha256, sourceArtifactId: id, sourceSha256: source.sha256, renderer: RENDERER_VERSION, inspection };
        try { return await this.artifacts.create({ userId, taskId: source.taskId, documentId, revision: 1, kind: "document-export", inline, sha256: sha256(canonicalArgs(inline)) }); }
        catch (e) { const winner = await existing(); if (winner) return winner; throw e; }
      } finally { this.active--; this.queue.shift()?.(); }
    })();
    this.inFlight.set(key, operation);
    try { return await operation; } finally { this.inFlight.delete(key); }
  }
  file(artifact: StoredArtifact): { bytes: Buffer; mime: string; sha256: string; sourceArtifactId: string } { if (artifact.kind !== "document-export") throw new Error("不是导出文件"); const file = artifact.inline as FileInline, bytes = Buffer.from(file.base64, "base64"); if (createHash("sha256").update(bytes).digest("hex") !== file.fileSha256 || file.fileSha256 !== file.inspection.sha256) throw new Error("文件哈希不一致"); return { bytes, mime: file.mime, sha256: file.fileSha256, sourceArtifactId: file.sourceArtifactId }; }
}

export async function saveFetchedSource(artifacts: ArtifactStore, userId: string, taskId: string, input: { url: string; text: string }): Promise<string | undefined> {
  const url = publicSourceUrl(input.url); if (!url || input.text.trim().length < 40) return;
  const documentId = uuid(sha256(taskId + url + sha256(input.text)));
  const existing = (await artifacts.listByTask(userId, taskId)).find((a) => a.kind === "web-source" && a.documentId === documentId);
  if (existing) return sourceId(existing.id);
  const inline = { url, title: new URL(url).hostname, excerpt: input.text.slice(0, 1500), retrievedAt: Date.now() };
  try { const source = await artifacts.create({ userId, taskId, kind: "web-source", documentId, revision: 1, inline, sha256: sha256(canonicalArgs(inline)) }); return sourceId(source.id); }
  catch (e) { const winner = (await artifacts.listByTask(userId, taskId)).find((a) => a.kind === "web-source" && a.documentId === documentId); if (winner) return sourceId(winner.id); throw e; }
}
