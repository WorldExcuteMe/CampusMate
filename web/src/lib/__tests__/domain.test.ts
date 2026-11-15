import { describe, expect, it } from "vitest";
import { deriveFromInformation, buildRelationGraph, relatedObjects, type Information } from "../domain/business-objects";
import { buildWeekEntries, weekGrid, freeTime, todayCourses, occursInWeek, type ScheduleItem } from "../domain/calendar-grid";
import { todayTasks, upcomingDeadlines, recommendedOpportunities, buildToday } from "../domain/today";

const info: Information = { id: "n1", kind: "information", title: "ACM 竞赛", rawText: "ACM 竞赛报名截止 11-30", relatedIds: [], createdAt: 1 };

describe("统一业务对象派生", () => {
  it("竞赛通知 → Opportunity + 报名 Task + 截止 Event", () => {
    const objs = deriveFromInformation(info, { category: "competition", deadline: "2026-11-30", isOpportunity: true });
    expect(objs.map((o) => o.kind)).toEqual(["information", "opportunity", "task", "deadline" === "deadline" ? "event" : "event"]);
    expect(objs.some((o) => o.kind === "opportunity")).toBe(true);
    expect(objs.some((o) => o.kind === "task")).toBe(true);
    expect(objs.some((o) => o.kind === "event")).toBe(true);
  });
  it("关联图双向", () => {
    const objs = deriveFromInformation(info, { category: "competition", deadline: "2026-11-30", isOpportunity: true });
    const g = buildRelationGraph(objs);
    expect(relatedObjects(g, "n1").length).toBeGreaterThan(0);
    expect(relatedObjects(g, "n1-opp")).toContain("n1");
  });
  it("非机会通知只派生 Task", () => {
    const objs = deriveFromInformation(info, { category: "notice", deadline: "2026-12-01" });
    expect(objs.map((o) => o.kind)).toEqual(["information", "task"]);
  });
});

const schedules: ScheduleItem[] = [
  { courseName: "高数", weekday: 1, startTime: "08:00", endTime: "09:40", startWeek: 1, endWeek: 16, weekPattern: "every", classroom: "A101" },
  { courseName: "英语", weekday: 3, startTime: "10:00", endTime: "11:40", startWeek: 1, endWeek: 16, weekPattern: "odd" },
  { courseName: "体育", weekday: 5, startTime: "14:00", endTime: "15:40", startWeek: 1, endWeek: 8, weekPattern: "even" },
];

describe("周日历网格", () => {
  it("单双周过滤：第1周英语上、体育不上", () => {
    const e1 = buildWeekEntries(1, schedules, []);
    expect(e1.some((e) => e.title === "英语")).toBe(true);
    expect(e1.some((e) => e.title === "体育")).toBe(false);
    const e2 = buildWeekEntries(2, schedules, []);
    expect(e2.some((e) => e.title === "体育")).toBe(true);
    expect(e2.some((e) => e.title === "英语")).toBe(false);
  });
  it("周网格 7 天分组", () => {
    const grid = weekGrid(buildWeekEntries(1, schedules, []));
    expect(grid.length).toBe(7);
    expect(grid[0].some((e) => e.title === "高数")).toBe(true);
  });
  it("空闲时间扣除课程占用", () => {
    const free = freeTime(buildWeekEntries(1, schedules, []), "08:00", "12:00");
    const mon = free.filter((f) => f.weekday === 1);
    expect(mon.some((f) => f.startTime === "09:40")).toBe(true); // 高数后空闲
  });
  it("今日课程按 weekday + 单双周", () => {
    expect(todayCourses(1, 1, schedules).map((s) => s.courseName)).toEqual(["高数"]);
    expect(todayCourses(1, 5, schedules).length).toBe(0); // 体育 even 第1周不上
    expect(occursInWeek(schedules[1], 3)).toBe(true);
  });
});

describe("Today 选择器", () => {
  const now = Date.parse("2026-11-13T08:00:00");
  const tasks = [
    { id: "t1", title: "今天截止", dueAt: "2026-11-13", status: "todo" },
    { id: "t2", title: "三天后", dueAt: "2026-11-16", status: "todo" },
    { id: "t3", title: "已完成", dueAt: "2026-11-13", status: "done" },
    { id: "t4", title: "远期", dueAt: "2026-12-30", status: "todo" },
  ];
  it("今日待办（含今天截止，排除已完成）", () => {
    const t = todayTasks(tasks, now);
    expect(t.map((x) => x.id)).toContain("t1");
    expect(t.map((x) => x.id)).not.toContain("t3");
  });
  it("7天内截止", () => {
    const d = upcomingDeadlines(tasks, 7, now);
    expect(d.map((x) => x.id)).toContain("t2");
    expect(d.map((x) => x.id)).not.toContain("t4");
  });
  it("推荐机会按匹配度+未过期", () => {
    const opps = [{ id: "o1", title: "A", deadline: "2026-12-01", matchScore: 80 }, { id: "o2", title: "B", deadline: "2020-01-01", matchScore: 90 }, { id: "o3", title: "C", deadline: "2026-12-01", matchScore: 60 }];
    const r = recommendedOpportunities(opps, 5, now);
    expect(r[0].id).toBe("o1"); // o2 过期排除
    expect(r.map((x) => x.id)).not.toContain("o2");
  });
  it("buildToday 汇总", () => {
    const s = buildToday({ courseCount: 2, tasks, inbox: [{ id: "n1", title: "通知", priority: 5 }], opps: [], now });
    expect(s.courses).toBe(2);
    expect(s.tasks.length).toBeGreaterThan(0);
    expect(s.notices.length).toBe(1);
  });
});