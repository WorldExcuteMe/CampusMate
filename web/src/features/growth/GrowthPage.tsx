import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRepository } from "@/app/auth";
import { DeadlineTag, EmptyState, PageHeader } from "@/components/shared";
import type { TaskStatus } from "@/lib/schemas";
import { isOpenTask, isTaskOverdue, isTaskDueSoon } from "@/lib/time-policy";
import { useBeijingDay } from "@/lib/use-beijing-day";

export function GrowthPage() {
  const repository = useRepository();
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery({ queryKey: ["tasks"], queryFn: () => repository.listTasks() });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => repository.getProfile() });
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view") ?? "open";
  const tab = ["open", "soon", "overdue", "done", "all"].includes(requestedView) ? requestedView : "open";
  const today = useBeijingDay();

  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TaskStatus }) =>
      repository.updateTask(id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "更新失败"),
  });

  const open = tasks.filter((t) => isOpenTask(t) && !isTaskOverdue(t, today));
  const overdue = tasks.filter((t) => isTaskOverdue(t, today));
  const soon = tasks.filter((t) => isTaskDueSoon(t, today));
  const done = tasks.filter((t) => t.status === "done");
  const shown = tab === "open" ? open : tab === "soon" ? soon : tab === "overdue" ? overdue : tab === "done" ? done : tasks;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Growth Center" description="目标、任务规划与成长档案。完成任务经确认后计入成长经历。" />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">任务</CardTitle>
            <Tabs value={tab} onValueChange={(view) => setParams((current) => { const next = new URLSearchParams(current); next.set("view", view); return next; })} className="min-w-0 max-w-full">
              <TabsList className="max-w-full flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto">
                <TabsTrigger value="open">进行中</TabsTrigger>
                <TabsTrigger value="soon">7 天内截止</TabsTrigger>
                <TabsTrigger value="overdue">已逾期（{overdue.length}）</TabsTrigger>
                <TabsTrigger value="done">已完成</TabsTrigger>
                <TabsTrigger value="all">全部</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {tab === "overdue" && <p className="text-xs text-muted-foreground">逾期不等于已完成。核实后手动完成或取消；不会自动删除历史记录。</p>}
            {shown.length === 0 ? (
              <EmptyState title="暂无任务" />
            ) : (
              shown.map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    <DeadlineTag deadline={t.dueAt} pastLabel={isOpenTask(t) ? "已逾期" : "截止已过"} />
                  </div>
                  <span className="text-xs text-muted-foreground">{t.status}</span>
                  {t.status !== "done" && (
                    <Button size="icon-xs" variant="ghost" aria-label="完成" onClick={() => update.mutate({ id: t.id, status: "done" })}>
                      <Check className="size-4 text-emerald-600" />
                    </Button>
                  )}
                  {t.status !== "cancelled" && t.status !== "done" && (
                    <Button size="icon-xs" variant="ghost" aria-label="取消" onClick={() => update.mutate({ id: t.id, status: "cancelled" })}>
                      <X className="size-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader><CardTitle className="text-base">我的目标</CardTitle></CardHeader>
            <CardContent>
              <ul className="list-disc pl-5 text-sm">
                {(profile?.goals ?? []).map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">成长档案</CardTitle></CardHeader>
            <CardContent>
              {done.length === 0 ? (
                <p className="text-xs text-muted-foreground">完成的任务将在此积累。</p>
              ) : (
                <ul className="list-disc pl-5 text-sm">{done.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
