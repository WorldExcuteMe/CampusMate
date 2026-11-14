// 周日历网格：真实课程 + 事件 + 任务截止 + 机会 → 周视图；空闲时间计算。
// 纯逻辑，确定性可测。单双周/周次由 occursInWeek 判定。

export interface ScheduleItem { courseName: string; weekday: number; startTime: string; endTime: string; startWeek: number; endWeek: number; weekPattern: "every" | "odd" | "even"; classroom?: string; }
export interface CalendarEntry { id: string; title: string; weekday: number; startTime: string; endTime: string; kind: "course" | "exam" | "activity" | "deadline" | "interview" | "opportunity"; classroom?: string; }

export function occursInWeek(s: Pick<ScheduleItem, "startWeek" | "endWeek" | "weekPattern">, week: number): boolean {
  if (week < s.startWeek || week > s.endWeek) return false;
  if (s.weekPattern === "odd") return week % 2 === 1;
  if (s.weekPattern === "even") return week % 2 === 0;
  return true;
}

function toMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

// 构建某教学周的日历条目（课程按单双周过滤 + 事件/截止/机会）。
export function buildWeekEntries(week: number, schedules: ScheduleItem[], events: CalendarEntry[]): CalendarEntry[] {
  const courses: CalendarEntry[] = schedules.filter((s) => occursInWeek(s, week)).map((s, i) => ({ id: `course-${i}`, title: s.courseName, weekday: s.weekday, startTime: s.startTime, endTime: s.endTime, kind: "course", classroom: s.classroom }));
  return [...courses, ...events].sort((a, b) => (a.weekday - b.weekday) || (toMin(a.startTime) - toMin(b.startTime)));
}

// 周网格：7 天 × 条目。
export function weekGrid(entries: CalendarEntry[]): CalendarEntry[][] {
  const grid: CalendarEntry[][] = Array.from({ length: 7 }, () => []);
  for (const e of entries) if (e.weekday >= 1 && e.weekday <= 7) grid[e.weekday - 1].push(e);
  return grid;
}

export interface FreeSlot { weekday: number; startTime: string; endTime: string; minutes: number; }

// 空闲时间：给定工作时段（如 08:00-22:00），扣除课程/事件占用。
export function freeTime(entries: CalendarEntry[], dayStart = "08:00", dayEnd = "22:00"): FreeSlot[] {
  const slots: FreeSlot[] = [];
  const grid = weekGrid(entries);
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  for (let d = 0; d < 7; d++) {
    const busy = grid[d].map((e) => [toMin(e.startTime), toMin(e.endTime)] as [number, number]).sort((a, b) => a[0] - b[0]);
    let cursor = toMin(dayStart);
    const end = toMin(dayEnd);
    for (const [s, e] of busy) {
      if (s > cursor) slots.push({ weekday: d + 1, startTime: fmt(cursor), endTime: fmt(s), minutes: s - cursor });
      cursor = Math.max(cursor, e);
    }
    if (cursor < end) slots.push({ weekday: d + 1, startTime: fmt(cursor), endTime: fmt(end), minutes: end - cursor });
  }
  return slots.filter((s) => s.minutes >= 30);
}

// 今日课程（weekday 匹配 + 单双周）。
export function todayCourses(week: number, weekday: number, schedules: ScheduleItem[]): ScheduleItem[] {
  return schedules.filter((s) => s.weekday === weekday && occursInWeek(s, week)).sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
}