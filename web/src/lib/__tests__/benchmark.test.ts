// 自动化 benchmark：无需手动输入提示词。脚本化 LLM 驱动 runChat，断言容器写入/工具路由/作用域/记忆/抗幻觉。
// 运行：npm run benchmark （或 npx vitest run benchmark）。stub fetch，不发真实网络。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DemoRepository, resetDemo } from "../data/demo";
import { runChat } from "../agent/chat";
import { getPlan, getMemory, clearPlan, clearMemory } from "../agent/memory";
import type { ChatMessage } from "../llm/proxy";

type Msg = { content?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
const tc = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

function makeRouter(script: Msg[], capture: { tools?: string[] }) {
  let i = 0;
  return vi.fn(async (url: string, opts?: { body?: string }) => {
    const u = String(url);
    const json = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    if (u.includes("/api/llm")) {
      const body = JSON.parse(opts?.body ?? "{}");
      capture.tools = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
      const m = script[Math.min(i, script.length - 1)]; i++;
      return json({ choices: [{ message: { content: m.content ?? "", tool_calls: m.tool_calls ?? [] } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "mock" });
    }
    if (u.includes("/api/env/check")) return json({ qqKey: true, wechatKey: true });
    if (u.includes("/api/ingest/qq/groups")) return json({ groups: [{ uin: 881289395, name: "通知群", total: 10, info_hits: 5, info_ratio: 0.5, samples: [] }] });
    if (u.includes("/api/ingest/qq")) return json({ group: "881289395", uin: 881289395, count: 1, records: [{ time: "2026-11-11 11:02:00", sender: "s", type: 1, text: "竞赛讲座 11月16日 报名截止 11月20日", display: "竞赛讲座 11月16日 报名截止 11月20日", reasons: ["keyword"] }] });
    if (u.includes("/api/rag/search")) return json({ results: [{ src: "qq:881289395", time: "2026-11-11", text: "竞赛讲座 11月16日", score: 1 }] });
    if (u.includes("/api/web/search")) return json({ results: [{ title: "2026计算机竞赛", url: "https://example.org/comp", snippet: "报名截止11月30日" }] });
    return json({});
  });
}

async function run(repo: DemoRepository, message: string, script: Msg[], capture: { tools?: string[] } = {}) {
  vi.stubGlobal("fetch", makeRouter(script, capture));
  const profile = await repo.getProfile();
  const out = await runChat({ message, history: [] as ChatMessage[], repository: repo, profile, mode: "auto" });
  return { out, capture };
}

beforeEach(() => { resetDemo(); clearPlan(); clearMemory(); });
afterEach(() => vi.unstubAllGlobals());

describe("benchmark: 容器写入/搜索/长任务/作用域/抗幻觉（自动，无需手动输入）", () => {
  it("B2 总结群+合并inbox+写雷达", async () => {
    const repo = new DemoRepository();
    const { out } = await run(repo, "881289395 总结通知，过期不要，合并进inbox，仍有效竞赛写雷达", [
      { tool_calls: [tc("sync_group_notices", { group: "881289395" })] },
      { tool_calls: [tc("save_to_inbox", { title: "竞赛讲座", summary: "11月16日", category: "activity" }, "a"), tc("create_opportunity", { title: "计算机竞赛", type: "competition", description: "报名截止11月30日", sourceUrl: "https://example.org/comp" }, "b")] },
      { content: "已总结并落库。" },
    ]);
    expect((await repo.listInbox()).length).toBeGreaterThan(0);
    expect((await repo.listOpportunities()).length).toBeGreaterThan(0);
    expect(out.mock).toBe(false);
  });

  it("B5 网页搜索+写雷达", async () => {
    const repo = new DemoRepository();
    await run(repo, "网页搜索2026计算机竞赛并整合写雷达", [
      { tool_calls: [tc("web_search", { query: "2026 计算机 竞赛" })] },
      { tool_calls: [tc("create_opportunity", { title: "2026计算机竞赛", type: "competition", description: "报名截止11月30日", sourceUrl: "https://example.org/comp" })] },
      { content: "已整合。" },
    ]);
    expect((await repo.listOpportunities()).some((o) => o.title.includes("计算机"))).toBe(true);
  });

  it("B7 长任务 plan+memory checkpoint", async () => {
    const repo = new DemoRepository();
    await run(repo, "全面收集群内求职+比赛信息，分步计划执行并落库", [
      { tool_calls: [tc("create_plan", { goal: "收集求职+比赛", steps: ["收集", "核验", "总结", "落库"] })] },
      { tool_calls: [tc("save_to_inbox", { title: "比赛", summary: "x" })] },
      { content: "完成。" },
    ]);
    expect(getPlan()).not.toBeNull();
    expect(getMemory().length).toBeGreaterThan(0);
  });

  it("B10 指定QQ群锁定scope，不暴露web_search", async () => {
    const repo = new DemoRepository();
    const capture: { tools?: string[] } = {};
    await run(repo, "只在QQ群881289395内找信息，不要网页搜索", [
      { tool_calls: [tc("sync_group_notices", { group: "881289395" })] },
      { content: "仅群内。" },
    ], capture);
    expect(capture.tools).not.toContain("web_search");
    expect(capture.tools).toContain("sync_group_notices");
  });

  it("B9 抗幻觉：查不到如实说明，不编造落库", async () => {
    const repo = new DemoRepository();
    const before = (await repo.listOpportunities()).length;
    const { out } = await run(repo, "群里没提到的比赛不要编造", [
      { content: "查不到该比赛，如实说明，不编造。" },
    ]);
    expect(out.reply).toContain("查不到");
    expect((await repo.listOpportunities()).length).toBe(before);
  });
});