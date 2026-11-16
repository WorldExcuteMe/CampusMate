import { errorMessage } from "./errors.ts";
import { abortable, responseText } from "./llm-stream.ts";
import { informationTopic, matchesTopic } from "./source-match.ts";
interface SearchResult { title: string; url: string; snippet: string; }
const decode = (s: string) => s.replace(/&(?:ensp|nbsp);/g, " ").replace(/&#0183;/g, "·").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const re = /<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>(?:\s*<div class="b_caption"><p[^>]*>([\s\S]*?)<\/p>)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && results.length < 30) {
    const url = decode(match[1]); if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title: strip(match[2]), url, snippet: strip(match[3] ?? "") });
  }
  return results;
}
function relevant(results: SearchResult[], focus?: string) {
  return results.filter(result => matchesTopic(focus, result.title + " " + result.snippet));
}
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
      return parseResults(await responseText(res, ctrl.signal, 2_000_000));
    };
    const focus = informationTopic(query);
    let results = relevant(await search(query), focus);
    const fallback = focus ? `"${focus}"` : undefined;
    if (!results.length && fallback && fallback !== query.trim() && !ctrl.signal.aborted) results = relevant(await search(fallback), focus);
    return { engine: "bing", query, effectiveQuery, attempts, results: results.slice(0, limit), ...(!results.length ? { warning: "未取得与主题相关的搜索结果；这不代表目标不存在，可简化关键词或查官方入口。" } : {}) };
  } catch (error) { return { engine: "bing", query, effectiveQuery, attempts, results: [], error: `web_search 失败：${errorMessage(error)}` }; }
  finally { clearTimeout(timer); }
}
