// 服务端 SSRF 守卫 + 安全抓取。修复 web 端 urlGuard 仅查初始 hostname 的缺口：
// DNS 解析后逐地址私网拦截（防 rebinding）、手动重定向逐跳复检、字节/超时上限。
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_FETCH_BYTES = 2_000_000;
export const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "169.254.169.254", "metadata.google.internal"]);

// 规范化 IP：十进制/八进制/十六进制整数 → 点分十进制；IPv6 映射 IPv4 提取。
function normalizeIp(host: string): string {
  let h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d+$/.test(h)) { const n = Number(h); if (n >= 0 && n <= 0xffffffff) return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); }
  if (/^0x[0-9a-f]+$/i.test(h)) { const n = parseInt(h, 16); return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); }
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  return h;
}

export function isPrivateIp(host: string): boolean {
  const h = normalizeIp(host);
  if (PRIVATE_HOSTS.has(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^127\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  if (h === "::1" || h === "::") return true;
  if (/^f[cd]/.test(h)) return true; // IPv6 ULA fc00::/7
  if (/^fe80:/.test(h)) return true; // link-local
  if (/^::ffff:/.test(h)) return isPrivateIp(h.replace(/^::ffff:/, ""));
  return false;
}

export interface UrlGuardResult { ok: boolean; reason?: string; normalized?: string; }

export function guardUrl(raw: string): UrlGuardResult {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "无效 URL" }; }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, reason: "仅允许 http/https 公开协议" };
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host) || isPrivateIp(host)) return { ok: false, reason: "禁止访问 localhost/内网/云元数据地址" };
  if (host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, reason: "禁止访问内部域名" };
  return { ok: true, normalized: url.toString() };
}

export type ResolveFn = (host: string) => Promise<{ address: string }[]>;
const defaultResolve: ResolveFn = (host) => lookup(host, { all: true });

// DNS 解析后逐地址私网拦截（防 DNS rebinding）。IP 字面量直接判定。
export async function assertPublicHost(host: string, resolve: ResolveFn = defaultResolve): Promise<void> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(h)) { if (isPrivateIp(h)) throw new Error(`SSRF 拦截：私网地址 ${h}`); return; }
  if (PRIVATE_HOSTS.has(h) || h.endsWith(".local") || h.endsWith(".internal")) throw new Error(`SSRF 拦截：内部主机 ${h}`);
  const addrs = await resolve(h);
  if (!addrs.length) throw new Error(`SSRF 拦截：无法解析 ${h}`);
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error(`SSRF 拦截：${h} 解析到私网 ${a.address}`);
}

export interface SafeFetchOpts { fetchImpl?: typeof fetch; resolve?: ResolveFn; maxBytes?: number; timeoutMs?: number; }
export interface SafeFetchResult { status: number; url: string; text: string; truncated: boolean; }

// 安全抓取：每跳（含重定向）先 guardUrl + DNS 私网拦截，再请求；流式字节截断；超时。
export async function safeFetch(rawUrl: string, opts: SafeFetchOpts = {}): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolve = opts.resolve ?? defaultResolve;
  const maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const g = guardUrl(current);
    if (!g.ok) throw new Error(`SSRF 拦截：${g.reason}`);
    const u = new URL(g.normalized!);
    await assertPublicHost(u.hostname, resolve);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(u.toString(), { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "CampusMate" } });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("重定向缺少 Location");
      current = new URL(loc, u).toString();
      continue; // 下一跳重新 guardUrl + DNS 拦截
    }
    const { text, truncated } = await readCapped(res, maxBytes);
    return { status: res.status, url: u.toString(), text, truncated };
  }
  throw new Error(`SSRF 拦截：重定向超过 ${MAX_REDIRECTS} 跳`);
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) { const t = await res.text(); return { text: t.slice(0, maxBytes), truncated: t.length > maxBytes }; }
  const chunks: Uint8Array[] = [];
  let total = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { chunks.push(value.subarray(0, Math.max(0, maxBytes - (total - value.byteLength)))); truncated = true; await reader.cancel(); break; }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: buf.toString("utf8"), truncated };
}

// HTML → 纯文本（去 script/style/标签）。
export function htmlToText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}