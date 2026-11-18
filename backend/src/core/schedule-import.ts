// 课表导入：ICS/CSV/XLSX 解析 → 标准化 CourseSchedule → 校验（时间/周次/单双周/重复）→ 预览 → 确认 → 保存。
// 调课/补课/停课/教室变更独立 ScheduleException，不覆盖正常规则。错误提示 + 部分恢复。
import * as XLSX from "xlsx";
import type { AcademicTerm, CourseSchedule, WeekPattern, ScheduleException, PersonalContextStore } from "./personal-context.ts";
import { addDays, localInstant, localParts, monday, occursInWeek, scheduleKey, teachingWeek, validDate, validTime, weekday as dayNumber } from "../../../shared/calendar.ts";

export type RawSchedule = Omit<CourseSchedule, "id" | "userId" | "termId" | "courseId">;

export interface ParseResult { schedules: RawSchedule[]; errors: string[]; }

// ── CSV ──
// 列：courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom,campus
export function parseCsv(text: string): ParseResult {
  const errors: string[] = [];
  const schedules: RawSchedule[] = [];
  if (!text.trim()) return { schedules, errors: ["空文件"] };
  try {
    const wb = XLSX.read(text.replace(/^\uFEFF/, ""), { type: "string", raw: true, sheetRows: 2002 });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    if (rows.length > 2000) return { schedules, errors: ["最多导入2000行，请拆分文件"] };
    rows.forEach((r, i) => { try { schedules.push(normalizeRow(r)); } catch (e) { errors.push(`行 ${i + 2}: ${e instanceof Error ? e.message : String(e)}`); } });
  } catch { errors.push("CSV格式无效，请使用UTF-8和标准列名"); }
  return { schedules, errors };
}

// ── XLSX ──
export function parseXlsx(buf: ArrayBuffer | Uint8Array): ParseResult {
  const errors: string[] = [];
  const schedules: RawSchedule[] = [];
  try {
    const wb = XLSX.read(buf, { type: "array", sheetRows: 2002 });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    if (rows.length > 2000) return { schedules, errors: ["最多导入2000行，请拆分文件"] };
    rows.forEach((r, i) => {
      try { schedules.push(normalizeRow(r as Record<string, string>)); }
      catch (e) { errors.push(`行 ${i + 2}: ${e instanceof Error ? e.message : String(e)}`); }
    });
  } catch (e) { errors.push(`XLSX 解析失败：${e instanceof Error ? e.message : String(e)}`); }
  return { schedules, errors };
}

