// Search results are discovery hints, never verified facts. Reject obviously
// unrelated upstream hits rather than reporting an HTTP-200 page as good search.
export interface SearchHit { title: string; url: string; snippet: string; }
export interface SearchResponse { engine?: string; query?: string; results: SearchHit[]; error?: string; warning?: string; quality?: 'degraded' | 'filtered'; rejectedCount?: number; }
const strip = (text: string) => text.replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp|ensp);/g, s => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&ensp;': ' ' })[s] ?? s)
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => { const n = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value); return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }).replace(/\s+/g, ' ').trim();
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
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
  for (const block of blocks.length ? blocks : html.split(/(?=<h2\b)/i).slice(1)) {
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
  const stop = new Set(['官网', '报名', '报名通知', '通知', '近期', '最新', '大赛', '竞赛', '比赛', '大学生', '官网通知', '时间', 'official', 'competition', 'contest', 'registration', 'the', 'and', 'for']);
  const terms = query.replace(/\bsite:[^\s]+/gi, '').match(/[\p{Script=Han}]+|[a-zA-Z][a-zA-Z\d-]+/gu) ?? [];
  const keywords = terms.map(term => term.replace(/^(?:中国|全国|国家级)?大学生/, '').replace(/(?:大赛|竞赛|比赛|官网|通知|报名|平台|计划)+$/, '')).map(normalized).filter(term => term.length >= 2 && !stop.has(term));
  // No discriminating keyword: do not pretend lexical matching can establish
  // relevance. Let the model refine its query; site-only discovery is allowed.
  if (!keywords.length && !sites.length) return [];
  return hits.filter(hit => {
    const host = new URL(hit.url).hostname.toLowerCase();
    if (sites.length && !sites.some(site => host === site || host.endsWith('.' + site))) return false;
    const text = normalized(hit.title + ' ' + hit.snippet + ' ' + hit.url);
    return !keywords.length || keywords.some(term => text.includes(term));
  });
}
export async function searchPublicWeb(query: string, limit = 6, fetchImpl: typeof fetch = fetch): Promise<SearchResponse> {
  limit = Math.min(10, Math.max(1, Math.floor(Number(limit) || 6)));
  if (!query.trim() || query.length > 1000) return { error: '搜索关键词为空或过长', results: [] };
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const response = await fetchImpl(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(10, limit) + 2}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal,
    });
    if (!response.ok) return { engine: 'bing', error: `搜索服务返回HTTP ${response.status}，本轮没有可用检索结果`, results: [] };
    const reader = response.body?.getReader(); let html = '', size = 0;
    if (reader) { const decoder = new TextDecoder(); try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('response_too_large'); } html += decoder.decode(chunk.value, { stream: true }); } html += decoder.decode(); } finally { reader.releaseLock(); } }
    const candidates = parseSearchHits(html, 12), relevant = relevantSearchHits(query, candidates), results = relevant.slice(0, limit);
    const warning = !candidates.length ? '搜索页面未返回可解析结果，可能是页面变化或访问限制；请换关键词或直接核对官网。' : !results.length ? '上游检索结果与主题不匹配，已过滤无关条目；请改用具体名称、英文名或直接核对官网。' : results.length < Math.min(candidates.length, limit) ? '已过滤部分明显不相关的检索结果；其余仍需打开来源核实。' : undefined;
    return { engine: 'bing', query, results, ...(warning ? { warning, quality: !results.length ? 'degraded' as const : 'filtered' as const } : {}), rejectedCount: candidates.length - relevant.length };
  } catch { return { engine: 'bing', error: '搜索请求失败或超时，本轮没有可用检索结果；可换关键词或直接核对官网', results: [] }; }
  finally { clearTimeout(timer); }
}
