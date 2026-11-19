// 最小云端工具集（Phase 7 Capability Registry 前的可用基线）。仅含无本机依赖的安全云工具。
// web_search 用固定搜索引擎 URL（无 SSRF 面）；本机能力（terminal/fs/QQ/微信）不在此（仅 Local Companion）。
import type { ToolDef } from "./types.ts";
import { errorMessage } from "./errors.ts";
import { safeFetchWithRetry, webPageText } from "./ssrf.ts";
import type { EvidenceStore } from "./evidence.ts";
import type { OpportunityStore } from "./opportunity-store.ts";
import { sanitizeProposedStatus, type VerificationStatus } from "./verification.ts";
import type { ArtifactStore } from "./storage-contracts.ts";
import { DocumentService, saveFetchedSource } from "./document-service.ts";
import type { DocumentBlock } from "../../../shared/document.ts";
import { searchOpenScholarlyWeb, searchScholarlyWeb, searchWeb } from "./web-search.ts";
import type { CampusRecords, InboxInput } from "./campus-records.ts";
import { BUSINESS_TOOLS, BUSINESS_TOOL_NAMES, type BusinessStore, type BusinessToolName } from './business-tools.ts';
import { TOOL_SPECS } from "./tool-registry.ts";

const blockText = { type: "string" };
const blockStrings = { type: "array", items: blockText };
const blockCitations = { sourceIds: blockStrings, claimType: { type: "string", enum: ["proposal", "fact", "estimate", "unverified"] } };
const blockFields = {
  heading: { level: { type: "integer", enum: [1, 2, 3] }, text: blockText },
  paragraph: { text: blockText, ...blockCitations },
  list: { items: blockStrings, ordered: { type: "boolean" }, ...blockCitations },
  table: { headers: blockStrings, rows: { type: "array", items: blockStrings }, ...blockCitations },
  image: { src: blockText, alt: blockText, caption: blockText },
  chart: { title: blockText, labels: blockStrings, values: { type: "array", items: { type: "number" } } },
  reference: { sourceId: blockText },
};
const blockSchema = {
  type: "object",
  required: ["type"],
  properties: {
    ...Object.assign({}, ...Object.values(blockFields)),
    type: { type: "string", enum: Object.keys(blockFields), description: "Identifies the structure of this block." },
  },
};

export const CLOUD_TOOLS: ToolDef[] = [
  ...BUSINESS_TOOLS.filter(tool => tool.function.name !== "save_to_inbox"),
  { type: "function", function: { name: "list_inbox", description: "只读列出本人信息中心的已有通知（含itemId和截止）。用户要改刚才/已有通知时先从历史实际结果或本工具取得itemId；不得猜ID或用新建代替更新。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "update_inbox", description: "按已有itemId更新本人待确认通知的截止日期/时间；保留原id、原文、标题，不会新建。用于更正刚才那条的截止，日期变动也必须更新而不是save_to_inbox。itemId须来自真实保存/列表结果；已确认记录由用户人工修改。", parameters: { type: "object", properties: { itemId: { type: "string" }, deadline: { type: "string", description: "最新截止YYYY-MM-DD或ISO时间" }, deadlineTime: { type: "string", description: "北京时间HH:mm；未知不填" } }, required: ["itemId", "deadline"] } } },
  { type: "function", function: { name: "save_to_inbox", description: "把用户明确要求保存的通知写入信息中心Inbox（与机会雷达不同）。先预览，用户明确要求保存后再调用。保留通知原文/更正依据、最新截止、地点和材料；未知链接/主办方不可补造。重复相同标题+截止+地点仅保留一条，待用户确认。", parameters: { type: "object", properties: { title: { type: "string" }, rawText: { type: "string" }, summary: { type: "string" }, category: { type: "string" }, deadline: { type: ["string", "null"], description: "截止日期YYYY-MM-DD；有时分优先用deadlineTime，未知不填" }, deadlineTime: { type: "string", description: "北京时间HH:mm，例如18:00；勿将本地18点误写为18:00Z；未知不填" }, location: { type: "string" }, sourceUrl: { type: "string" }, materials: { type: "array", items: { type: "string" } } }, required: ["title"] } } },
  { type: "function", function: { name: "document_create", description: "创建通用文档并保存真实产物。每块必须有顶层 type。示例 {\"type\":\"heading\",\"level\":2,\"text\":\"标题\"}，{\"type\":\"table\",\"headers\":[\"列名\"],\"rows\":[[\"内容\"]]}。paragraph 传 text，list 传 items，image 传 src（PNG/JPEG data URL）与 alt，chart 传 title、labels、values，reference 传 sourceId。外部事实须用web_fetch返回的sourceId，不可自填已核实来源。长文先分章节准备再创建；可用previousArtifactId追加同任务的新版本。", parameters: { type: "object", properties: { title: { type: "string" }, blocks: { type: "array", items: blockSchema }, sourceIds: { type: "array", items: { type: "string" } }, previousArtifactId: { type: "string" } }, required: ["title", "blocks"] } } },
  { type: "function", function: { name: "document_inspect", description: "读取本人文档的结构、版本、来源及可用导出格式。结构检查不代表内容事实/视觉均已验收。", parameters: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] } } },
  { type: "function", function: { name: "document_export", description: "把已保存文档真实导出为MD/DOCX/PDF，重开核对并缓存文件，返回字节哈希和授权下载路径。缺环境会明确报错；只有成功后才能声称可下载。", parameters: { type: "object", properties: { artifactId: { type: "string" }, format: { type: "string", enum: ["md", "docx", "pdf"] } }, required: ["artifactId", "format"] } } },
  { type: "function", function: { name: "read_artifact", description: "按artifactId分页读取本人任务生成的完整工具材料。offset从0开始，limit最多6000字符。", parameters: { type: "object", properties: { artifactId: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["artifactId"] } } },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "返回可核对来源的检索线索。网页默认用 Bing，query 保留具体实体和主题词；查学术论文用 scholarly。需要公开正文入口时设置 openAccessOnly（OpenAlex），普通学术索引为 Crossref。学术索引是元数据线索，须用 web_fetch 读到正文后才引用。",
      parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, scope: { type: "string", enum: ["web", "scholarly"] }, fromYear: { type: "integer", description: "scholarly 检索的最早出版年份" }, openAccessOnly: { type: "boolean", description: "scholarly 仅查开放获取来源入口" } }, required: ["query"] },
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

