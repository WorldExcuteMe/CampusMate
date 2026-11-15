// 最小云端工具集（Phase 7 Capability Registry 前的可用基线）。仅含无本机依赖的安全云工具。
// web_search 用固定搜索引擎 URL（无 SSRF 面）；本机能力（terminal/fs/QQ/微信）不在此（仅 Local Companion）。
import type { ToolDef } from "./types.ts";
import { errorMessage } from "./errors.ts";
import { safeFetch, htmlToText } from "./ssrf.ts";
import { searchPublicWeb } from './web-search.ts';
import type { EvidenceStore } from "./evidence.ts";
import type { OpportunityStore } from "./opportunity-store.ts";
import { sanitizeProposedStatus, type VerificationStatus } from "./verification.ts";
import type { ArtifactStore } from "./storage-contracts.ts";
import { DocumentService, saveFetchedSource } from "./document-service.ts";
import type { DocumentBlock } from "../../../shared/document.ts";
import { BUSINESS_TOOLS, BUSINESS_TOOL_NAMES, type BusinessStore, type BusinessToolName } from './business-tools.ts';

export const CLOUD_TOOLS: ToolDef[] = [
  ...BUSINESS_TOOLS,
  { type: "function", function: { name: "document_create", description: "创建通用文档并保存真实产物。blocks只接受heading(level,text)、paragraph(text,claimType,sourceIds)、list(items)、table(headers,rows)、image(data PNG/JPEG,alt)、chart(title,labels,values)、reference(sourceId)。外部事实须用web_fetch返回的sourceId，不可自填已核实来源。长文先分章节准备再创建；可用previousArtifactId追加同任务的新版本。", parameters: { type: "object", properties: { title: { type: "string" }, blocks: { type: "array", items: { type: "object" } }, sourceIds: { type: "array", items: { type: "string" } }, previousArtifactId: { type: "string" } }, required: ["title", "blocks"] } } },
  { type: "function", function: { name: "document_inspect", description: "读取本人文档的结构、版本、来源及可用导出格式。结构检查不代表内容事实/视觉均已验收。", parameters: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] } } },
  { type: "function", function: { name: "document_export", description: "把已保存文档真实导出为MD/DOCX/PDF，重开核对并缓存文件，返回字节哈希和授权下载路径。缺环境会明确报错；只有成功后才能声称可下载。", parameters: { type: "object", properties: { artifactId: { type: "string" }, format: { type: "string", enum: ["md", "docx", "pdf"] } }, required: ["artifactId", "format"] } } },
  { type: "function", function: { name: "read_artifact", description: "按artifactId分页读取本人任务生成的完整工具材料。offset从0开始，limit最多6000字符。", parameters: { type: "object", properties: { artifactId: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["artifactId"] } } },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "网页搜索（Bing），返回标题+链接+摘要。query 用具体名称/实体（如\"蓝桥杯 2026 报名\"\"中国大学生计算机设计大赛\"）而非泛词，具体赛名/机构名命中率更高；泛词（如单独年份）易跑偏。拿到候选后用 web_fetch 打开官网确认链接与赛程，不直接采信搜索摘要。",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "抓取指定真实公开 URL 的网页正文（服务端 SSRF 守卫：私网/元数据/重定向拦截）。用于核实来源。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_verification",
      description: "对机会提出核验提案（status 建议 + 证据列表）。不直接落 VERIFIED：证据须经独立 Evaluator 重抓核验后才升级。自填 VERIFIED 会被降级。",
      parameters: {
        type: "object",
        properties: {
          opportunityId: { type: "string" },
          proposedStatus: { type: "string", description: "VERIFIED/PARTIALLY_VERIFIED/UNVERIFIED/CONFLICTING/RISK_FLAGGED" },
          summary: { type: "string" },
          evidence: { type: "array", items: { type: "object", properties: { sourceUrl: { type: "string" }, excerpt: { type: "string" }, supports: { type: "string" }, confidence: { type: "number" } } } },
        },
        required: ["opportunityId", "proposedStatus", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_opportunity",
      description: "把一条机会写入机会雷达（持久保存，用户可在 Radar 页查看）。用于\"写入机会雷达/收藏这个机会/保存比赛\"。title 必填；deadline 用 YYYY-MM-DD；sourceUrl 填官网。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string", description: "competition/internship/scholarship/activity/notice/research/exchange/other" },
          organizer: { type: "string" },
          description: { type: "string" },
          conditions: { type: "array", items: { type: "string" } },
          deadline: { type: ["string", "null"], description: "YYYY-MM-DD；未知用null或省略，不要猜测日期" },
          sourceUrl: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_opportunities",
      description: "列出当前用户机会雷达里已保存的机会。用于\"看看我的雷达/已收藏的机会\"。",
      parameters: { type: "object", properties: {} },
    },
  },
];

