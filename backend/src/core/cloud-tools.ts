// 最小云端工具集（Phase 7 Capability Registry 前的可用基线）。仅含无本机依赖的安全云工具。
// web_search 用固定搜索引擎 URL（无 SSRF 面）；本机能力（terminal/fs/QQ/微信）不在此（仅 Local Companion）。
import type { ToolDef } from "./types.ts";
import { errorMessage } from "./errors.ts";
import { safeFetch, htmlToText } from "./ssrf.ts";
import type { EvidenceStore } from "./evidence.ts";
import type { OpportunityStore } from "./opportunity-store.ts";
import { sanitizeProposedStatus, type VerificationStatus } from "./verification.ts";

export const CLOUD_TOOLS: ToolDef[] = [
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
          deadline: { type: "string", description: "YYYY-MM-DD 或 null" },
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

export interface CloudToolCtx { taskId: string; userId: string; evidenceStore?: EvidenceStore; opportunityStore?: OpportunityStore; }

export async function executeCloudTool(name: string, args: Record<string, unknown>, ctx?: CloudToolCtx): Promise<string> {
  if (name === "web_search") {
    // 搜索引擎用 Bing 中国（DDG 在国内网络不可达会挂起）。fetch 自带 12s 超时，先于 Worker 15s 兜底自 abort。
    try {
      const query = String(args.query ?? "");
      const limit = Math.min(Math.max(Number(args.limit ?? 6) || 6, 1), 10);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      let html: string;
      try {
        const r = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${limit + 2}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9",
          },
          signal: ctrl.signal,
        });
        html = await r.text();
      } finally {
        clearTimeout(timer);
      }
      const strip = (s: string) => s
        .replace(/<[^>]+>/g, "")
        .replace(/&ensp;/g, " ").replace(/&#0183;/g, "·").replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/\s+/g, " ").trim();
      const results: { title: string; url: string; snippet: string }[] = [];
      const re = /<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>(?:<div class="b_caption"><p[^>]*>([\s\S]*?)<\/p>)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && results.length < limit) {
        const url = m[1];
        if (!/^https?:/.test(url)) continue;
        results.push({ title: strip(m[2]), url, snippet: strip(m[3] ?? "") });
      }
      return JSON.stringify({ engine: "bing", results });
    } catch (e) {
      return JSON.stringify({ error: `web_search 失败：${errorMessage(e)}`, results: [] });
    }
  }
  if (name === "web_fetch") {
    try {
      const r = await safeFetch(String(args.url ?? ""));
      return JSON.stringify({ url: r.url, status: r.status, text: htmlToText(r.text).slice(0, 12000), truncated: r.truncated });
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
    const rec = await ctx.opportunityStore.create({
      userId: ctx.userId,
      title,
      type: args.type ? String(args.type) : undefined,
      organizer: args.organizer ? String(args.organizer) : undefined,
      description: args.description ? String(args.description) : undefined,
      conditions: Array.isArray(args.conditions) ? (args.conditions as unknown[]).map(String) : undefined,
      deadline: args.deadline ? String(args.deadline) : null,
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