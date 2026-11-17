import { errorMessage } from "./errors.ts";
import { abortable, responseText } from "./llm-stream.ts";
import { informationTopic, matchesInformationRequest } from "./source-match.ts";
// Search results are discovery hints, never verified facts. Reject obviously
// unrelated upstream hits rather than reporting an HTTP-200 page as good search.
export interface SearchHit { title: string; url: string; snippet: string; }
export interface SearchResponse { engine?: string; query?: string; results: SearchHit[]; error?: string; warning?: string; quality?: 'degraded' | 'filtered'; rejectedCount?: number; }
const strip = (text: string) => text.replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp|ensp);/g, s => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&ensp;': ' ' })[s] ?? s)
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => { const n = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value); return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }).replace(/\s+/g, ' ').trim();
function destination(raw: string): string | undefined {
  try {
    let url = new URL(strip(raw));
    if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u'); if (!encoded?.startsWith('a1')) return;
      url = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}
export function parseSearchHits(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [], seen = new Set<string>();
  const blocks = [...html.matchAll(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
  // Support minimal provider fixture HTML as well as Bing's result containers.
  for (const block of blocks.length ? blocks : html.split(/(?=<h2\b)/i).filter(part => /^<h2\b/i.test(part))) {
    const match = block.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!match) continue; const url = destination(match[1]), title = strip(match[2]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url); hits.push({ title, url, snippet: strip(block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '').slice(0, 800) });
    if (hits.length >= limit) break;
  }
  return hits;
}
export function relevantSearchHits(query: string, hits: SearchHit[]): SearchHit[] {
  const sites = [...query.matchAll(/\bsite:([^\s]+)/gi)].map(m => m[1].toLowerCase().replace(/^www\./, ''));
  return hits.filter(hit => {
    let url: URL; try { url = new URL(hit.url); } catch { return false; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return (!sites.length || sites.some(site => host === site || host.endsWith('.' + site))) && matchesInformationRequest(query, hit.title + ' ' + hit.snippet + ' ' + hit.url);
  });
}
export async function searchPublicWeb(query: string, limit = 6, fetchImpl: typeof fetch = fetch): Promise<SearchResponse> {
  limit = Math.min(10, Math.max(1, Math.floor(Number(limit) || 6)));
  if (!query.trim() || query.length > 1000) return { error: '搜索关键词为空或过长', results: [] };
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const response = await abortable(fetchImpl(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(10, limit) + 2}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal,
    }), ctrl.signal);
    if (!response.ok) return { engine: 'bing', error: `搜索服务返回HTTP ${response.status}，本轮没有可用检索结果`, results: [] };
    const html = await responseText(response, ctrl.signal, 2_000_000);
    const candidates = parseSearchHits(html, 12), relevant = relevantSearchHits(query, candidates), results = relevant.slice(0, limit);
    const warning = !candidates.length ? '搜索页面未返回可解析结果，可能是页面变化或访问限制；请换关键词或直接核对官网。' : !results.length ? '上游检索结果与主题不匹配，已过滤无关条目；请改用具体名称、英文名或直接核对官网。' : results.length < Math.min(candidates.length, limit) ? '已过滤部分明显不相关的检索结果；其余仍需打开来源核实。' : undefined;
    return { engine: 'bing', query, results, ...(warning ? { warning, quality: !results.length ? 'degraded' as const : 'filtered' as const } : {}), rejectedCount: candidates.length - relevant.length };
  } catch { return { engine: 'bing', error: '搜索请求失败或超时，本轮没有可用检索结果；可换关键词或直接核对官网', results: [] }; }
  finally { clearTimeout(timer); }
}

const relevant = (results: SearchHit[], query: string) => relevantSearchHits(query, results);
export async function searchWeb(query: string, limit = 6) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 12000);
  let attempts = 0, effectiveQuery = query;
  try {
    const search = async (q: string) => {
      attempts++; effectiveQuery = q;
      const res = await abortable(fetch(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=${Math.min(limit + 4, 14)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36", "Accept-Language": "zh-CN,zh;q=0.9" }, signal: ctrl.signal,
      }), ctrl.signal);
      if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new Error(`搜索引擎 HTTP ${res.status}`); }
      return parseSearchHits(await responseText(res, ctrl.signal, 2_000_000), 30);
    };
    const focus = informationTopic(query);
    let results = relevant(await search(query), query);
    const broad = query.replace(/20\d{2}\s*年?|官网|官方/g, " ").replace(/\s+/g, " ").trim();
    const fallback = focus ? `"${focus}"` : /竞赛|大赛|比赛/.test(query) && broad ? `"${broad}"` : undefined;
    if (!results.length && fallback && fallback !== query.trim() && !ctrl.signal.aborted) results = relevant(await search(fallback), query);
    return { engine: "bing", query, effectiveQuery, attempts, results: results.slice(0, limit), ...(!results.length ? { warning: "未取得与主题相关的搜索结果；这不代表目标不存在，可简化关键词或查官方入口。" } : {}) };
  } catch (error) { return { engine: "bing", query, effectiveQuery, attempts, results: [], error: `web_search 失败：${errorMessage(error)}` }; }
  finally { clearTimeout(timer); }
}
