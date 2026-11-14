import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { guardUrl, isPrivateIp } from "./ssrf.ts";

export function isPublicAddress(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateIp(ip)) return false;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a < 224 && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19)) && !(a === 192 && b === 0);
  }
  // Public IPv6 unicast only; deny mapped IPv4, special and documentation ranges.
  return isIP(ip) === 6 && /^[23][a-f0-9]{3}:/.test(ip) && !/^(2001:db8:|2002:)/.test(ip);
}

export function providerUrl(raw: string): URL {
  const guard = guardUrl(raw);
  if (!guard.ok) throw new Error("模型地址必须为公开HTTPS地址");
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new Error("模型地址必须为公开HTTPS地址");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("模型地址必须为公开HTTPS，不能包含凭证、查询参数或片段");
  return url;
}

export function createPublicLookup(resolve = (host: string) => lookup(host, { all: true })): LookupFunction { return (host, options, callback) => {
  void resolve(host).then((addresses) => {
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) { callback(new Error("模型地址解析到非公开网络"), [], undefined as never); return; }
    if ((options as { all?: boolean }).all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }, (error) => callback(error, [], undefined as never));
}; }
export const publicLookup = createPublicLookup();

// HTTPS keeps original hostname/SNI. The connection uses the checked lookup result;
// redirects never receive Authorization and response-body reads retain AbortSignal.
export const providerFetch: typeof fetch = async (input, init) => {
  const url = providerUrl(String(input));
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init?.method ?? "POST", headers: Object.fromEntries(new Headers(init?.headers)), lookup: publicLookup, signal: init?.signal ?? undefined }, (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400) { incoming.resume(); reject(new Error("模型端点返回重定向，请填写最终API地址")); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on("error", reject);
    req.end(typeof init?.body === "string" ? init.body : undefined);
  });
};
