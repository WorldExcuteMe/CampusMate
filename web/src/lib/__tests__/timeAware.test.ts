import { describe, expect, it, beforeEach } from "vitest";
import { DemoRepository, resetDemo } from "../data/demo";
import { syncGroupRecords, type GroupRecord } from "../ingest/qq";
import { extractDailyTime, isExpired, todayBeijing } from "../ingest/clean";

const rec = (display: string, time: string): GroupRecord => ({
  time, sender: "s", type: 1, text: display, display, reasons: ["keyword"],
});

describe("time-aware: 北京时间过期过滤", () => {
  beforeEach(() => resetDemo());

  it("todayBeijing 格式与 isExpired 判断", () => {
    expect(todayBeijing()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isExpired("2020-01-01")).toBe(true);
    expect(isExpired("2999-01-01")).toBe(false);
    expect(isExpired(null)).toBe(false);
  });

  it("旧消息相对日期相对消息时间解析（不相对现在）", () => {
    // 2025-09-16 是周二；消息说"周五"应解析到 2025-09-19，而非 2026 年的某个周五
    const t = extractDailyTime("周五 19:00 班会", new Date("2025-09-16T10:00:00"));
    expect(t.dueAt).toBe("2025-09-19");
    expect(isExpired(t.dueAt)).toBe(true);
  });

  it("syncGroupRecords 过滤过期、保留未过期", async () => {
    const repo = new DemoRepository();
    const dailyBefore = (await repo.listTasks()).filter((t) => t.kind === "daily").length;
    const records = [
      rec("关于2025年竞赛报名的通知 报名截止：2025年10月1日", "2025-09-01 10:00:00"),
      rec("班会 2025年9月1日 开会 签到", "2025-08-30 10:00:00"),
      rec("关于2027年竞赛报名的通知 报名截止：2027年3月1日", "2026-11-01 10:00:00"),
    ];
    const sum = await syncGroupRecords(records, repo);
    expect(sum.expired).toBe(2);
    expect(sum.opportunity).toBe(1);
    const inbox = await repo.listInbox();
    expect(inbox.some((i) => i.rawText.includes("2027"))).toBe(true);
    expect(inbox.some((i) => i.rawText.includes("2025年竞赛"))).toBe(false);
    const dailyAfter = (await repo.listTasks()).filter((t) => t.kind === "daily").length;
    expect(dailyAfter).toBe(dailyBefore);
  });
});