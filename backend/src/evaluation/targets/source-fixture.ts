import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { EvalUserContext } from "../types.ts";
import { validateSourceGrants } from "../../runtime/linked-sources.ts";
import { addDays, scheduleKey } from "../../../../shared/calendar.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const CSV_FIELDS = "courseName,weekday,startTime,endTime,startWeek,endWeek,weekPattern,classroom,campus";
const epoch = "2026-09-07";

function periods(kind: "semester-csv" | "semester-ics") {
  return Array.from({ length: 24 }, (_, i) => ({
    courseName: (kind === "semester-csv" ? "实训课-" : "实验课-") + (i + 1),
    weekday: i % 6 + 1, startTime: `${String(8 + (i % 3) * 2).padStart(2, "0")}:10`,
    endTime: `${String(9 + (i % 3) * 2).padStart(2, "0")}:45`,
    startWeek: i + 1, endWeek: i + 1, weekPattern: "every" as const,
    classroom: "楼" + (300 + i), campus: "",
  }));
}

function timetable(kind: "semester-csv" | "semester-ics") {
  const rules = periods(kind);
  if (kind === "semester-csv") return { rules, mime: "text/csv", body: [CSV_FIELDS, ...rules.map(row =>
    [row.courseName, row.weekday, row.startTime, row.endTime, row.startWeek, row.endWeek, row.weekPattern, row.classroom, row.campus].join(","))].join("\n") };
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CampusMate//Evaluation//ZH",
    ...rules.flatMap(row => {
      const date = addDays(epoch, 7 * (row.startWeek - 1) + row.weekday - 1).replaceAll("-", "");
      const time = (v: string) => date + "T" + v.replace(":", "") + "00";
      return ["BEGIN:VEVENT", `UID:${row.startWeek}@test.invalid`, `DTSTART:${time(row.startTime)}`,
        `DTEND:${time(row.endTime)}`, `SUMMARY:${row.courseName}`, `LOCATION:${row.classroom}`, "END:VEVENT"];
    }), "END:VCALENDAR"].join("\r\n");
  return { rules, mime: "text/calendar", body };
}

export async function createSourceFixture(kind: NonNullable<EvalUserContext["sourceFixture"]>, id: string) {
  const bearer = randomBytes(24).toString("hex");
  const isGroup = kind === "group-cursor";
  const format = kind === "semester-csv" ? "csv" : kind === "semester-ics" ? "ics" : "json-cursor";
  const group = Array.from({ length: 480 }, (_, i) => ({
    id: "notice-" + (i + 1), date: addDays("2026-11-01", i % 17),
    text: i % 29 === 0 ? `选课提醒 ${i + 1}，请在 11 月 ${i % 13 + 17} 日前核对登记。` : `实验室群记录 ${i + 1}`,
  }));
  const schedule = kind !== "group-cursor" ? timetable(kind) : undefined;
  const data = isGroup ? group.map(row => JSON.stringify(row)).join("\n") : schedule!.body;
  const sourceId = "source-" + hash(id).slice(0, 10);
  let served = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.headers.authorization !== "Bearer " + bearer || req.method !== "GET" || url.pathname !== "/data") {
      res.writeHead(403).end(); return;
    }
    if (schedule) {
      served++;
      res.writeHead(200, { "Content-Type": schedule.mime }).end(schedule.body); return;
    }
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    const selected = group.filter(row => (!from || row.date >= from) && (!to || row.date <= to));
    const cursor = url.searchParams.get("cursor");
    const start = cursor === null ? 0 : Number(cursor.slice(5));
    if (cursor !== null && (!/^page\.\d+$/.test(cursor) || start % 48 !== 0 || start >= selected.length)) { res.writeHead(400).end(); return; }
    const end = start + 48;
    served++;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      records: selected.slice(Math.max(0, start - 1), end), total: selected.length,
      nextCursor: end < selected.length ? "page." + end : null,
    }));
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address() as AddressInfo;
  return {
    grants: validateSourceGrants([{
      id: sourceId, label: isGroup ? "实验室协调群 · 消息归档" : kind === "semester-csv" ? "教务系统 · 秋季学期课表" : "学院课务门户 · iCalendar",
      dataset: isGroup ? "messages" : "timetable", format, url: `http://127.0.0.1:${address.port}/data`, bearer,
    }], true),
    hash: hash(data), minPages: isGroup ? 10 : 1, served: () => served,
    sourceId, scheduleDigest: schedule ? hash(JSON.stringify(schedule.rules.map(scheduleKey).sort())) : undefined,
    close: async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); },
  };
}
