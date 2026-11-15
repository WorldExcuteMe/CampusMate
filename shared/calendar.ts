// Pure calendar contract shared by the API and the browser. Dates are school-local civil dates.
export interface TermDates { startDate: string; endDate: string; totalWeeks: number; timezone: string; weekAnchor?: string; }
export interface ScheduleRule { id?: string; courseId?: string; courseName: string; weekday: number; startTime: string; endTime: string; startWeek: number; endWeek: number; weekPattern: "every" | "odd" | "even"; classroom?: string; campus?: string; }
export interface CourseException { id: string; scheduleId?: string; kind: "reschedule" | "makeup" | "cancel" | "room_change" | "holiday"; date: string; sourceDate?: string; startTime?: string; endTime?: string; classroom?: string; note?: string; }
export interface CalendarEntry { id: string; title: string; weekday: number; date?: string; startTime: string; endTime: string; kind: "course" | "exam" | "activity" | "deadline" | "interview" | "opportunity"; classroom?: string; campus?: string; scheduleId?: string; colorKey?: string; allDay?: boolean; note?: string; }
export interface Period { index: number; startTime: string; endTime: string; }
export interface TimeScheme { id?: string; userId?: string; termId: string; institutionId: string; campus: string; name: string; effectiveFrom: string; effectiveTo: string; periods: Period[]; }
export type ScheduleKnowledge = "loading" | "error" | "unknown" | "empty" | "ready";
const DAY = 86400000;
export function validDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
export function timeMinutes(s: string): number { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
export function validTime(s: unknown): s is string { return typeof s === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s); }
export function addDays(date: string, days: number): string { return new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10); }
export function weekday(date: string): number { return new Date(date + "T00:00:00Z").getUTCDay() || 7; }
export function monday(date: string): string { return addDays(date, 1 - weekday(date)); }
export function localParts(now: number | Date, timezone: string): { date: string; time: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (key: string) => p.find((v) => v.type === key)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
export function localInstant(date: string, time: string, timezone: string): number {
  if (!validDate(date) || !validTime(time)) throw new Error("日期或时间无效");
  const target = Date.parse(`${date}T${time}:00Z`); let guess = target;
  for (let i = 0; i < 4; i++) { const p = localParts(guess, timezone); const delta = target - Date.parse(`${p.date}T${p.time}:00Z`); if (!delta) return guess; guess += delta; }
  throw new Error("时区转换失败或该时刻不存在");
}
export function teachingWeek(term: TermDates, date: string): number { return Math.floor((Date.parse(date) - Date.parse(term.weekAnchor ?? monday(term.startDate))) / (7 * DAY)) + 1; }
export function weekStart(term: TermDates, week: number): string { return addDays(term.weekAnchor ?? monday(term.startDate), (week - 1) * 7); }
export function occursInWeek(s: Pick<ScheduleRule, "startWeek" | "endWeek" | "weekPattern">, week: number): boolean {
  return week >= s.startWeek && week <= s.endWeek && (s.weekPattern === "every" || (s.weekPattern === "odd" ? week % 2 === 1 : week % 2 === 0));
}
export function validateTerm(term: TermDates): void {
  if (!validDate(term.startDate) || !validDate(term.endDate) || term.endDate < term.startDate || !Number.isInteger(term.totalWeeks) || term.totalWeeks < 1 || term.totalWeeks > 60) throw new Error("学期日期或总周数无效");
  localParts(0, term.timezone);
  if (term.weekAnchor && (!validDate(term.weekAnchor) || weekday(term.weekAnchor) !== 1 || term.weekAnchor > term.startDate || Date.parse(term.startDate) - Date.parse(term.weekAnchor) > 6 * DAY)) throw new Error("第一教学周锚点须为开学日期所在周的周一");
}
export function projectCourses(term: TermDates, rules: ScheduleRule[], exceptions: CourseException[], from: string, to: string): { entries: CalendarEntry[]; warnings: string[] } {
  const entries: CalendarEntry[] = [], warnings: string[] = [];
  for (const e of exceptions) if (e.kind === "reschedule" && !e.sourceDate) warnings.push("旧调课记录缺少源日期，仅显示目标课程；请核对原课是否停课");
  const build = (s: ScheduleRule, index: number, date: string, e?: CourseException): CalendarEntry => ({ id: `${e ? `exception-${e.id}` : `course-${s.id ?? index}`}/${date}`, title: s.courseName, date, weekday: weekday(date), startTime: e?.startTime || s.startTime, endTime: e?.endTime || s.endTime, classroom: e?.classroom || s.classroom, campus: s.campus, kind: "course", scheduleId: s.id, colorKey: s.courseId || `${s.courseName}/${s.campus ?? ""}`, note: e?.note });
  for (let date = from, count = 0; date <= to && count < 370; date = addDays(date, 1), count++) {
    if (date < term.startDate || date > term.endDate) continue;
    const week = teachingWeek(term, date);
    if (week < 1 || week > term.totalWeeks) continue;
    rules.forEach((s, index) => {
      const related = exceptions.filter((e) => !e.scheduleId || e.scheduleId === s.id);
      const removed = related.some((e) => ((e.kind === "cancel" || e.kind === "holiday") && e.date === date) || (e.kind === "reschedule" && e.sourceDate === date));
      if (s.weekday === weekday(date) && occursInWeek(s, week) && !removed) entries.push(build(s, index, date, [...related].reverse().find((e) => e.kind === "room_change" && e.date === date)));
      for (const e of related) if (e.scheduleId === s.id && e.date === date && (e.kind === "reschedule" || e.kind === "makeup")) entries.push(build(s, index, date, e));
    });
  }
  return { entries: sortEntries(entries), warnings: [...new Set(warnings)] };
}
export function sortEntries(entries: CalendarEntry[]): CalendarEntry[] { return [...entries].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.weekday - b.weekday || Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || timeMinutes(a.startTime) - timeMinutes(b.startTime) || a.id.localeCompare(b.id)); }
export function deadlineEntry(id: string, title: string, value: string, timezone: string, kind: "deadline" | "opportunity"): CalendarEntry | null {
  const allDay = validDate(value); const timestamp = Date.parse(value);
  if (!allDay && !Number.isFinite(timestamp)) return null;
  const { date, time } = allDay ? { date: value, time: "23:59" } : localParts(timestamp, timezone);
  return { id, title, date, weekday: weekday(date), startTime: time, endTime: time, allDay, kind };
}
export function deadlineInstant(value: string, timezone: string): number { try { return validDate(value) ? localInstant(value, "23:59", timezone) + 59999 : Date.parse(value); } catch { return NaN; } }
export function activeTask(status: string): boolean { return status === "todo" || status === "in_progress"; }
export function scheduleKey(s: ScheduleRule): string { return JSON.stringify([s.courseName, s.weekday, s.startTime, s.endTime, s.startWeek, s.endWeek, s.weekPattern, s.campus ?? "", s.classroom ?? ""]); }
export function dateEntries(input: { from: string; to: string; timezone: string; tasks: { id: string; title: string; dueAt: string | null; status: string }[]; opps: { id: string; title: string; deadline?: string | null; status?: string }[] }): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  for (const t of input.tasks) if (activeTask(t.status) && t.dueAt) { const entry = deadlineEntry(`task-${t.id}`, `截止：${t.title}`, t.dueAt, input.timezone, "deadline"); if (entry) entries.push(entry); }
  for (const o of input.opps) if (o.deadline && !["archived", "cancelled", "rejected"].includes(o.status ?? "")) { const entry = deadlineEntry(`opp-${o.id}`, `机会：${o.title}`, o.deadline, input.timezone, "opportunity"); if (entry) entries.push(entry); }
  return sortEntries(entries.filter((e) => e.date! >= input.from && e.date! <= input.to));
}
export function validateScheme(s: TimeScheme): void {
  if (!s.name.trim() || !validDate(s.effectiveFrom) || !validDate(s.effectiveTo) || s.effectiveTo < s.effectiveFrom || !s.periods.length || s.periods.length > 30) throw new Error("作息名称、生效日期或节次无效");
  const indices = new Set<number>(); let end = -1;
  for (const p of s.periods) { if (!Number.isInteger(p.index) || p.index < 1 || indices.has(p.index) || !validTime(p.startTime) || !validTime(p.endTime) || timeMinutes(p.startTime) < end || timeMinutes(p.endTime) <= timeMinutes(p.startTime)) throw new Error("节次须唯一、按时间排序且不重叠"); indices.add(p.index); end = timeMinutes(p.endTime); }
}
export function effectiveScheme(schemes: TimeScheme[], date: string, termId: string, campus = ""): TimeScheme | undefined { return schemes.filter((s) => s.termId === termId && (!s.campus || s.campus === campus) && s.effectiveFrom <= date && s.effectiveTo >= date).sort((a, b) => Number(Boolean(b.campus)) - Number(Boolean(a.campus)) || b.effectiveFrom.localeCompare(a.effectiveFrom))[0]; }
export function periodLabel(entry: Pick<CalendarEntry, "startTime" | "endTime">, scheme?: TimeScheme): string | null { const start = scheme?.periods.find((p) => p.startTime === entry.startTime); const end = scheme?.periods.find((p) => p.endTime === entry.endTime); return start && end ? start.index === end.index ? `第${start.index}节` : `第${start.index}–${end.index}节` : null; }
