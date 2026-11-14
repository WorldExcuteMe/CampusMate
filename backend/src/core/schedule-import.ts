// 课表导入：ICS/CSV/XLSX 解析 → 标准化 CourseSchedule → 校验（时间/周次/单双周/重复）→ 预览 → 确认 → 保存。
// 调课/补课/停课/教室变更独立 ScheduleException，不覆盖正常规则。错误提示 + 部分恢复。
import * as XLSX from "xlsx";
import type { CourseSchedule, WeekPattern, ScheduleException } from "./personal-context.ts";

export type RawSchedule = Omit<CourseSchedule, "id" | "userId" | "termId" | "courseId">;

export interface ParseResult { schedules: RawSchedule[]; errors: string[]; }

// ── CSV ──
// 列：courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom,campus
export function parseCsv(text: string): ParseResult {
  const errors: string[] = [];
  const schedules: RawSchedule[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { schedules, errors: ["空文件"] };
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    try {
      const s = normalizeRow({
        courseName: cols[idx("courseName")], weekday: cols[idx("weekday")], startTime: cols[idx("startTime")], endTime: cols[idx("endTime")],
        startWeek: cols[idx("startWeek")], endWeek: cols[idx("endWeek")], weekPattern: cols[idx("weekPattern")], classroom: cols[idx("classroom")], campus: cols[idx("campus")],
      });
      schedules.push(s);
    } catch (e) { errors.push(`行 ${i + 1}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { schedules, errors };
}

// ── XLSX ──
export function parseXlsx(buf: ArrayBuffer | Uint8Array): ParseResult {
  const errors: string[] = [];
  const schedules: RawSchedule[] = [];
  try {
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    rows.forEach((r, i) => {
      try { schedules.push(normalizeRow(r as Record<string, string>)); }
      catch (e) { errors.push(`行 ${i + 2}: ${e instanceof Error ? e.message : String(e)}`); }
    });
  } catch (e) { errors.push(`XLSX 解析失败：${e instanceof Error ? e.message : String(e)}`); }
  return { schedules, errors };
}

// ── ICS ──
// VEVENT：SUMMARY=课程名，DTSTART/DTEND 时间，RRULE BYDAY=星期 + COUNT/UNTIL 推周次，LOCATION=教室。
export function parseIcs(text: string, termStart: string, totalWeeks: number): ParseResult {
  const errors: string[] = [];
  const schedules: RawSchedule[] = [];
  const events = text.split(/BEGIN:VEVENT/i).slice(1);
  const dayMap: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
  for (const ev of events) {
    try {
      const get = (k: string) => (ev.match(new RegExp(`${k}[^:]*:(.+)`, "i"))?.[1] ?? "").trim();
      const summary = get("SUMMARY");
      const dtstart = get("DTSTART");
      const dtend = get("DTEND");
      const location = get("LOCATION");
      const rrule = get("RRULE");
      if (!summary || !dtstart) { errors.push("VEVENT 缺 SUMMARY/DTSTART"); continue; }
      const start = parseIcsDate(dtstart);
      const end = parseIcsDate(dtend || dtstart);
      const byday = rrule.match(/BYDAY=([A-Z,]+)/i)?.[1]?.split(",")[0] ?? "";
      const weekday = dayMap[byday] ?? (start.getUTCDay() || 7);
      const count = Number(rrule.match(/COUNT=(\d+)/i)?.[1] ?? totalWeeks);
      const startWeek = weekOf(termStart, start);
      schedules.push({
        courseName: summary, weekday, startTime: hhmm(start), endTime: hhmm(end),
        startWeek, endWeek: Math.min(totalWeeks, startWeek + count - 1), weekPattern: "every",
        classroom: location, campus: "", source: "ics",
      });
    } catch (e) { errors.push(`VEVENT: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { schedules, errors };
}

function parseIcsDate(s: string): Date {
  // 20260901T080000Z 或 20260901T080000
  const m = s.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) throw new Error(`无效 ICS 日期 ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}
function hhmm(d: Date): string { return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; }
function weekOf(termStart: string, d: Date): number {
  const start = new Date(termStart + "T00:00:00Z");
  return Math.max(1, Math.floor((d.getTime() - start.getTime()) / (7 * 86400000)) + 1);
}

// ── 标准化 + 校验 ──
function normalizeRow(r: Record<string, string>): RawSchedule {
  const courseName = String(r.courseName ?? "").trim();
  if (!courseName) throw new Error("缺课程名");
  const weekday = Number(r.weekday);
  if (!(weekday >= 1 && weekday <= 7)) throw new Error(`星期非法 ${r.weekday}`);
  const startTime = String(r.startTime ?? "").trim();
  const endTime = String(r.endTime ?? "").trim();
  if (!/^\d{1,2}:\d{2}$/.test(startTime) || !/^\d{1,2}:\d{2}$/.test(endTime)) throw new Error("时间格式须 HH:MM");
  if (toMin(endTime) <= toMin(startTime)) throw new Error("结束时间须晚于开始");
  const startWeek = Number(r.startWeek || 1);
  const endWeek = Number(r.endWeek || 20);
  if (!(startWeek >= 1 && endWeek >= startWeek)) throw new Error("周次范围非法");
  const wp = String(r.weekPattern || "every").trim();
  if (!["every", "odd", "even"].includes(wp)) throw new Error(`单双周非法 ${wp}`);
  return { courseName, weekday, startTime, endTime, startWeek, endWeek, weekPattern: wp as WeekPattern, classroom: String(r.classroom ?? "").trim(), campus: String(r.campus ?? "").trim(), source: "import" };
}
function toMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

// 重复课程检测（同课程名+星期+时间+周次范围+单双周）。
export function dedupSchedules(schedules: RawSchedule[]): { unique: RawSchedule[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: RawSchedule[] = [];
  let duplicates = 0;
  for (const s of schedules) {
    const key = `${s.courseName}|${s.weekday}|${s.startTime}|${s.endTime}|${s.startWeek}|${s.endWeek}|${s.weekPattern}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); unique.push(s);
  }
  return { unique, duplicates };
}

// 时间冲突检测（同星期、周次重叠、单双周相容、时间段重叠）。
export function detectConflicts(schedules: RawSchedule[]): { a: RawSchedule; b: RawSchedule }[] {
  const conflicts: { a: RawSchedule; b: RawSchedule }[] = [];
  for (let i = 0; i < schedules.length; i++) for (let j = i + 1; j < schedules.length; j++) {
    const a = schedules[i], b = schedules[j];
    if (a.weekday !== b.weekday) continue;
    if (a.endWeek < b.startWeek || b.endWeek < a.startWeek) continue;
    if (a.weekPattern !== "every" && b.weekPattern !== "every" && a.weekPattern !== b.weekPattern) continue;
    if (toMin(a.startTime) < toMin(b.endTime) && toMin(b.startTime) < toMin(a.endTime)) conflicts.push({ a, b });
  }
  return conflicts;
}

export interface ImportPreview { schedules: RawSchedule[]; errors: string[]; duplicates: number; conflicts: { a: RawSchedule; b: RawSchedule }[]; }

// 导入预览（解析 + 去重 + 冲突 + 错误，不保存）。
export function previewImport(format: "ics" | "csv" | "xlsx", data: string | ArrayBuffer | Uint8Array, termStart: string, totalWeeks: number): ImportPreview {
  const parsed = format === "csv" ? parseCsv(data as string) : format === "xlsx" ? parseXlsx(data as ArrayBuffer) : parseIcs(data as string, termStart, totalWeeks);
  const { unique, duplicates } = dedupSchedules(parsed.schedules);
  const conflicts = detectConflicts(unique);
  return { schedules: unique, errors: parsed.errors, duplicates, conflicts };
}

// 调课/补课/停课/教室变更 → 独立异常（不覆盖正常规则）。
export function makeException(kind: ScheduleException["kind"], date: string, opts: Partial<ScheduleException> = {}): Omit<ScheduleException, "id" | "userId" | "termId"> {
  return { kind, date, ...opts };
}