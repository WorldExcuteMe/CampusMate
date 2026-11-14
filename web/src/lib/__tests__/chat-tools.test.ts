import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { runChat } from "../agent/chat";
import { DemoRepository, resetDemo } from "../data/demo";
import { demoProfile, demoOpportunities } from "@/demo/seed";
import { beijingDay } from "../time-policy";
import { configureAiAuth } from "../llm/transport";

beforeEach(resetDemo);
afterEach(() => { vi.unstubAllGlobals(); configureAiAuth(async () => null); });
function fixture(args: unknown, name = "create_daily_task") {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ model: "fixture", usage: { prompt_tokens: 3, completion_tokens: 2 }, choices: [{ message: bodies.length === 1 ? {
      content: null, tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
    } : { content: "已处理" } }] });
  }));
  return bodies;
}
describe("Agent tool loop regression", () => {
  it.each([
    { name: "search_opportunities", args: { query: "" }, expected: ["有效机会"], },
    { name: "search_opportunities", args: { query: "", timeState: "all" }, expected: ["有效机会", "过期机会", "未知机会", "归档机会"] },
    { name: "match_opportunities", args: {}, expected: ["有效机会"] },
  ])("$name gates opportunity time state and labels history explicitly", async ({ name, args, expected }) => {
    const bodies = fixture(args, name);
    const repo = new DemoRepository();
    const opportunities = [
      { ...demoOpportunities[0], title: "有效机会", deadline: beijingDay(), status: "active" as const },
      { ...demoOpportunities[0], title: "过期机会", deadline: "2020-01-01", status: "active" as const },
      { ...demoOpportunities[0], title: "未知机会", deadline: null, status: "active" as const },
      { ...demoOpportunities[0], title: "归档机会", deadline: "2999-01-01", status: "archived" as const },
    ];
    vi.spyOn(repo, "listOpportunities").mockResolvedValue(opportunities);
    await runChat({ message: "检索竞赛机会", history: [], repository: repo, profile: demoProfile });
    const result = JSON.parse(bodies[1].messages.findLast((m: { role: string }) => m.role === "tool").content);
    const rows = Array.isArray(result) ? result : result.results;
    expect(rows.map((o: { title: string }) => o.title)).toEqual(expected);
    expect(rows.every((o: { timeState?: string }) => o.timeState)).toBe(true);
    expect(opportunities[1].deadline).toBe("2020-01-01");
  });
  it("creates a UUID task and passes tool output into the next model turn", async () => {
    const bodies = fixture({ title: "周五班会", dueAt: "2026-11-20" });
    const repo = new DemoRepository();
    const result = await runChat({ message: "创建班会任务", history: [], repository: repo, profile: demoProfile });
    const task = (await repo.listTasks()).find((t) => t.title === "周五班会")!;
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result).toMatchObject({ mock: false, usage: { input: 6, output: 4 }, actions: ["创建日常任务：周五班会"] });
    expect(bodies[0].tools.length).toBeGreaterThan(0);
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
  });
  it("rejects invalid model-supplied dates without writing a task", async () => {
    const bodies = fixture({ title: "非法日期测试", dueAt: "2026-02-30" });
    const repo = new DemoRepository();
    const count = (await repo.listTasks()).length;
    const result = await runChat({ message: "fixture", history: [], repository: repo, profile: demoProfile });
    expect((await repo.listTasks()).length).toBe(count);
    expect(result.actions).toHaveLength(0);
    expect(bodies[1].messages.at(-1).content).toContain("invalid_task_arguments");
  });
  it("Demo reset clears Demo dedup keys but not another user's keys", () => {
    localStorage.setItem("campusmate.daily.seen.demo", '["fixture"]');
    localStorage.setItem("campusmate.daily.seen.user-b", '["private"]');
    resetDemo();
    expect(localStorage.getItem("campusmate.daily.seen.demo")).toBeNull();
    expect(localStorage.getItem("campusmate.daily.seen.user-b")).toBe('["private"]');
  });
});
