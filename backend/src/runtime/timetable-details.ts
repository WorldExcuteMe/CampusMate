import { validTime } from "../../../shared/calendar.ts";

export interface TimetableDetail {
  course: string;
  weeks: string;
  periods: string;
  time: string;
  campus: string;
  room: string;
}

const weekdays = "一二三四五六日";
const fields = ["courseName", "weekday", "startTime", "endTime", "startWeek", "endWeek", "weekPattern", "classroom", "campus"];

export function detailsToScheduleCsv(value: unknown): string {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw new Error("课表详情应为 1–500 条记录");
  const out = [fields.join(",")], seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") throw new Error(`第 ${index + 1} 条详情格式无效`);
    const row = entry as TimetableDetail;
    const fail = (field: string): never => { throw new Error(`第 ${index + 1} 条详情的${field}不可核对`); };
    const required = [row.course, row.weeks, row.periods, row.time, row.campus, row.room];
    if (!required.every(part => typeof part === "string" && part.length <= 300 && !/[\r\n]/.test(part)) || !row.course.trim()) fail("字段");
    const slot = row.periods.trim().match(/^(?:周|星期)([一二三四五六日天])\s*(?:第\s*)?(\d{1,2})(?:\s*[-~～—至]\s*(\d{1,2}))?\s*节$/);
    const day = slot?.[1] === "天" ? "日" : slot?.[1];
    if (!slot || !day || Number(slot[2]) < 1 || Number(slot[3] ?? slot[2]) < Number(slot[2]) || Number(slot[3] ?? slot[2]) > 20) fail("星期或节次");
    const time = row.time.trim().match(/^(\d{2}:\d{2})\s*[-~～—至]\s*(\d{2}:\d{2})$/);
    if (!time || !validTime(time[1]) || !validTime(time[2]) || time[1] >= time[2]) fail("时间");
    for (const segment of row.weeks.split(/[,，、;；]/)) {
      const match = segment.trim().match(/^(?:第\s*)?(\d{1,2})(?:\s*[-~～—至]\s*(\d{1,2}))?\s*(?:周\s*)?(?:[（(]?\s*([单双])\s*(?:周)?\s*[）)]?)?$/);
      const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
      if (!match || start < 1 || end > 60 || start > end) fail("周数");
      const pattern = match![3] === "单" ? "odd" : match![3] === "双" ? "even" : "every";
      const cells = [row.course.trim(), String(weekdays.indexOf(day!) + 1), time![1], time![2], String(start), String(end), pattern, row.room.trim(), row.campus.trim()];
      const csv = cells.map(cell => '"' + cell.replaceAll('"', '""') + '"').join(",");
      if (seen.has(csv)) continue;
      seen.add(csv);
      out.push(csv);
    }
  }
  return out.join("\n") + "\n";
}
