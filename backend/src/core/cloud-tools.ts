// 最小云端工具集（Phase 7 Capability Registry 前的可用基线）。仅含无本机依赖的安全云工具。
// web_search 用固定搜索引擎 URL（无 SSRF 面）；本机能力（terminal/fs/QQ/微信）不在此（仅 Local Companion）。
import type { ToolDef } from "./types.ts";
import { errorMessage } from "./errors.ts";
import { safeFetch, htmlToText } from "./ssrf.ts";
import type { EvidenceStore } from "./evidence.ts";
import { sanitizeProposedStatus, type VerificationStatus } from "./verification.ts";

export const CLOUD_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "广泛网页搜索（真实搜索引擎），返回标题+链接+摘要。用于收集公开信息。",
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
];

export interface CloudToolCtx { taskId: string; userId: string; evidenceStore?: EvidenceStore; }

export async function executeCloudTool(name: string, args: Record<string, unknown>, ctx?: CloudToolCtx): Promise<string> {
  if (name === "web_search") {
    try {
      const query = String(args.query ?? "");
      const limit = Number(args.limit ?? 6);
      const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      const html = await r.text();
      const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const results: { title: string; url: string; snippet: string }[] = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && results.length < limit) {
        let href = m[1];
        const u = href.match(/uddg=([^&]+)/);
        if (u) href = decodeURIComponent(u[1]);
        if (!/^https?:/.test(href)) continue;
        results.push({ title: strip(m[2]), url: href, snippet: strip(m[3]) });
      }
      return JSON.stringify({ results });
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
  return JSON.stringify({ error: `unknown cloud tool ${name}（本机能力需 Local Companion，云端默认禁用）` });
}