const PRIVATE_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254",
  "metadata.google.internal",
];

function isPrivateIp(host: string): boolean {
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

export interface UrlGuardResult {
  ok: boolean;
  reason?: string;
  normalized?: string;
}

export function guardUrl(raw: string): UrlGuardResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "无效 URL" };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, reason: "仅允许 http/https 公开协议" };
  }
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.includes(host) || isPrivateIp(host)) {
    return { ok: false, reason: "禁止访问 localhost/内网/云元数据地址" };
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "禁止访问内部域名" };
  }
  return { ok: true, normalized: url.toString() };
}

export const MAX_FETCH_BYTES = 2_000_000;
export const FETCH_TIMEOUT_MS = 15_000;