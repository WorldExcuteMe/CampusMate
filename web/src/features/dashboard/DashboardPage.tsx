import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { CalendarDays, Clock3, Inbox, Radar, ShieldAlert, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { repository } from "@/app/config";
import { ClassBadge, DeadlineTag, EmptyState, PageHeader } from "@/components/shared";
import { useCampusCalendar } from "@/features/calendar/use-campus-calendar";
import { todayTasks, overdueTasks, upcomingDeadlines } from "@/lib/domain/today";
import { dateEntries, localParts, projectCourses } from "../../../../shared/calendar";

export function DashboardPage() {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => repository.listInbox() });
  const calendar = useCampusCalendar();
  const { tasks, opps, term, today, timezone, knowledge, schedules } = calendar;

  const complete = useMutation({
    mutationFn: (id: string) => repository.updateTask(id, { status: "done" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("任务已完成");
    },
  });

  const allTasks = tasks.data ?? [];
  const openTasks = allTasks.filter((t) => t.status === "todo" || t.status === "in_progress");
  const riskCount = (inbox.data ?? []).filter((i) => i.classification.class === "risk").length;
  const urgent = upcomingDeadlines(allTasks, 7, Date.now(), timezone).length;
  const todayTodo = todayTasks(allTasks, Date.now(), timezone);
  const overdue = overdueTasks(allTasks, Date.now(), timezone);
  const courses = term && knowledge === "ready" ? projectCourses(term, schedules.data?.schedules ?? [], schedules.data?.exceptions ?? [], today, today).entries : [];
  const next = [...courses, ...dateEntries({ from: today, to: today, timezone, tasks: allTasks, opps: opps.data ?? [] })].filter((e) => e.allDay || e.endTime >= localParts(Date.now(), timezone).time).sort((a, b) => a.startTime.localeCompare(b.startTime))[0];

  const stats = [
    { label: "待办任务", value: openTasks.length, icon: ListTodo, to: "/app/growth" },
    { label: "7 天内截止", value: urgent, icon: ShieldAlert, to: "/app/growth" },
    { label: "风险条目", value: riskCount, icon: ShieldAlert, to: "/app/inbox" },
    { label: "机会总数", value: (opps.data ?? []).length, icon: Radar, to: "/app/radar" },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="今天，先做好这几件事。" description={`${today} · 课程、待办与临近截止。`} />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} to={s.to}>
            <Card className="transition-shadow hover:shadow-md">
              <CardContent className="flex items-center gap-3 p-4">
                <s.icon className="size-5 text-primary" />
                <div>
                  <p className="text-2xl font-semibold">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <section className="rounded-2xl border bg-card p-5"><div className="flex items-center justify-between"><h2 className="flex items-center gap-2 font-semibold"><CalendarDays className="size-4 text-primary" />今日课程</h2><Link to="/app/calendar" className="text-xs text-primary">打开课表 →</Link></div>
          {knowledge === "ready" ? courses.length ? <div className="mt-3 space-y-2">{courses.map((c) => <div key={c.id} className="flex items-center gap-4 rounded-xl bg-primary/5 px-3 py-2"><span className="text-xs font-semibold text-primary">{c.startTime}<span className="block font-normal text-muted-foreground">{c.endTime}</span></span><div className="min-w-0"><p className="truncate text-sm font-semibold">{c.title}</p><p className="text-xs text-muted-foreground">{[c.classroom, c.campus].filter(Boolean).join(" · ")}</p></div></div>)}</div> : <p className="mt-3 text-sm text-muted-foreground">今天没有已记录的课程</p> : <p className="mt-3 text-sm text-muted-foreground">{knowledge === "loading" ? "正在读取课表…" : knowledge === "error" ? "课表读取失败，请在日历中重试" : "尚无课表记录，可到日历导入"}</p>}
        </section>
        <section className="rounded-2xl border bg-primary/5 p-5"><h2 className="flex items-center gap-2 font-semibold"><Clock3 className="size-4 text-primary" />接下来</h2><p className="mt-3 text-lg font-semibold">{next?.title ?? "暂无后续已记录安排"}</p>{next && <p className="mt-1 text-sm text-muted-foreground">{next.allDay ? "当天截止" : `${next.startTime}–${next.endTime}`}</p>}<p className="mt-4 text-xs text-muted-foreground">今日待办 {todayTodo.length} · 逾期待处理 {overdue.length}</p></section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">待办任务</CardTitle>
            <Button variant="ghost" size="sm" asChild><Link to="/app/growth">全部</Link></Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {openTasks.length === 0 ? (
              <EmptyState title="暂无待办" hint="从 Inbox 确认通知后可生成待办。" />
            ) : (
              openTasks.slice(0, 6).map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <Checkbox
                    checked={false}
                    onCheckedChange={() => complete.mutate(t.id)}
                    aria-label={`完成 ${t.title}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    <DeadlineTag deadline={t.dueAt} />
                  </div>
                  <span className="text-xs text-muted-foreground">P{t.priority}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">最近通知</CardTitle>
            <Button variant="ghost" size="sm" asChild><Link to="/app/inbox">Inbox</Link></Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {(inbox.data ?? []).slice(0, 4).map((i) => (
              <Link key={i.id} to={`/app/inbox/${i.id}`} className="rounded-md border border-border p-3 hover:bg-muted">
                <div className="flex items-center gap-2">
                  <ClassBadge value={i.classification.class} />
                  <span className="ml-auto"><DeadlineTag deadline={i.extracted.deadline} /></span>
                </div>
                <p className="mt-1 truncate text-sm font-medium">{i.extracted.title}</p>
              </Link>
            ))}
            {(inbox.data ?? []).length === 0 && (
              <EmptyState title="收件箱为空" hint="导入一条通知开始。" />
            )}
          </CardContent>
        </Card>
      </div>

      <p className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Inbox className="size-3" />
        演示数据与 Mock 结果均明确标识；配置 Supabase 与模型后启用真实模式。
      </p>
    </div>
  );
}
