import { describe, expect, it } from "vitest";
import { guardUrl } from "../security/urlGuard";

describe("guardUrl", () => {
  it("允许公开 https", () => {
    expect(guardUrl("https://example.edu.cn/notice").ok).toBe(true);
  });
  it.each([
    "http://localhost:3000/x",
    "http://127.0.0.1/x",
    "http://10.0.0.1/x",
    "http://192.168.1.1/x",
    "http://172.16.0.1/x",
    "http://169.254.169.254/latest/meta-data/",
  ])("拦截内网/元数据 %s", (u) => {
    expect(guardUrl(u).ok).toBe(false);
  });
  it("拦截非 http 协议", () => {
    expect(guardUrl("file:///etc/passwd").ok).toBe(false);
    expect(guardUrl("ftp://example.com").ok).toBe(false);
  });
  it("拦截无效 URL", () => {
    expect(guardUrl("not a url").ok).toBe(false);
  });
});