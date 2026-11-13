import { describe, expect, it, beforeEach } from "vitest";
import { DemoRepository, resetDemo } from "../data/demo";
import { runInboxPipeline } from "../agent/orchestrator";
import { MockProvider } from "../llm/mock";
import { uid } from "../data/types";

describe("integration: agent + repository 闭环", () => {
  beforeEach(() => resetDemo());

  it("导入→提取→确认→建任务→Dashboard 可读", async () => {
    const repo = new DemoRepository();
    const text = "关于举办2026年校园程序设计大赛的通知\n报名截止：2026年11月25日\n主办：教务处";
    const res = await runInboxPipeline({ rawText: text, sourceUrl: null, sourceType: "text" }, new MockProvider());
    expect(res.extracted.deadline).toBe("2026-11-25");

    const item = await repo.createInbox({
      id: uid(), userId: "demo-user", rawText: text, sourceUrl: null, sourceType: "text",
      extracted: res.extracted, classification: res.classification, status: "confirmed",
      createdAt: new Date().toISOString(), demo: true,
    });
    await repo.createTask({
      id: uid(), userId: "demo-user", title: `处理：${item.extracted.title}`, dueAt: item.extracted.deadline,
      status: "todo", priority: res.classification.priorityScore, inboxItemId: item.id,
      estimateHours: null, kind: "general", createdAt: new Date().toISOString(), demo: true,
    });

    const tasks = await repo.listTasks();
    expect(tasks.some((t) => t.title.includes("程序设计大赛"))).toBe(true);
    const inbox = await repo.listInbox();
    expect(inbox.some((i) => i.id === item.id)).toBe(true);
  });

  it("日常任务导入去重", async () => {
    const repo = new DemoRepository();
    const t = {
      id: uid(), userId: "demo-user", title: "班会", dueAt: "2026-11-14", status: "todo" as const,
      priority: 65, inboxItemId: null, estimateHours: 1, kind: "daily" as const,
      createdAt: new Date().toISOString(), demo: true,
    };
    await repo.createTask(t);
    const daily = (await repo.listTasks()).filter((x) => x.kind === "daily");
    expect(daily.length).toBeGreaterThan(0);
  });
});