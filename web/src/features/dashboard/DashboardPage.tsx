import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Check, Inbox, Radar, ShieldAlert, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useRepository } from "@/app/auth";
import type { Task } from "@/lib/data/types";
import { isOpenTask, isTaskOverdue, isTaskDueSoon, opportunityTimeState } from "@/lib/time-policy";
import { useBeijingDay } from "@/lib/use-beijing-day";
import { ClassBadge, DeadlineTag, EmptyState, PageHeader } from "@/components/shared";

export function DashboardPage() {
  const repository = useRepository();
  const qc = useQueryClient();
  const today = useBeijingDay();
  const [pendingTask, setPendingTask] = useState<Task | null>(null);
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => repository.listInbox() });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => repository.listTasks() });
  const opps = useQuery({ queryKey: ["opps"], queryFn: () => repository.listOpportunities() });

  const complete = useMutation({
    mutationFn: (id: string) => repository.updateTask(id, { status: "done" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["tasks"] });
      setPendingTask(null);
      toast.success("任务已完成");
    },
    onError: () => toast.error("完成任务失败，请重试"),
  });

  const allTasks = tasks.data ?? [];
  const openTasks = allTasks.filter(isOpenTask);
  const overdueTasks = openTasks.filter((t) => isTaskOverdue(t, today));
  const currentTasks = openTasks.filter((t) => !isTaskOverdue(t, today));
  const riskCount = (inbox.data ?? []).filter((i) => i.classification.class === "risk").length;
  const urgent = openTasks.filter((t) => isTaskDueSoon(t, today)).length;

  const stats = [
    { label: "待办任务", value: openTasks.length, icon: ListTodo, to: "/app/growth" },
    { label: "7 天内截止", value: urgent, icon: ShieldAlert, to: "/app/growth?view=soon" },
    { label: "已逾期待处理", value: overdueTasks.length, icon: ShieldAlert, to: "/app/growth?view=overdue" },
    { label: "风险条目", value: riskCount, icon: ShieldAlert, to: "/app/inbox" },
    { label: "有效机会", value: (opps.data ?? []).filter((o) => opportunityTimeState(o, today) === "active").length, icon: Radar, to: "/app/radar" },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Dashboard" description="你的待办、临近截止与风险一览。" />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
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

      {overdueTasks.length > 0 && (
        <Card className="mb-4 border-amber-500/40">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base" role="heading" aria-level={2}>逾期待办（{overdueTasks.length}）</CardTitle>
            <Button variant="ghost" size="sm" asChild><Link to="/app/growth?view=overdue">去处理</Link></Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">仅标记逾期，不会自动完成或删除。请核实后完成或取消。</p>
            {overdueTasks.slice(0, 3).map((t) => <div key={t.id} className="rounded-md border border-border p-3">
              <p className="truncate text-sm font-medium">{t.title}</p>
              <DeadlineTag deadline={t.dueAt} pastLabel="已逾期" />
            </div>)}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">待办任务</CardTitle>
            <Button variant="ghost" size="sm" asChild><Link to="/app/growth">全部</Link></Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {currentTasks.length === 0 ? (
              <EmptyState title="暂无待办" hint="从 Inbox 确认通知后可生成待办。" />
            ) : (
              currentTasks.slice(0, 6).map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <Checkbox
                    checked={false}
                    disabled={complete.isPending}
                    onCheckedChange={(checked) => { if (checked === true) setPendingTask(t); }}
                    aria-label={`完成 ${t.title}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    <DeadlineTag deadline={t.dueAt} pastLabel="已逾期" />
                  </div>
                  <span className="text-xs text-muted-foreground">P{t.priority}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
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
        业务数据与模型接入分别配置；真实模型、规则提取与调用失败按实际情况标识。
      </p>

      <AlertDialog open={pendingTask !== null} onOpenChange={(open) => {
        if (!open && !complete.isPending) setPendingTask(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认完成任务？</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              将「{pendingTask?.title}」标记为已完成？确认后将从待办列表移除，可在成长中心查看。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={complete.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={complete.isPending} onClick={(event) => {
              event.preventDefault();
              if (pendingTask && !complete.isPending) complete.mutate(pendingTask.id);
            }}>
              {complete.isPending ? "正在保存…" : "确认完成"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
