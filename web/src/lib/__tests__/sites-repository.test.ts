import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/config", () => ({
  runtime: "cloud",
  isCloudRuntime: true,
  supabaseClient: null,
}));

import { SitesRepository } from "../data/sites-repository";

type Handler = (url: string, init?: RequestInit) => Response;
let calls: { url: string; init?: RequestInit }[] = [];

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
}
let handler: Handler = () => json({});

beforeEach(() => {
  calls = [];
  handler = () => json({});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const repository = new SitesRepository("user-cloud");

describe("SitesRepository 云端兼容形状", () => {
  it("声明 supabase 兼容模式与 cloud 作用域", () => {
    expect(repository.mode).toBe("supabase");
    expect(repository.storageScope).toBe("cloud:user-cloud");
  });

  it("读取 domain/inbox 并携带同源会话占位头", async () => {
    handler = (url) => {
      expect(url).toContain("/functions/v1/app/v1/domain/inbox");
      return json({ inbox: [{
        id: "inbox_1",
        title: "讲座通知",
        summary: "周五 18:00",
        category: "notice",
        status: "pending_review",
        classification: { class: "high_value", priorityScore: 88 },
        savedAt: 1_700_000_000_000,
      }] });
    };
    const items = await repository.listInbox();
    expect(items[0]).toMatchObject({
      id: "inbox_1",
      userId: "user-cloud",
      status: "pending_review",
      demo: false,
      extracted: { title: "讲座通知", category: "notice", deadline: null },
      classification: { class: "high_value", priorityScore: 88 },
    });
    expect(calls[0].url).toMatch(/\/functions\/v1\/app\/v1\/domain\/inbox$/);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sites-session");
  });

  it("日常任务读取与创建走 domain/daily", async () => {
    handler = (url, init) => init?.method === "POST"
      ? json({ daily: { id: "task_1", title: "交作业", status: "todo", kind: "daily" } })
      : json({ daily: [{ id: "task_2", title: "班会", status: "done", kind: "daily", dueAt: "2026-11-25", savedAt: 1_700_000_000_000 }] });
    const tasks = await repository.listTasks();
    expect(tasks[0]).toMatchObject({ id: "task_2", status: "done", kind: "daily", demo: false });
    const created = await repository.createTask({
      id: "task_1", userId: "user-cloud", title: "交作业", dueAt: null,
      status: "todo", priority: 50, inboxItemId: null, estimateHours: null,
      kind: "daily", createdAt: new Date().toISOString(), demo: false,
    });
    expect(created).toMatchObject({ id: "task_1", title: "交作业", status: "todo" });
    expect(calls.some(({ url, init }) => init?.method === "POST" && url.endsWith("/v1/domain/daily"))).toBe(true);
  });

  it("画像读写走 domain/profile", async () => {
    handler = (_url, init) => init?.method === "PUT"
      ? json({ profile: { name: "云端用户", goals: ["保研"] } })
      : json({ profile: { name: "云端用户", major: "计算机", goals: ["保研"] } });
    expect(await repository.getProfile()).toMatchObject({ id: "user-cloud", name: "云端用户", major: "计算机" });
    expect(await repository.updateProfile({
      id: "user-cloud", name: "云端用户", major: "", grade: "", interests: [], skills: [],
      goals: ["保研"], timeBudgetHours: 10, bio: "",
    })).toMatchObject({ name: "云端用户", goals: ["保研"] });
    expect(calls.at(-1)?.init?.method).toBe("PUT");
  });

  it("机会读写走 domain/opportunities", async () => {
    handler = (_url, init) => init?.method === "POST"
      ? json({ opportunities: { id: "opp_1", title: "竞赛", type: "competition" } })
      : json({ opportunities: [{ id: "opp_1", title: "竞赛", type: "competition", deadline: "2026-12-01" }] });
    const list = await repository.listOpportunities();
    expect(list[0]).toMatchObject({ id: "opp_1", type: "competition", status: "active" });
    expect((await repository.getOpportunity("opp_1"))?.title).toBe("竞赛");
    expect((await repository.createOpportunity(list[0])).id).toBe("opp_1");
  });

  it("未就绪的核验、活动与 Agent 运行记录返回空且不发请求", async () => {
    expect(await repository.listReports()).toEqual([]);
    expect(await repository.getReport("report_1")).toBeNull();
    expect(await repository.listActivity()).toEqual([]);
    expect(await repository.listAgentRuns()).toEqual([]);
    await repository.logActivity({ id: "a", userId: "user-cloud", eventType: "test", entityType: "test", entityId: "1", createdAt: "" });
    await repository.logAgentRun({ id: "run" } as Parameters<typeof repository.logAgentRun>[0]);
    expect(calls).toHaveLength(0);
  });

  it("Agent 设置走 settings/agent 并携带 revision", async () => {
    handler = (_url, init) => init?.method === "PATCH"
      ? json({ settings: { reasoning: "high" }, revision: 2, updatedAt: 1 })
      : json({ settings: { reasoning: "auto" }, revision: 1, updatedAt: 1 });
    expect(await repository.getAgentSettings()).toMatchObject({ revision: 1 });
    await repository.saveAgentSettings({ reasoning: "high" }, 1);
    expect(calls.at(-1)?.url).toMatch(/\/v1\/settings\/agent$/);
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({ reasoning: "high", expectedRevision: 1 });
  });
});
