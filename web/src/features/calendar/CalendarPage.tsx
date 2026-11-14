import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, ArrowUpRight } from "lucide-react";
import { addDays, dateEntries, localParts, monday, projectCourses, teachingWeek } from "../../../../shared/calendar";
import { freeTime } from "@/lib/domain/calendar-grid";
import { overdueTasks } from "@/lib/domain/today";
import { useCampusCalendar } from "./use-campus-calendar";
import { ScheduleImport } from "./ScheduleImport";
import { Timetable } from "./Timetable";

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export function CalendarPage() {
  const calendar = useCampusCalendar();
  const { term, timezone, today, knowledge, schedules, tasks, opps } = calendar;
  const [chosen, setChosen] = useState<string>(), [mode, setMode] = useState<"day" | "week">(() => window.innerWidth < 768 ? "day" : "week"), [campus, setCampus] = useState("");
  const date = chosen ?? today, from = monday(date), to = addDays(from, 6);
  const rules = schedules.data?.schedules ?? [];
  const projected = term && knowledge === "ready" ? projectCourses(term, rules, schedules.data?.exceptions ?? [], from, to) : { entries: [], warnings: [] };
  const dated = dateEntries({ from, to, timezone, tasks: tasks.data ?? [], opps: opps.data ?? [] });
  const allEntries = [...projected.entries, ...dated];
  const entries = allEntries.filter((e) => e.kind !== "course" || !campus || e.campus === campus);
  const free = knowledge === "ready" ? freeTime(allEntries).filter((s) => mode === "week" || s.weekday === (new Date(date + "T00:00Z").getUTCDay() || 7)) : [];
  const overdue = overdueTasks(tasks.data ?? [], Date.now(), timezone);
  const activeWeek = term ? teachingWeek(term, date) : null;
  const campuses = [...new Set((schedules.data?.schedules ?? []).map((s) => s.campus).filter(Boolean))];
  const hour = localParts(Date.now(), timezone).time;
  const next = entries.filter((e) => e.date === today && (e.allDay || e.endTime >= hour)).sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
  return <div className="mx-auto max-w-7xl space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary"><CalendarDays className="size-4" />CAMPUS / CALENDAR</p><h1 className="text-3xl font-semibold tracking-tight">把这一周，安排得从容一点。</h1><p className="mt-2 text-sm text-muted-foreground">课程、待办与机会截止，在一张真实时间表里。</p></div><div className="rounded-2xl border bg-card px-4 py-3 text-right"><p className="text-xs text-muted-foreground">下一项已记录安排</p><p className="mt-1 max-w-64 truncate text-sm font-semibold">{next ? `${next.allDay ? "当天截止" : next.startTime} · ${next.title}` : "今天暂无后续安排"}</p><p className="mt-1 text-[10px] text-muted-foreground">{timezone}</p></div></header>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2"><button aria-label="上一周或日" onClick={() => setChosen(addDays(date, mode === "week" ? -7 : -1))} className="rounded-lg border p-2"><ChevronLeft className="size-4" /></button><button aria-label="下一周或日" onClick={() => setChosen(addDays(date, mode === "week" ? 7 : 1))} className="rounded-lg border p-2"><ChevronRight className="size-4" /></button><button onClick={() => setChosen(today)} className="rounded-lg border px-3 py-2 text-xs">回到今天</button><div className="ml-1"><p className="text-sm font-semibold">{mode === "week" ? `${from.slice(5)} — ${to.slice(5)}` : date}</p><p className="text-[11px] text-muted-foreground">{term && activeWeek !== null ? activeWeek < 1 || activeWeek > term.totalWeeks || date > term.endDate ? "学期之外" : `第 ${activeWeek} 教学周 · ${term.name}` : "尚未设置学期"}</p></div></div>
      <div className="flex flex-wrap items-center gap-2"><label className="sr-only" htmlFor="calendar-date">查看日期</label><input id="calendar-date" type="date" value={date} onChange={(e) => { if (e.target.value) setChosen(e.target.value); }} className="min-w-0 rounded-lg border bg-background px-2 py-1.5 text-xs" />{(calendar.terms.data?.length ?? 0) > 0 && <select aria-label="选择学期" value={term?.id} onChange={(e) => { calendar.setTermId(e.target.value); setCampus(""); const t = calendar.terms.data?.find((t) => t.id === e.target.value); if (t) setChosen(today >= t.startDate && today <= t.endDate ? today : t.startDate); }} className="max-w-40 rounded-lg border bg-background px-2 py-2 text-xs">{calendar.terms.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}{campuses.length > 0 && <select aria-label="筛选校区" value={campus} onChange={(e) => setCampus(e.target.value)} className="max-w-32 rounded-lg border bg-background p-2 text-xs"><option value="">全部校区</option>{campuses.map((c) => <option key={c} value={c}>{c}</option>)}</select>}<div className="flex rounded-lg bg-muted p-1">{(["day", "week"] as const).map((v) => <button key={v} aria-pressed={mode === v} onClick={() => setMode(v)} className={`rounded-md px-3 py-1 text-xs ${mode === v ? "bg-card font-semibold text-primary shadow-sm" : "text-muted-foreground"}`}>{v === "day" ? "日" : "周"}</button>)}</div></div>
    </div>
    {knowledge === "loading" && <p role="status" className="text-sm text-muted-foreground">正在读取学期与课表…</p>}
    {knowledge === "error" && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">课表读取失败，暂不能判断空闲。<button className="ml-2 underline" onClick={() => { void calendar.terms.refetch(); if (term) void schedules.refetch(); }}>重新读取</button></div>}
    {(knowledge === "unknown" || knowledge === "empty") && <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">{knowledge === "unknown" ? "课表尚未接入" : "本学期尚无课程记录"}。下方仍显示已有任务与机会；空闲时间需在导入后核对。</p>}
    {(tasks.isError || opps.isError) && <p role="alert" className="text-sm text-destructive">部分待办或机会读取失败，当前日历信息不完整。</p>}
    {projected.warnings.map((w) => <p key={w} role="alert" className="text-xs text-amber-700 dark:text-amber-300">{w}</p>)}
    <Timetable entries={entries} from={from} mode={mode} selectedDate={date} timezone={timezone} termId={term?.id} schemes={schedules.data?.schemes ?? []} campus={campus} />
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <section className="rounded-2xl border bg-card p-4"><h2 className="flex items-center gap-2 text-sm font-semibold"><Clock3 className="size-4 text-teal-600" />课表外可安排时段</h2><p className="mt-1 text-xs text-muted-foreground">只扣除已记录的定时安排，未记录事项可能仍占用时间。</p><div className="mt-3 flex flex-wrap gap-2">{free.length ? free.slice(0, 12).map((s, i) => <span key={i} className="rounded-lg bg-teal-50 px-2.5 py-1.5 text-xs text-teal-800 dark:bg-teal-950 dark:text-teal-200">{DAYS[s.weekday - 1]} {s.startTime}–{s.endTime}</span>) : <p className="text-xs text-muted-foreground">{knowledge === "ready" ? "本范围没有不少于30分钟的已知空档" : "课表信息不足，暂不提供空闲建议"}</p>}</div></section>
      <section className="rounded-2xl border bg-card p-4"><h2 className="flex items-center gap-2 text-sm font-semibold"><ArrowUpRight className="size-4 text-rose-500" />逾期待处理 <span className="text-muted-foreground">{overdue.length}</span></h2>{overdue.length ? overdue.slice(0, 3).map((t) => <div key={t.id} className="mt-2 flex justify-between gap-3 text-xs"><span className="truncate">{t.title}</span><span className="shrink-0 text-muted-foreground">{t.dueAt?.slice(0, 10)}</span></div>) : <p className="mt-3 text-xs text-muted-foreground">没有已记录的逾期任务</p>}</section>
    </div>
    <ScheduleImport key={term?.id ?? "no-term"} term={term} onTerm={calendar.setTermId} />
  </div>;
}
