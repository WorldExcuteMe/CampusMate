import { addDays, effectiveScheme, localParts, periodLabel, timeMinutes, type CalendarEntry, type TimeScheme } from "../../../../shared/calendar";
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const COLORS = ["bg-violet-100 text-violet-950 border-violet-300 dark:bg-violet-950 dark:text-violet-100", "bg-teal-100 text-teal-950 border-teal-300 dark:bg-teal-950 dark:text-teal-100", "bg-rose-100 text-rose-950 border-rose-300 dark:bg-rose-950 dark:text-rose-100", "bg-blue-100 text-blue-950 border-blue-300 dark:bg-blue-950 dark:text-blue-100", "bg-amber-100 text-amber-950 border-amber-300 dark:bg-amber-950 dark:text-amber-100"];
function color(e: CalendarEntry) { let h = 0; for (const c of e.colorKey ?? e.title) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; }
function place(entries: CalendarEntry[]) {
  const placed: { entry: CalendarEntry; lane: number; lanes: number }[] = [], ends: number[] = []; let groupStart = 0;
  const finish = () => { for (let i = groupStart; i < placed.length; i++) placed[i].lanes = ends.length; groupStart = placed.length; ends.length = 0; };
  for (const entry of entries.sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const start = timeMinutes(entry.startTime);
    if (ends.length && ends.every((end) => end <= start)) finish();
    let lane = ends.findIndex((end) => end <= start); if (lane < 0) lane = ends.length;
    ends[lane] = timeMinutes(entry.endTime); placed.push({ entry, lane, lanes: 1 });
  }
  finish(); return placed;
}
export function Timetable({ entries, from, mode, selectedDate, timezone, termId, schemes, campus }: { entries: CalendarEntry[]; from: string; mode: "day" | "week"; selectedDate: string; timezone: string; termId?: string; schemes: TimeScheme[]; campus: string }) {
  const today = localParts(Date.now(), timezone), times = entries.filter((e) => e.kind === "course");
  if (mode === "day") {
    const items = entries.filter((e) => e.date === selectedDate);
    return <section aria-label="当日安排" className="space-y-3">{items.length ? items.map((e) => <article key={e.id} className={`flex gap-4 rounded-2xl border p-4 ${e.kind === "course" ? color(e) : "bg-card"}`}><div className="w-16 shrink-0 text-sm font-semibold">{e.allDay ? "当天截止" : e.startTime}<p className="mt-1 text-xs font-normal opacity-70">{e.kind === "course" ? e.endTime : ""}</p></div><div className="min-w-0"><p className="font-semibold break-words">{e.title}</p><p className="mt-1 text-xs opacity-75">{[periodLabel(e, effectiveScheme(schemes, e.date!, termId ?? "", e.campus ?? campus)), e.classroom, e.campus, e.note].filter(Boolean).join(" · ")}</p></div></article>) : <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">当天没有已记录安排</p>}</section>;
  }
  const start = Math.min(8 * 60, ...times.map((e) => Math.floor(timeMinutes(e.startTime) / 60) * 60));
  const end = Math.max(22 * 60, ...times.map((e) => Math.ceil(timeMinutes(e.endTime) / 60) * 60));
  const scale = 1.05, height = (end - start) * scale;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const scheme = effectiveScheme(schemes, from, termId ?? "", campus);
  return <div className="overflow-auto rounded-2xl border bg-card" style={{ maxHeight: 720 }} tabIndex={0} aria-label="周课表，可横向和纵向滚动"><div className="min-w-[850px]">
    <div className="sticky top-0 z-20 grid grid-cols-[68px_repeat(7,minmax(0,1fr))] border-b bg-card/95 backdrop-blur"><div className="px-2 py-4 text-xs text-muted-foreground">时间</div>{dates.map((d, i) => <div key={d} className={`border-l px-2 py-3 text-center text-sm ${d === today.date ? "bg-primary/10 text-primary" : ""}`}><p className="font-semibold">{DAYS[i]} {d === today.date ? "· 今天" : ""}</p><p className="mt-0.5 text-xs opacity-70">{d.slice(5).replace("-", "/")}</p></div>)}</div>
    <div className="grid grid-cols-[68px_repeat(7,minmax(0,1fr))] border-b bg-muted/20"><div className="p-2 text-[10px] text-muted-foreground">截止</div>{dates.map((date) => <div key={date} className="space-y-1 border-l p-1.5">{entries.filter((e) => e.date === date && e.kind !== "course").map((e) => <p key={e.id} className="rounded-md bg-rose-50 p-1.5 text-[11px] text-rose-900 dark:bg-rose-950 dark:text-rose-100" title={e.title}>{e.allDay ? "当天" : e.startTime} · {e.title}</p>)}</div>)}</div>
    <div className="relative grid grid-cols-[68px_repeat(7,minmax(0,1fr))]" style={{ height }}><div className="relative bg-muted/20">{Array.from({ length: (end - start) / 60 + 1 }, (_, i) => start + i * 60).map((m) => <span key={m} className="absolute right-2 text-[10px] text-muted-foreground" style={{ top: Math.min(height - 14, (m - start) * scale) }}>{String(Math.floor(m / 60)).padStart(2, "0")}:00</span>)}{scheme?.periods.map((p) => <span key={p.index} className="absolute left-1 right-1 rounded bg-primary/5 text-center text-[9px] text-primary" style={{ top: (timeMinutes(p.startTime) - start) * scale + 13 }}>第{p.index}节 {p.startTime}</span>)}</div>
    {dates.map((date) => <div key={date} className="relative border-l" style={{ backgroundImage: "repeating-linear-gradient(to bottom, transparent 0, transparent 62px, var(--border) 62px, var(--border) 63px)" }}>{place(times.filter((e) => e.date === date)).map(({ entry: e, lane, lanes }) => <article key={e.id} className={`absolute overflow-hidden rounded-xl border px-2 py-1.5 text-xs shadow-sm ${color(e)}`} style={{ top: (timeMinutes(e.startTime) - start) * scale, height: Math.max(24, (timeMinutes(e.endTime) - timeMinutes(e.startTime)) * scale - 3), left: `calc(${lane / lanes * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` }} title={`${e.title} ${e.startTime}–${e.endTime} ${e.classroom ?? ""}`}><p className="font-semibold leading-5 break-words">{e.title}</p><p className="mt-1 text-[10px] opacity-80">{e.startTime}–{e.endTime}</p>{e.classroom && <p className="mt-0.5 text-[10px]">{e.classroom}</p>}<p className="text-[10px]">{periodLabel(e, effectiveScheme(schemes, date, termId ?? "", e.campus ?? campus))}</p>{lanes > 1 && <span className="text-[9px] font-semibold">时间冲突</span>}</article>)}{date === today.date && timeMinutes(today.time) >= start && timeMinutes(today.time) <= end && <div aria-label="当前时间" className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-rose-500" style={{ top: (timeMinutes(today.time) - start) * scale }}><span className="absolute -left-1 -top-1 size-2 rounded-full bg-rose-500" /></div>}</div>)}
    </div></div></div>;
}
