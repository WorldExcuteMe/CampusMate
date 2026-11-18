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
const discoveryWordsToSkip = new Set("a an and access academic about analysis articles as by for from how impact in into is journal of on open or pdf research results study studies the through to using what with".split(" "));
function discoveryWords(text: string): string[] {
  const terms = text.toLowerCase().replace(/\b(?:site|filetype):\S+/g, " ").match(/[a-z][a-z0-9-]+/g) ?? [];
  return [...new Set(terms.filter(word => !discoveryWordsToSkip.has(word)))];
}
function discoveryTopic(query: string): string[] {
  return /[\u3400-\u9fff]/.test(query) ? [] : discoveryWords(query);
}

export function relevantSearchHits(query: string, hits: SearchHit[]): SearchHit[] {
  const terms = discoveryTopic(query);
  const sites = [...query.matchAll(/\bsite:([^\s]+)/gi)].map(m => m[1].toLowerCase().replace(/^www\./, ''));
  return hits.filter(hit => {
    let url: URL; try { url = new URL(hit.url); } catch { return false; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (sites.length && !sites.some(site => host === site || host.endsWith('.' + site))) return false;
    if (terms.length < 4) return matchesInformationRequest(query, hit.title + ' ' + hit.snippet + ' ' + hit.url);
    const visible = new Set(discoveryWords(hit.title + ' ' + hit.snippet));
    return terms.filter(word => visible.has(word)).length >= Math.ceil(terms.length / 3);
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
    const terms = discoveryTopic(query);
    const operators = query.match(/\b(?:site|filetype):\S+|\b\d{4}\.\.\d{4}\b/gi) ?? [];
    const fallback = terms.length >= 4 ? [...terms.slice(0, 12), ...operators].join(" ")
      : focus ? `"${focus}"` : /竞赛|大赛|比赛/.test(query) && broad ? `"${broad}"` : undefined;
    if (!results.length && fallback && fallback !== query.trim() && !ctrl.signal.aborted) results = relevant(await search(fallback), query);
    return { engine: "bing", query, effectiveQuery, attempts, results: results.slice(0, limit), ...(!results.length ? { warning: "未取得与主题相关的搜索结果；这不代表目标不存在，可简化关键词或查官方入口。" } : {}) };
  } catch (error) { return { engine: "bing", query, effectiveQuery, attempts, results: [], error: `web_search 失败：${errorMessage(error)}` }; }
  finally { clearTimeout(timer); }
}

interface OpenScholarlyLocation {
  landing_page_url?: string;
  is_oa?: boolean;
  source?: { display_name?: string };
}

function scholarlyLandingPage(location?: OpenScholarlyLocation): string | undefined {
  if (location?.is_oa !== true || typeof location.landing_page_url !== "string") return;
  const url = destination(location.landing_page_url);
  if (url && !["doi.org", "dx.doi.org", "openalex.org"].includes(new URL(url).hostname)) return url;
}

interface OpenScholarlyWork {
  display_name?: string;
  doi?: string;
  publication_year?: number;
  best_oa_location?: OpenScholarlyLocation;
  locations?: OpenScholarlyLocation[];
}

export async function searchOpenScholarlyWeb(query: string, limit: number, fromYear?: number) {
  const base = { engine: "openalex", query, evidence: "metadata" as const };
  if (!validScholarlyQuery(query, fromYear)) {
    return { ...base, results: [], error: "请提供公开学术检索词及有效的起始出版年份。" };
  }
  const rows = Math.min(10, Math.max(1, Math.floor(limit) || 6));
  const filters = ["is_oa:true"];
  if (fromYear !== undefined) filters.push(`from_publication_date:${fromYear}-01-01`);
  const url = new URL("https://api.openalex.org/works");
  url.search = new URLSearchParams({
    search: query,
    filter: filters.join(","),
    per_page: String(rows),
    select: "display_name,doi,publication_year,best_oa_location,locations",
  }).toString();
  const signal = AbortSignal.timeout(12000);
  try {
    const response = await abortable(fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { ...base, results: [], error: "开放获取索引返回 HTTP " + response.status };
    }
    const body = JSON.parse(await responseText(response, signal, 400_000)) as { results?: OpenScholarlyWork[] };
    const seen = new Set<string>();
    const results = (body.results ?? []).slice(0, rows).flatMap(work => {
      const location = work.best_oa_location;
      const alternatives = Array.isArray(work.locations) ? work.locations.slice(0, 20).map(scholarlyLandingPage) : [];
      const href = scholarlyLandingPage(location) ?? alternatives.find(Boolean);
      const title = typeof work.display_name === "string" ? work.display_name.trim() : "";
      if (!href || !title || seen.has(href)) return [];
      seen.add(href);
      const hostname = new URL(href).hostname;
      const alternativeUrl = alternatives.find(url => url && new URL(url).hostname !== hostname);
      return { title: title.slice(0, 400), url: href, ...(alternativeUrl ? { alternativeUrl } : {}), doi: work.doi, year: work.publication_year, snippet: location?.source?.display_name?.slice(0, 200) ?? "" };
    });
    return { ...base, results, warning: results.length ? "开放获取索引提供来源入口。请用 web_fetch 确认可读正文后再引用。" : "索引没有返回开放获取来源入口。" };
  } catch (error) {
    return { ...base, results: [], error: "开放获取检索失败：" + errorMessage(error) };
  }
}

function validScholarlyQuery(query: string, fromYear?: number): boolean {
  return Boolean(query.trim()) && query.length <= 1000
    && (fromYear === undefined || (Number.isInteger(fromYear) && fromYear >= 1000 && fromYear <= 9999));
}

interface ScholarlyMetadata {
  DOI?: string;
  title?: string[];
  published?: { "date-parts"?: number[][] };
  "container-title"?: string[];
}

export async function searchScholarlyWeb(query: string, limit: number, fromYear?: number) {
  const base = { engine: "crossref", query, evidence: "metadata" as const };
  if (!validScholarlyQuery(query, fromYear)) {
    return { ...base, results: [], error: "请提供公开学术检索词及有效的起始出版年份。" };
  }
  const rows = Math.min(10, Math.max(1, Math.floor(limit) || 6));
  const url = new URL("https://api.crossref.org/works");
  url.search = new URLSearchParams({
    "query.bibliographic": query,
    rows: String(rows),
    select: "DOI,title,published,container-title",
    ...(fromYear === undefined ? {} : { filter: "from-pub-date:" + fromYear + "-01-01" }),
  }).toString();
  const signal = AbortSignal.timeout(12000);
  try {
    const response = await abortable(fetch(url, { headers: { Accept: "application/json", "User-Agent": "CampusMate scholarly search" }, redirect: "error", signal }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return { ...base, results: [], error: "学术索引返回 HTTP " + response.status };
    }
    const body = JSON.parse(await responseText(response, signal, 200_000)) as { message?: { items?: ScholarlyMetadata[] } };
    const seen = new Set<string>();
    const results = (body.message?.items ?? []).slice(0, rows).flatMap(work => {
      const doi = work.DOI;
      const title = work.title?.[0]?.trim();
      if (typeof doi !== "string" || !/^10\.\d{4,9}\/[^\s]+$/i.test(doi) || !title || seen.has(doi.toLowerCase())) return [];
      seen.add(doi.toLowerCase());
      const year = work.published?.["date-parts"]?.[0]?.[0];
      return { title: title.slice(0, 400), doi, url: "https://doi.org/" + doi.split("/").map(encodeURIComponent).join("/"), year, snippet: work["container-title"]?.[0]?.slice(0, 200) ?? "" };
    });
    return { ...base, results, warning: results.length ? "这些是出版元数据。请打开可公开读取的出版方或机构正文，核实访问条件和结论。" : "学术索引没有返回可追溯条目。" };
  } catch (error) {
    return { ...base, results: [], error: "学术检索失败：" + errorMessage(error) };
  }
}