// ── ICS ──
// VEVENT：SUMMARY=课程名，DTSTART/DTEND 时间，RRULE BYDAY=星期 + COUNT/UNTIL 推周次，LOCATION=教室。
export function parseIcs(text: string, termStart: string, totalWeeks: number, timezone = "Asia/Shanghai"): ParseResult {
  const errors: string[] = [];
  const schedules: RawSchedule[] = [];
  const events = text.replace(/\r?\n[ \t]/g, "").split(/BEGIN:VEVENT/i).slice(1);
  const dayMap: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };
  for (const ev of events) {
    try {
      const getLine = (k: string) => ev.split(/\r?\n/).find((line) => new RegExp(`^${k}(?:;[^:]*)?:`, "i").test(line)) ?? "";
      const get = (k: string) => getLine(k).slice(getLine(k).indexOf(":") + 1).trim().replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
      const summary = get("SUMMARY");
      const dtstart = get("DTSTART");
      const dtend = get("DTEND");
      const location = get("LOCATION");
      const rrule = get("RRULE");
      if (!summary || !dtstart) { errors.push("VEVENT 缺 SUMMARY/DTSTART"); continue; }
      if (/^(EXDATE|RDATE|RECURRENCE-ID)[;:]/im.test(ev)) throw new Error("暂不支持EXDATE/RDATE/RECURRENCE-ID，请展开为独立课程后导入");
      const sourceZone = dtstart.endsWith("Z") ? "UTC" : getLine("DTSTART").match(/TZID=([^;:]+)/i)?.[1] ?? timezone;
      const start = parseIcsDate(dtstart, sourceZone), end = parseIcsDate(dtend, getLine("DTEND").match(/TZID=([^;:]+)/i)?.[1] ?? sourceZone);
      if (end <= start) throw new Error("DTEND须晚于DTSTART");
      const startLocal = localParts(start, sourceZone);
      const rule: Record<string, string> = Object.fromEntries(rrule ? rrule.split(";").map((part) => part.toUpperCase().split("=")) : []);
      if (rrule && (rule.FREQ !== "WEEKLY" || Object.keys(rule).some((k) => !["FREQ", "BYDAY", "COUNT", "UNTIL", "INTERVAL", "WKST"].includes(k)) || (rule.WKST && rule.WKST !== "MO"))) throw new Error("仅支持周循环FREQ=WEEKLY、BYDAY、COUNT/UNTIL、INTERVAL和WKST=MO");
      const interval = Number(rule.INTERVAL ?? 1), maxCount = Number(rule.COUNT ?? 2000);
      if (!Number.isInteger(interval) || interval < 1 || interval > 52 || !Number.isInteger(maxCount) || maxCount < 1 || maxCount > 2000 || (rule.COUNT && rule.UNTIL)) throw new Error("循环次数/间隔无效或COUNT与UNTIL同时存在");
      const until = rule.UNTIL ? parseIcsDate(rule.UNTIL, sourceZone) : Infinity;
      const days = rule.BYDAY ? rule.BYDAY.split(",").map((d) => { if (!dayMap[d]) throw new Error("BYDAY只支持MO至SU"); return dayMap[d]; }) : [dayNumber(startLocal.date)];
      if (!days.includes(dayNumber(startLocal.date))) throw new Error("DTSTART与BYDAY不一致，请核对首个上课日期");
      const occurrences: RawSchedule[] = []; let count = 0;
      for (let offset = 0; offset <= totalWeeks * 7 + 14 && count < maxCount; offset++) {
        if (!rrule && offset > 0) break;
        const date = addDays(startLocal.date, offset);
        const recurrenceWeek = Math.floor((Date.parse(monday(date)) - Date.parse(monday(startLocal.date))) / (7 * 86400000));
        if (!days.includes(dayNumber(date)) || recurrenceWeek % interval !== 0) continue;
        const instant = offset === 0 ? start : localInstant(date, startLocal.time, sourceZone);
        if (instant > until) break;
        count++;
        const p = localParts(instant, timezone), q = localParts(instant + end - start, timezone);
        if (p.date !== q.date) throw new Error("暂不支持跨午夜课程，请拆分导入");
        const week = teachingWeek({ startDate: termStart, endDate: termStart, totalWeeks, timezone }, p.date);
        if (week < 1 || week > totalWeeks || p.date < termStart) continue;
        occurrences.push(normalizeRow({ courseName: summary, weekday: String(dayNumber(p.date)), startTime: p.time, endTime: q.time, startWeek: String(week), endWeek: String(week), classroom: location, source: "ics" }));
      }
      // Compact only consecutive teaching weeks with the same local time; DST shifts remain explicit.
      for (const s of occurrences) { const prior = schedules.find((p) => p.courseName === s.courseName && p.weekday === s.weekday && p.startTime === s.startTime && p.endTime === s.endTime && p.classroom === s.classroom && p.endWeek + 1 === s.startWeek); if (prior) prior.endWeek = s.endWeek; else schedules.push({ ...s, source: "ics" }); }
    } catch (e) { errors.push(`VEVENT: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { schedules, errors };
}

function parseIcsDate(s: string, timezone: string): number {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) throw new Error(`无效 ICS 日期 ${s}`);
  const date = `${m[1]}-${m[2]}-${m[3]}`, time = `${m[4]}:${m[5]}`;
  if (!validDate(date) || !validTime(time) || (m[6] && m[6] !== "00")) throw new Error("ICS日期/时间无效或含非零秒，请先归一到分钟");
  return m[7] ? Date.parse(`${date}T${time}:00Z`) : localInstant(date, time, timezone);
}

// ── 标准化 + 校验 ──
function normalizeRow(r: Record<string, string>): RawSchedule {
  const courseName = String(r.courseName ?? "").trim();
  if (!courseName) throw new Error("缺课程名");
  const weekday = Number(r.weekday);
  if (!(weekday >= 1 && weekday <= 7)) throw new Error(`星期非法 ${r.weekday}`);
  const pad = (t: unknown) => String(t ?? "").trim().replace(/^(\d):/, "0$1:");
  const startTime = pad(r.startTime), endTime = pad(r.endTime);
  if (!validTime(startTime) || !validTime(endTime)) throw new Error("时间须为有效HH:MM（00:00–23:59）");
  if (toMin(endTime) <= toMin(startTime)) throw new Error("结束时间须晚于开始");
  const startWeek = Number(r.startWeek || 1);
  const endWeek = Number(r.endWeek || 20);
  if (!Number.isInteger(weekday) || !Number.isInteger(startWeek) || !Number.isInteger(endWeek) || !(startWeek >= 1 && endWeek >= startWeek && endWeek <= 60)) throw new Error("周次范围非法");
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
    const key = scheduleKey(s);
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
    if (!Array.from({ length: Math.min(a.endWeek, b.endWeek) - Math.max(a.startWeek, b.startWeek) + 1 }, (_, w) => w + Math.max(a.startWeek, b.startWeek)).some((w) => occursInWeek(a, w) && occursInWeek(b, w))) continue;
    if (toMin(a.startTime) < toMin(b.endTime) && toMin(b.startTime) < toMin(a.endTime)) conflicts.push({ a, b });
  }
  return conflicts;
}

export interface ImportPreview { schedules: RawSchedule[]; errors: string[]; duplicates: number; conflicts: { a: RawSchedule; b: RawSchedule }[]; }

export async function createSchedulePreview(
  store: PersonalContextStore, owner: string, term: AcademicTerm,
  input: { format: "csv" | "ics" | "xlsx"; data: string | Buffer; sourceName: string },
) {
  const preview = previewImport(input.format, input.data, term.startDate, term.totalWeeks, term.timezone);
  const existing = await store.listSchedules(owner, term.id);
  const existingKeys = new Set(existing.map(scheduleKey));
  const fresh = preview.schedules.filter((row) => !existingKeys.has(scheduleKey(row)));
  preview.duplicates += preview.schedules.length - fresh.length;
  preview.schedules = fresh;
  const freshRows = new Set(fresh);
  preview.conflicts = detectConflicts([...fresh, ...existing]).filter(({ a, b }) => freshRows.has(a) || freshRows.has(b));
  const job = await store.createImportJob({
    userId: owner, termId: term.id, format: input.format, status: "previewed", sourceName: input.sourceName.slice(0, 200),
    previewCount: fresh.length, errorCount: preview.errors.length, version: 1, createdAt: Date.now(), preview,
  });
  return { confirmed: false, preview, jobId: job.id };
}

// 导入预览（解析 + 去重 + 冲突 + 错误，不保存）。
export function previewImport(format: "ics" | "csv" | "xlsx", data: string | ArrayBuffer | Uint8Array, termStart: string, totalWeeks: number, timezone = "Asia/Shanghai"): ImportPreview {
  const parsed = format === "csv" ? parseCsv(data as string) : format === "xlsx" ? parseXlsx(data as ArrayBuffer) : parseIcs(data as string, termStart, totalWeeks, timezone);
  const outside = parsed.schedules.filter((s) => s.endWeek > totalWeeks);
  if (outside.length) parsed.errors.push(`${outside.length}条课程超出学期总周数，请更正后导入`);
  parsed.schedules = parsed.schedules.filter((s) => s.endWeek <= totalWeeks);
  const { unique, duplicates } = dedupSchedules(parsed.schedules);
  const conflicts = detectConflicts(unique);
  return { schedules: unique, errors: parsed.errors, duplicates, conflicts };
}

// 调课/补课/停课/教室变更 → 独立异常（不覆盖正常规则）。
export function makeException(kind: ScheduleException["kind"], date: string, opts: Partial<ScheduleException> = {}): Omit<ScheduleException, "id" | "userId" | "termId"> {
  return { kind, date, ...opts };
}
