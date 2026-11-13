import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Check, Inbox, Radar, ShieldAlert, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { repository } from "@/app/config";
import { ClassBadge, DeadlineTag, EmptyState, PageHeader } from "@/components/shared";

export function DashboardPage() {
  const qc = useQueryClient();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => repository.listInbox() });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => repository.listTasks() });
  const opps = useQuery({ queryKey: ["opps"], queryFn: () => repository.listOpportunities() });

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
  const urgent = openTasks.filter(
    (t) => t.dueAt && Math.ceil((Date.parse(t.dueAt) - Date.now()) / 86_400_000) <= 7,
  ).length;

  const stats = [
    { label: "待办任务", value: openTasks.length, icon: ListTodo, to: "/app/growth" },
    { label: "7 天内截止", value: urgent, icon: ShieldAlert, to: "/app/growth" },
    { label: "风险条目", value: riskCount, icon: ShieldAlert, to: "/app/inbox" },
    { label: "机会总数", value: (opps.data ?? []).length, icon: Radar, to: "/app/radar" },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Dashboard" description="你的待办、临近截止与风险一览。" />

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