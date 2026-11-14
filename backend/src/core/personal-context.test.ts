import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseCsv, parseXlsx, parseIcs, dedupSchedules, detectConflicts, previewImport } from "./schedule-import.ts";
import { InMemoryPersonalContextStore, currentTeachingWeek, occursInWeek } from "./personal-context.ts";

const CSV = `courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom,campus
高等数学,1,08:00,09:40,1,16,every,A101,主校区
大学英语,3,10:00,11:40,1,16,odd,B202,主校区
体育,5,14:00,15:40,1,8,even,操场,主校区`;

test("CSV 解析 + 标准化", () => {
  const r = parseCsv(CSV);
  assert.equal(r.errors.length, 0);
  assert.equal(r.schedules.length, 3);
  assert.equal(r.schedules[0].courseName, "高等数学");
  assert.equal(r.schedules[1].weekPattern, "odd");
});

test("CSV 错误行部分恢复（不整体失败）", () => {
  const bad = CSV + "\n坏行,9,08:00,07:00,1,16,every,X,Y";
  const r = parseCsv(bad);
  assert.equal(r.schedules.length, 3); // 有效行保留
  assert.ok(r.errors.length >= 1); // 坏行报错
});

test("XLSX 解析", () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ["courseName", "weekday", "startTime", "endTime", "startWeek", "endWeek", "weekPattern", "classroom", "campus"],
    ["数据结构", 2, "08:00", "09:40", 1, 16, "every", "A102", "主校区"],
    ["操作系统", 4, "10:00", "11:40", 1, 16, "even", "A103", "主校区"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const r = parseXlsx(buf);
  assert.equal(r.errors.length, 0);
  assert.equal(r.schedules.length, 2);
  assert.equal(r.schedules[0].courseName, "数据结构");
});

test("ICS 解析（RRULE BYDAY + 周次）", () => {
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:线性代数
DTSTART:20260901T080000Z
DTEND:20260901T094000Z
RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=16
LOCATION:A105
END:VEVENT
END:VCALENDAR`;
  const r = parseIcs(ics, "2026-09-01", 20);
  assert.equal(r.errors.length, 0);
  assert.equal(r.schedules.length, 1);
  assert.equal(r.schedules[0].courseName, "线性代数");
  assert.equal(r.schedules[0].weekday, 2);
  assert.equal(r.schedules[0].endWeek, 16);
});

test("教学周计算 + 单双周判定", () => {
  const term = { id: "t", userId: "u", institutionId: "i", name: "2026秋", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20, timezone: "Asia/Shanghai" };
  assert.equal(currentTeachingWeek(term, new Date("2026-09-01T00:00:00")), 1);
  assert.equal(currentTeachingWeek(term, new Date("2026-09-08T00:00:00")), 2);
  assert.equal(currentTeachingWeek(term, new Date("2026-08-25T00:00:00")), 0); // 开学前
  const odd = { courseName: "x", weekday: 3, startTime: "10:00", endTime: "11:40", startWeek: 1, endWeek: 16, weekPattern: "odd" as const };
  assert.equal(occursInWeek(odd, 1), true);
  assert.equal(occursInWeek(odd, 2), false);
  assert.equal(occursInWeek(odd, 17), false); // 超范围
});

test("重复课程去重", () => {
  const r = parseCsv(CSV);
  const dup = [...r.schedules, r.schedules[0]];
  const { unique, duplicates } = dedupSchedules(dup);
  assert.equal(unique.length, 3);
  assert.equal(duplicates, 1);
});

test("时间冲突检测（同星期重叠）", () => {
  const r = parseCsv(CSV);
  const conflict = { ...r.schedules[0], startTime: "08:30", endTime: "09:00" }; // 与高数 08:00-09:40 重叠
  const c = detectConflicts([...r.schedules, conflict]);
  assert.ok(c.length >= 1);
});

test("导入预览：解析+去重+冲突+错误，不保存", () => {
  const p = previewImport("csv", CSV, "2026-09-01", 20);
  assert.equal(p.schedules.length, 3);
  assert.equal(p.errors.length, 0);
  assert.equal(p.duplicates, 0);
});

test("PersonalContextStore：user 隔离 + 调课独立 + 增删", async () => {
  const store = new InMemoryPersonalContextStore();
  const term = await store.createTerm({ userId: "u1", institutionId: "i", name: "2026秋", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20, timezone: "Asia/Shanghai" });
  const saved = await store.saveSchedules("u1", term.id, parseCsv(CSV).schedules.map((s) => ({ ...s, courseId: "c" })));
  assert.equal(saved.length, 3);
  assert.equal((await store.listSchedules("u2", term.id)).length, 0); // 跨用户隔离
  // 调课独立，不覆盖正常规则
  await store.addException({ userId: "u1", termId: term.id, scheduleId: saved[0].id, kind: "room_change", date: "2026-09-07", classroom: "B999" });
  assert.equal((await store.listExceptions("u1", term.id)).length, 1);
  assert.equal((await store.listSchedules("u1", term.id)).length, 3); // 正常规则不变
  assert.equal(await store.deleteSchedule("u1", saved[0].id), true);
  assert.equal((await store.listSchedules("u1", term.id)).length, 2);
});

test("导入任务版本 + 确认流程", async () => {
  const store = new InMemoryPersonalContextStore();
  const term = await store.createTerm({ userId: "u1", institutionId: "i", name: "t", startDate: "2026-09-01", endDate: "2027-01-15", totalWeeks: 20, timezone: "Asia/Shanghai" });
  const job = await store.createImportJob({ userId: "u1", termId: term.id, format: "csv", status: "pending", sourceName: "课表.csv", previewCount: 3, errorCount: 0, version: 1, createdAt: Date.now() });
  await store.updateImportJob(job.id, { status: "previewed" });
  const confirmed = await store.updateImportJob(job.id, { status: "confirmed" });
  assert.equal(confirmed?.status, "confirmed");
});