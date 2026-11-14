import { test } from "node:test";
import assert from "node:assert/strict";
import { guardUrl, isPrivateIp, assertPublicHost, safeFetch, htmlToText } from "./ssrf.ts";

const publicResolve = async () => [{ address: "93.184.216.34" }];
const privateResolve = async () => [{ address: "127.0.0.1" }];

test("guardUrl 拦截私网/元数据/内部域/非 http", () => {
  for (const bad of ["http://127.0.0.1/x", "http://localhost/", "http://169.254.169.254/latest", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/", "http://metadata.google.internal/", "http://foo.local/", "http://foo.internal/", "ftp://example.com/", "file:///etc/passwd"]) {
    assert.equal(guardUrl(bad).ok, false, bad);
  }
  assert.equal(guardUrl("https://example.com/page").ok, true);
});

test("isPrivateIp 识别十进制/十六进制/IPv6 映射绕过", () => {
  assert.equal(isPrivateIp("2130706433"), true); // 127.0.0.1 十进制
  assert.equal(isPrivateIp("0x7f000001"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("93.184.216.34"), false);
});

test("assertPublicHost DNS 解析到私网 → 拦截（防 rebinding）", async () => {
  await assert.rejects(() => assertPublicHost("evil.example.com", privateResolve), /SSRF 拦截/);
  await assertPublicHost("good.example.com", publicResolve);
  await assert.rejects(() => assertPublicHost("127.0.0.1", publicResolve), /SSRF 拦截/);
});

function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

test("safeFetch 正常抓取 + HTML 转文本", async () => {
  const fetchImpl = (async () => res(200, "<html><body><script>x</script><p>你好 世界</p></body></html>")) as unknown as typeof fetch;
  const r = await safeFetch("https://example.com", { fetchImpl, resolve: publicResolve });
  assert.equal(r.status, 200);
  assert.match(htmlToText(r.text), /你好 世界/);
  assert.ok(!htmlToText(r.text).includes("x"));
});

test("safeFetch 重定向到私网 → 逐跳拦截", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("example.com")) return res(302, "", { location: "http://169.254.169.254/latest" });
    return res(200, "should not reach");
  }) as unknown as typeof fetch;
  await assert.rejects(() => safeFetch("https://example.com", { fetchImpl, resolve: publicResolve }), /SSRF 拦截/);
});

test("safeFetch 重定向到公网 → 跟随", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("a.example")) return res(301, "", { location: "https://b.example/final" });
    return res(200, "final content");
  }) as unknown as typeof fetch;
  const r = await safeFetch("https://a.example", { fetchImpl, resolve: publicResolve });
  assert.equal(r.text, "final content");
  assert.match(r.url, /b\.example/);
});

test("safeFetch 初始 URL 私网 → 拦截（不发请求）", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return res(200, "x"); }) as unknown as typeof fetch;
  await assert.rejects(() => safeFetch("http://127.0.0.1/", { fetchImpl, resolve: publicResolve }), /SSRF 拦截/);
  assert.equal(called, false);
});

test("safeFetch 字节上限截断", async () => {
  const big = "a".repeat(5000);
  const fetchImpl = (async () => res(200, big)) as unknown as typeof fetch;
  const r = await safeFetch("https://example.com", { fetchImpl, resolve: publicResolve, maxBytes: 1000 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1000);
});

test("safeFetch 重定向超跳数 → 拦截", async () => {
  const fetchImpl = (async () => res(302, "", { location: "https://example.com/loop" })) as unknown as typeof fetch;
  await assert.rejects(() => safeFetch("https://example.com", { fetchImpl, resolve: publicResolve }), /重定向超过/);
});