import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, EmptyState } from "@/components/shared";
import { repository } from "@/app/config";
import { backendEnabled, listTerms, listSchedules, type ScheduleRow } from "@/lib/agent/api-client";
import { buildWeekEntries, weekGrid, freeTime, type CalendarEntry } from "@/lib/domain/calendar-grid";

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const KIND_COLOR: Record<string, string> = { course: "bg-primary/10 text-primary", deadline: "bg-destructive/10 text-destructive", opportunity: "bg-accent text-accent-foreground", exam: "bg-secondary text-secondary-foreground", activity: "bg-muted text-muted-foreground", interview: "bg-secondary text-secondary-foreground" };

// 当前教学周（从学期起始推算）。
function currentWeek(startDate: string, totalWeeks: number): number {
  const days = Math.floor((Date.now() - Date.parse(startDate + "T00:00:00")) / 86400000);
  return days < 0 ? 1 : Math.min(totalWeeks, Math.floor(days / 7) + 1);
}

export function CalendarPage() {
  const [week, setWeek] = useState<number | null>(null);
  const terms = useQuery({ queryKey: ["terms"], queryFn: () => listTerms(), enabled: backendEnabled() });
  const term = terms.data?.[0];
  const schedules = useQuery({ queryKey: ["schedules", term?.id], queryFn: () => listSchedules(term!.id), enabled: Boolean(term) });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => repository.listTasks() });
  const opps = useQuery({ queryKey: ["opps"], queryFn: () => repository.listOpportunities() });

  const activeWeek = week ?? (term ? currentWeek(term.startDate, term.totalWeeks) : 1);

  const entries = useMemo<CalendarEntry[]>(() => {
    const sched: ScheduleRow[] = schedules.data?.schedules ?? [];
    // 任务截止 + 机会截止 → 日历条目（按 dueAt 的星期）。
    const dated: CalendarEntry[] = [];
    for (const t of tasks.data ?? []) {
      if (!t.dueAt) continue;
      const d = new Date(t.dueAt);
      dated.push({ id: `task-${t.id}`, title: `截止：${t.title}`, weekday: d.getDay() || 7, startTime: "23:59", endTime: "23:59", kind: "deadline" });
    }
    for (const o of opps.data ?? []) {
      if (!o.deadline) continue;
      const d = new Date(o.deadline);
      dated.push({ id: `opp-${o.id}`, title: `机会：${o.title}`, weekday: d.getDay() || 7, startTime: "23:59", endTime: "23:59", kind: "opportunity" });
    }
    return buildWeekEntries(activeWeek, sched, dated);
  }, [schedules.data, tasks.data, opps.data, activeWeek]);

  const grid = useMemo(() => weekGrid(entries), [entries]);
  const free = useMemo(() => freeTime(entries.filter((e) => e.kind === "course")), [entries]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="校园日历" description="课程、考试、活动、任务截止与机会的统一周视图。" />
      <div className="mb-4 flex items-center gap-3">
        <CalendarDays className="size-5 text-primary" />
        <span className="text-sm">第 {activeWeek} 教学周</span>
        <button className="rounded border px-2 py-1 text-xs" onClick={() => setWeek(Math.max(1, activeWeek - 1))}>上一周</button>
        <button className="rounded border px-2 py-1 text-xs" onClick={() => setWeek(activeWeek + 1)}>下一周</button>
        {!backendEnabled() && <span className="text-xs text-muted-foreground">（未配置后端，课表为空；任务/机会截止来自本地数据）</span>}
      </div>

      {entries.length === 0 ? (
        <EmptyState title="本周暂无安排" description="导入课表或创建任务后，这里会显示你的校园安排。" />
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {grid.map((day, i) => (
            <Card key={i} className="min-h-32">
              <CardHeader className="p-2 pb-1"><CardTitle className="text-xs">{DAYS[i]}</CardTitle></CardHeader>
              <CardContent className="space-y-1 p-2 pt-0">
                {day.map((e) => (
                  <div key={e.id} className={`rounded px-1.5 py-1 text-[11px] ${KIND_COLOR[e.kind] ?? "bg-muted"}`}>
                    <div className="font-medium truncate">{e.title}</div>
                    {e.kind === "course" && <div className="opacity-70">{e.startTime}-{e.endTime}{e.classroom ? ` · ${e.classroom}` : ""}</div>}
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="mt-4">
        <CardHeader className="p-3 pb-1"><CardTitle className="flex items-center gap-2 text-sm"><Clock className="size-4" />空闲时间（≥30分钟，08:00-22:00）</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2 p-3 pt-1">
          {free.length === 0 ? <span className="text-xs text-muted-foreground">无空闲时段</span> :
            free.slice(0, 12).map((f, i) => <span key={i} className="rounded bg-muted px-2 py-1 text-[11px]">{DAYS[f.weekday - 1]} {f.startTime}-{f.endTime}（{f.minutes}分钟）</span>)}
        </CardContent>
      </Card>
    </div>
  );
}