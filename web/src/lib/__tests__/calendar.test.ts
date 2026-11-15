import { expect, it } from "vitest";
import { addDays, dateEntries, effectiveScheme, localParts, monday, periodLabel, projectCourses, teachingWeek, validateScheme } from "../../../../shared/calendar";
const term = { startDate: "2026-09-01", endDate: "2027-01-20", totalWeeks: 20, timezone: "Asia/Shanghai" };
const schedule = { id: "math", courseName: "高等数学", weekday: 1, startTime: "08:00", endTime: "09:40", startWeek: 1, endWeek: 16, weekPattern: "every" as const };
it("学校本地日期及周一锚点不受浏览器时区和夏令时影响", () => {
  expect(localParts(Date.parse("2026-09-06T17:00Z"), term.timezone).date).toBe("2026-09-07");
  expect(monday(term.startDate)).toBe("2026-08-31"); expect(teachingWeek(term, "2026-09-07")).toBe(2);
  expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
});
it("跨周调课移除明确的源日期，保留其他周正常课；停课/补课/教室变更覆盖投影", () => {
  const exceptions = [{ id: "move", scheduleId: "math", kind: "reschedule" as const, sourceDate: "2026-09-07", date: "2026-09-15", startTime: "16:10", endTime: "17:40" }, { id: "room", scheduleId: "math", kind: "room_change" as const, date: "2026-09-14", classroom: "B201" }];
  const e = projectCourses(term, [schedule], exceptions, "2026-09-07", "2026-09-20").entries;
  expect(e.map((x) => x.date)).toEqual(["2026-09-14", "2026-09-15"]); expect(e[0].classroom).toBe("B201"); expect(e[1].startTime).toBe("16:10");
  expect(projectCourses(term, [schedule], [{ id: "holiday", kind: "holiday", date: "2026-09-07" }], "2026-09-07", "2026-09-13").entries).toHaveLength(0);
});
it("具体截止只投影一次并过滤已完成/取消/归档，日期型截止保留全天语义", () => {
  const entries = dateEntries({ from: "2026-09-07", to: "2026-09-13", timezone: term.timezone, tasks: [{ id: "x", title: "截止", dueAt: "2026-09-08", status: "todo" }, { id: "y", title: "完成", dueAt: "2026-09-08", status: "done" }, { id: "next", title: "下周", dueAt: "2026-09-15", status: "todo" }], opps: [{ id: "a", title: "归档", deadline: "2026-09-08", status: "archived" }] });
  expect(entries).toHaveLength(1); expect(entries[0].allDay).toBe(true);
});
it("单双周、停课和补课只影响指定日期，旧调课记录有明确警告", () => {
  const odd = { ...schedule, weekPattern: "odd" as const };
  expect(projectCourses(term, [odd], [], "2026-09-07", "2026-09-13").entries).toHaveLength(0);
  const result = projectCourses(term, [schedule], [{ id: "cancel", scheduleId: "math", kind: "cancel", date: "2026-09-07" }, { id: "makeup", scheduleId: "math", kind: "makeup", date: "2026-09-09" }, { id: "legacy", scheduleId: "math", kind: "reschedule", date: "2026-09-10" }], "2026-09-07", "2026-09-13");
  expect(result.entries.map((e) => e.date)).toEqual(["2026-09-09", "2026-09-10"]); expect(result.warnings).toHaveLength(1);
});
it("两校、冬夏作息独立匹配，非整节活动不伪造节次", () => {
  const a = { name: "A冬", termId: "a", institutionId: "A", campus: "主校区", effectiveFrom: "2026-11-01", effectiveTo: "2027-01-31", periods: [{ index: 1, startTime: "08:00", endTime: "08:45" }, { index: 2, startTime: "08:55", endTime: "09:40" }] };
  const b = { ...a, name: "B校", termId: "b", institutionId: "B", periods: [{ index: 1, startTime: "08:30", endTime: "09:20" }] }; validateScheme(a); validateScheme(b);
  expect(effectiveScheme([a, b], "2026-11-15", "a", "主校区")?.name).toBe("A冬");
  expect(effectiveScheme([a], "2026-10-15", "a", "主校区")).toBeUndefined();
  expect(periodLabel(schedule, a)).toBe("第1–2节"); expect(periodLabel(schedule, b)).toBeNull();
});