export interface CloudToolCtx { taskId: string; userId: string; intent?: string; businessStore?: BusinessStore; campusRecords?: CampusRecords; evidenceStore?: EvidenceStore; opportunityStore?: OpportunityStore; artifactStore?: ArtifactStore; documents?: DocumentService; }

export async function executeCloudTool(name: string, args: Record<string, unknown>, ctx?: CloudToolCtx): Promise<string> {
  const noPersistence = /只.*预览|(?:不要|不|勿)(?:写入|保存)(?:到任何|任何|[，。；！？\s]|$)|(?:不要|不|勿)(?:创建|生成|保存)(?:任何)?(?:文件|文档)/.test(ctx?.intent ?? "");
  if (TOOL_SPECS[name]?.permission.startsWith("write_") && noPersistence) return JSON.stringify({ error: "用户要求只预览或不持久化，禁止写入" });
  if (["save_to_inbox", "update_inbox", "save_opportunity"].includes(name) && ctx?.intent && /(?:不要|不|勿)(?:写入|保存)|只.*预览/.test(ctx.intent)) return JSON.stringify({ error: "用户要求只预览，禁止写入" });
  if (BUSINESS_TOOL_NAMES.includes(name as BusinessToolName) && (name !== "save_to_inbox" || !ctx?.campusRecords)) {
    if (!ctx?.businessStore) return JSON.stringify({ error: '业务持久化服务未配置，需要 Postgres；未保存任何更改。' });
    try { return JSON.stringify(await ctx.businessStore.execute(name as BusinessToolName, args, { userId: ctx.userId, taskId: ctx.taskId })); }
    catch { return JSON.stringify({ error: '业务操作未能确认成功：请检查标题、日期、分类和本人数据访问权限，核实保存结果后重试。' }); }
  }
  if (name === "list_inbox" || name === "update_inbox") {
    if (!ctx?.campusRecords) return JSON.stringify({ error: "信息中心服务不可用，尚未更新" });
    try {
      if (name === "list_inbox") return JSON.stringify({ ok: true, items: await ctx.campusRecords.listInbox(ctx.userId) });
      return JSON.stringify({ ok: true, destination: "inbox", item: await ctx.campusRecords.updateInboxDeadline(ctx.userId, String(args.itemId ?? ""), args as Pick<InboxInput, "deadline" | "deadlineTime">, ctx.intent ?? ""), note: "已更新实际已有记录，未新增；原始通知保留，请以item实际字段为准。" });
    } catch (error) { return JSON.stringify({ error: errorMessage(error) }); }
  }
  if (name === "save_opportunity" && ctx?.intent && /信息中心|inbox/i.test(ctx.intent) && !/雷达|机会中心/.test(ctx.intent)) return JSON.stringify({ error: "信息中心和机会雷达是不同去处，请使用save_to_inbox" });
  if (name === "save_to_inbox") {
    if (!ctx?.campusRecords) return JSON.stringify({ error: "信息中心持久化不可用，尚未保存" });
    const rawText = typeof args.rawText === "string" && args.rawText.trim() ? args.rawText : typeof args.summary === "string" && args.summary.trim() ? [ctx.intent, args.summary, args.source].filter(value => typeof value === "string" && value.trim()).join("\n") : "";
    if (!rawText) return JSON.stringify({ error: "通知需要rawText原文或非空summary，未保存任何更改" });
    args = { ...args, rawText, ...(!args.sourceUrl && typeof args.source === "string" && /^https?:\/\//i.test(args.source) ? { sourceUrl: args.source } : {}) };
    // Backward compatibility for saved/checkpointed calls using the old tool.
    // An explicit update may resolve exactly one literal title, never insert.
    if (ctx.intent && /只更新|更新已有|不要新增|不新增/.test(ctx.intent)) {
      const heading = [...String(args.rawText ?? "").matchAll(/【([^【】\n]{2,200})】/g)].map(match => match[1].trim());
      const titles = new Set([String(args.title ?? "").trim(), ...heading]);
      const matches = (await ctx.campusRecords.listInbox(ctx.userId)).filter(item => titles.has(String(item.extracted.title)) && (!args.location || args.location === item.extracted.location));
      if (matches.length !== 1) return JSON.stringify({ error: "未找到唯一已有记录，不能新建；请list_inbox核对itemId，再用update_inbox。" });
      try { return JSON.stringify({ ok: true, destination: "inbox", item: await ctx.campusRecords.updateInboxDeadline(ctx.userId, matches[0].id, args as Pick<InboxInput, "deadline" | "deadlineTime">, ctx.intent), note: "已更新唯一匹配的已有记录，未新增；原文保留。" }); }
      catch (error) { return JSON.stringify({ error: errorMessage(error) }); }
    }
    try { return JSON.stringify({ ok: true, destination: "inbox", item: await ctx.campusRecords.saveInbox(ctx.userId, args as unknown as InboxInput, ctx.intent), note: "已取得信息中心中的实际记录；重复条目复用，已确认状态不会自动覆盖，请以item中的字段为准。" }); }
    catch (error) { return JSON.stringify({ error: errorMessage(error) }); }
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
    const sourceArchive = artifact.kind === "linked-source";
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = Math.min(sourceArchive ? 3500 : 6000, Math.max(1, Math.floor(Number(args.limit) || (sourceArchive ? 1500 : 4000))));
    return JSON.stringify({ artifactId: artifact.id, sha256: artifact.sha256, offset, text: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null, totalChars: text.length });
  }
  if (name === "web_search") {
    const query = String(args.query ?? "");
    const limit = Math.min(Math.max(Number(args.limit ?? 6) || 6, 1), 10);
    if (args.scope !== "scholarly") return JSON.stringify(await searchWeb(query, limit));
    const fromYear = typeof args.fromYear === "number" ? args.fromYear : undefined;
    const search = args.openAccessOnly === true ? searchOpenScholarlyWeb : searchScholarlyWeb;
    return JSON.stringify(await search(query, limit, fromYear));
  }
  if (name === "web_fetch") {
    try {
      const r = await safeFetchWithRetry(String(args.url ?? ""));
      const text = webPageText(r.text, r.status).slice(0, 12000);
      if (!text.trim()) return JSON.stringify({ url: r.url, status: r.status, readable: false, class: "source_unavailable", error: r.status < 200 || r.status >= 300 ? `网页返回HTTP ${r.status}，未取得可用于核实的正文。` : "未取得可读网页正文；页面可能只有标题或依赖JavaScript渲染，不能据此核实事实。" });
      const sourceId = ctx?.artifactStore && r.status >= 200 && r.status < 300 ? await saveFetchedSource(ctx.artifactStore, ctx.userId, ctx.taskId, { url: r.url, text }) : undefined;
      return JSON.stringify({ url: r.url, status: r.status, readable: true, text, truncated: r.truncated, sourceId });
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


