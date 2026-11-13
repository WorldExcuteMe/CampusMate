import { describe, expect, it } from "vitest";
import { detectScope, allowedTools, checkToolScope } from "../agent/scope";
import { AGENT_TOOLS } from "../agent/tools";

describe("scope: 用户信息源检测与锁定", () => {
  it("QQ群+群名 → 锁定qq并提取群名", () => {
    const s = detectScope("帮我获取一下我本地QQ中网安2401班官方群的相应通知");
    expect(s.source).toBe("qq");
    expect(s.locked).toBe(true);
    expect(s.groupHint).toBe("网安2401班官方群");
  });
  it("QQ+群号 → 锁定qq并提取群号", () => {
    const s = detectScope("881289395 帮我总结一下这个QQ群内的通知");
    expect(s.source).toBe("qq");
    expect(s.locked).toBe(true);
    expect(s.groupHint).toBe("881289395");
  });
  it("微信 → 锁定wechat", () => {
    const s = detectScope("去微信群里看看班会通知");
    expect(s.source).toBe("wechat");
    expect(s.locked).toBe(true);
  });
  it("网页/URL → 锁定web", () => {
    const s = detectScope("抓取 https://example.com 上的报名通知");
    expect(s.source).toBe("web");
    expect(s.locked).toBe(true);
  });
  it("无明确源 → 不锁定", () => {
    const s = detectScope("找一些适合我的竞赛机会");
    expect(s.locked).toBe(false);
    expect(s.source).toBe("any");
  });
});

describe("scope: 动作空间掩码（越界工具不可见）", () => {
  it("qq锁定掩掉跨源噪音工具", () => {
    const s = detectScope("在QQ群网安2401班官方群获取通知");
    const names = allowedTools(s, AGENT_TOOLS).map((t) => t.function.name);
    expect(names).toContain("sync_group_notices");
    expect(names).toContain("rag_search");
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("search_opportunities");
    expect(names).not.toContain("match_opportunities");
  });
  it("web锁定掩掉群工具", () => {
    const s = detectScope("抓取 https://example.com 通知");
    const names = allowedTools(s, AGENT_TOOLS).map((t) => t.function.name);
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("sync_group_notices");
    expect(names).not.toContain("list_groups");
  });
  it("不锁定保留全部工具", () => {
    const s = detectScope("找竞赛机会");
    expect(allowedTools(s, AGENT_TOOLS).length).toBe(AGENT_TOOLS.length);
  });
});

describe("scope: 执行期门控（确定性拒绝越界+源内强制）", () => {
  it("qq锁定拒绝web_fetch", () => {
    const s = detectScope("在QQ群获取通知");
    const r = checkToolScope(s, "web_fetch", { url: "https://example.com" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("越界");
  });
  it("qq锁定强制sync/rag限定用户群", () => {
    const s = detectScope("881289395 总结QQ群通知");
    const r = checkToolScope(s, "sync_group_notices", {});
    expect(r.ok).toBe(true);
    expect(r.args?.group).toBe("881289395");
    const r2 = checkToolScope(s, "rag_search", { query: "竞赛" });
    expect(r2.args?.group).toBe("881289395");
  });
  it("不锁定放行任意工具", () => {
    const s = detectScope("找竞赛机会");
    expect(checkToolScope(s, "web_fetch", { url: "https://example.com" }).ok).toBe(true);
  });
});