export interface CloudToolCtx { taskId: string; userId: string; evidenceStore?: EvidenceStore; opportunityStore?: OpportunityStore; artifactStore?: ArtifactStore; documents?: DocumentService; businessStore?: BusinessStore; }

export async function executeCloudTool(name: string, args: Record<string, unknown>, ctx?: CloudToolCtx): Promise<string> {
  if (BUSINESS_TOOL_NAMES.includes(name as BusinessToolName)) {
    if (!ctx?.businessStore) return JSON.stringify({ error: '业务持久化服务未配置，需要 Postgres；未保存任何更改。' });
    try { return JSON.stringify(await ctx.businessStore.execute(name as BusinessToolName, args, { userId: ctx.userId, taskId: ctx.taskId })); }
    catch { return JSON.stringify({ error: '业务操作未能确认成功：请检查标题、日期、分类和本人数据访问权限，核实保存结果后重试。' }); }
  }
  if (["document_create", "document_inspect", "document_export"].includes(name)) {
    const documents = ctx?.documents ?? (ctx?.artifactStore ? new DocumentService(ctx.artifactStore) : undefined);
    if (!ctx || !documents) return JSON.stringify({ error: "文档持久化服务不可用" });
    try {
      if (name === "document_create") { const artifact = await documents.create(ctx.userId, ctx.taskId, { title: String(args.title ?? ""), blocks: args.blocks as DocumentBlock[], sourceIds: args.sourceIds as string[] | undefined, previousArtifactId: args.previousArtifactId as string | undefined }); return JSON.stringify({ artifactId: artifact.id, documentId: artifact.documentId, revision: artifact.revision, sha256: artifact.sha256, availableFormats: documents.formats(artifact.inline as import("../../../shared/document.ts").DocumentAst) }); }
      if (name === "document_inspect") return JSON.stringify(await documents.inspect(ctx.userId, String(args.artifactId ?? "")));
      if (!["md", "docx", "pdf"].includes(String(args.format))) return JSON.stringify({ error: "格式仅支持md/docx/pdf" });
      const artifact = await documents.export(ctx.userId, String(args.artifactId ?? ""), args.format as "md" | "docx" | "pdf"), file = documents.file(artifact);
      return JSON.stringify({ artifactId: artifact.id, sourceArtifactId: file.sourceArtifactId, format: args.format, mime: file.mime, bytes: file.bytes.length, sha256: file.sha256, downloadPath: `/v1/artifacts/${encodeURIComponent(file.sourceArtifactId)}/download?format=${args.format}` });
    } catch (e) { return JSON.stringify({ error: errorMessage(e) }); }
  }
  if (name === "read_artifact") {
    const artifact = ctx?.artifactStore ? await ctx.artifactStore.get(ctx.userId, String(args.artifactId ?? "")) : null;
    if (!artifact) return JSON.stringify({ error: "产物不存在或无权读取" });
    const inline = artifact.inline as { text?: string };
    const text = typeof inline?.text === "string" ? inline.text : JSON.stringify(artifact.inline);
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), limit = Math.min(6000, Math.max(1, Math.floor(Number(args.limit) || 4000)));
    return JSON.stringify({ artifactId: artifact.id, sha256: artifact.sha256, offset, text: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null, totalChars: text.length });
  }
  if (name === "web_search") {
    const limit = Math.min(Math.max(Number(args.limit ?? 6) || 6, 1), 10);
    return JSON.stringify(await searchPublicWeb(String(args.query ?? ''), limit));
  }
  if (name === "web_fetch") {
    try {
      const r = await safeFetch(String(args.url ?? ""));
      const text = htmlToText(r.text).slice(0, 12000);
      const sourceId = ctx?.artifactStore && r.status >= 200 && r.status < 300 ? await saveFetchedSource(ctx.artifactStore, ctx.userId, ctx.taskId, { url: r.url, text }) : undefined;
      return JSON.stringify({ url: r.url, status: r.status, text, truncated: r.truncated, sourceId });
    } catch (e) {
      return JSON.stringify({ error: errorMessage(e) });
    }
  }
  if (name === "propose_verification") {
    const proposed = String(args.proposedStatus ?? "UNVERIFIED") as VerificationStatus;
    const sanitized = sanitizeProposedStatus(proposed);
    const evidence = Array.isArray(args.evidence) ? (args.evidence as Record<string, unknown>[]) : [];
    const evidenceIds: string[] = [];
    if (ctx?.evidenceStore) {
      for (const e of evidence) {
        const rec = await ctx.evidenceStore.add({
          taskId: ctx.taskId, userId: ctx.userId,
          sourceUrl: String(e.sourceUrl ?? ""), excerpt: String(e.excerpt ?? ""),
          supports: String(e.supports ?? ""), confidence: Number(e.confidence ?? 0.5),
        });
        evidenceIds.push(rec.id);
      }
    }
    return JSON.stringify({
      ok: true,
      opportunityId: String(args.opportunityId ?? ""),
      proposedStatus: proposed,
      acceptedStatus: sanitized, // 模型自填 VERIFIED 已降级；最终 VERIFIED 由 Evaluator 核验后决定
      summary: String(args.summary ?? ""),
      evidenceIds,
      note: "提案已记录，证据待独立 Evaluator 重抓核验；VERIFIED 不由模型自判。",
    });
  }
  if (name === "save_opportunity") {
    if (!ctx?.opportunityStore) return JSON.stringify({ error: "机会存储未启用" });
    const title = String(args.title ?? "").trim();
    if (!title) return JSON.stringify({ error: "title 必填" });
    const rawDeadline = typeof args.deadline === 'string' ? args.deadline.trim() : args.deadline;
    const deadline = rawDeadline == null || rawDeadline === '' ? null : rawDeadline;
    if (deadline !== null && (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(deadline) || !Number.isFinite(Date.parse(deadline + 'T00:00:00Z')) || new Date(deadline + 'T00:00:00Z').toISOString().slice(0, 10) !== deadline)) return JSON.stringify({ error: '截止日期须为真实的YYYY-MM-DD日期，未知请用null或省略', class: 'tool_validation', field: 'deadline' });
    const rec = await ctx.opportunityStore.create({
      userId: ctx.userId,
      title,
      type: args.type ? String(args.type) : undefined,
      organizer: args.organizer ? String(args.organizer) : undefined,
      description: args.description ? String(args.description) : undefined,
      conditions: Array.isArray(args.conditions) ? (args.conditions as unknown[]).map(String) : undefined,
      deadline: deadline as string | null,
      sourceUrl: args.sourceUrl ? String(args.sourceUrl) : undefined,
    });
    return JSON.stringify({ ok: true, opportunity: rec, note: "已写入机会雷达，用户可在 Radar 页查看。" });
  }
  if (name === "list_opportunities") {
    if (!ctx?.opportunityStore) return JSON.stringify({ error: "机会存储未启用" });
    const items = await ctx.opportunityStore.listByUser(ctx.userId);
    return JSON.stringify({ opportunities: items.map((o) => ({ id: o.id, title: o.title, type: o.type, deadline: o.deadline, sourceUrl: o.sourceUrl, status: o.status })) });
  }
  return JSON.stringify({ error: `unknown cloud tool ${name}（本机能力需 Local Companion，云端默认禁用）` });
}
