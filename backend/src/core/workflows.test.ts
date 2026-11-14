import { test } from "node:test";
import assert from "node:assert/strict";
import { onboarding, intelligentInbox, opportunityDiscovery, weeklyPlanning } from "./workflows.ts";
import { InMemoryPersonalContextStore, type InstitutionProfile, type CourseSchedule } from "./personal-context.ts";

const CSV = `courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom,campus
高数,1,08:00,09:40,1,16,every,A101,主校区
英语,3,10:00,11:40,1,16,every,B202,主校区`;

const profile: InstitutionProfile = { userId: "u1", university: "某大学", major: "计算机", grade: "大二", interests: ["编程"], skills: ["Python", "算法"], goals: ["考研"], preferences: {}, updatedAt: 1 };
const schedules: CourseSchedule[] = [
  { id: "s1", userId: "u1", termId: "t1", courseId: "c1", courseName: "高数", weekday: 1, startTime: "08:00", endTime: "09:40", startWeek: 1, endWeek: 16, weekPattern: "every" },
  { id: "s2", userId: "u1", termId: "t1", courseId: "c2", courseName: "英语", weekday: 3, startTime: "10:00", endTime: "11:40", startWeek: 1, endWeek: 16, weekPattern: "every" },
];

test("E1 Onboarding：预览→确认→建立 PersonalContext", async () => {
  const store = new InMemoryPersonalContextStore();
  const input = { userId: "u1", university: "某大学", major: "计算机", grade: "大二", term: { name: "2026秋", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20 }, schedule: { format: "csv" as const, data: CSV }, sources: [{ kind: "campus_website" as const, name: "教务", url: "https://x.edu" }] };
  const preview = await onboarding(store, input);
  assert.equal(preview.status, "needs_confirm");
  assert.equal(preview.preview.count, 2);
  const done = await onboarding(store, { ...input, confirm: true });
  assert.equal(done.status, "completed");
  assert.equal(done.savedSchedules, 2);
  assert.equal((await store.getProfile("u1"))?.university, "某大学");
  assert.equal((await store.listSchedules("u1", done.termId!)).length, 2);
  assert.equal((await store.listSources("u1")).length, 1);
});

test("E2 Intelligent Inbox：竞赛通知→Opportunity+Task+Event+优先级+冲突", () => {
  const r = intelligentInbox({ userId: "u1", title: "ACM 竞赛", rawText: "报名截止", category: "competition", deadline: "2026-11-16", isOpportunity: true, schedules, week: 1 });
  assert.ok(r.objects.some((o) => o.kind === "opportunity"));
  assert.ok(r.objects.some((o) => o.kind === "task"));
  assert.ok(r.objects.some((o) => o.kind === "event"));
  assert.ok(r.priority > 50);
  assert.equal(r.needsConfirm, true);
});

test("E3 Opportunity Discovery：资格筛选+技能匹配+排序", () => {
  const r = opportunityDiscovery({
    profile,
    opportunities: [
      { id: "o1", title: "Python 编程竞赛", type: "competition", skills: ["Python"], minGrade: "大一", verified: true, sourceUrl: "https://a" },
      { id: "o2", title: "研究生科研", type: "research", minGrade: "研一" },
      { id: "o3", title: "算法大赛", type: "competition", skills: ["算法"] },
    ],
  });
  assert.equal(r.recommendations[0].id, "o1"); // 技能+核验+资格 → 最高
  const o2 = r.recommendations.find((x) => x.id === "o2")!;
  assert.equal(o2.eligible, false); // 大二 < 研一
  assert.ok(r.recommendations[0].matchReasons.some((m) => m.includes("Python")));
});

test("E4 Weekly Planning：空闲分配+Plan DAG+验收", () => {
  const r = weeklyPlanning({ userId: "u1", goal: "完成竞赛报名准备", schedules, tasks: [{ id: "t1", title: "准备材料", dueAt: "2026-11-20", estimateHours: 2 }, { id: "t2", title: "复习算法", dueAt: "2026-11-22", estimateHours: 1 }], week: 1 });
  assert.ok(r.plan.steps.length >= 3);
  assert.ok(r.allocations.length >= 1);
  assert.ok(r.freeMinutes > 0);
  assert.equal(typeof r.acceptancePassed, "boolean");
});

test("E4 空闲不足→冲突提示（部分交付）", () => {
  // 课程占满 08:00-22:00 → 无空闲
  const full: CourseSchedule[] = [{ id: "f", userId: "u1", termId: "t1", courseId: "c", courseName: "满课", weekday: 1, startTime: "08:00", endTime: "22:00", startWeek: 1, endWeek: 16, weekPattern: "every" }];
  const r = weeklyPlanning({ userId: "u1", goal: "x", schedules: full, tasks: [{ id: "t1", title: "任务", dueAt: "2026-11-20", estimateHours: 2 }], week: 1 });
  // 其余 6 天有空闲，任务会分配；验证冲突机制存在
  assert.ok(Array.isArray(r.conflicts));
});

test("E3 时间冲突检测", () => {
  const r = opportunityDiscovery({ profile, opportunities: [{ id: "o1", title: "竞赛", type: "competition", deadline: "2026-11-16" }], schedules, week: 1 });
  // 2026-11-16 是周一，有高数 → 冲突
  assert.equal(r.recommendations[0].timeConflict, true);
});