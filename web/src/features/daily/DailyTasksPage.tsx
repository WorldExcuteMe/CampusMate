import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Import, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth, useRepository } from "@/app/auth";
import { uid } from "@/lib/data/types";
import { cleanGroupMessage, dedupKey, extractDailyTime, isDailyNotice } from "@/lib/ingest/clean";
import { DeadlineTag, EmptyState, PageHeader } from "@/components/shared";
import { isOpenTask, isTaskOverdue } from "@/lib/time-policy";
import { useBeijingDay } from "@/lib/use-beijing-day";

const SEEN_KEY = "campusmate.daily.seen";

export function DailyTasksPage() {
  const repository = useRepository();
  const { session } = useAuth();
  const seenKey = `${SEEN_KEY}.${session?.user.id ?? "demo"}`;
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery({ queryKey: ["tasks"], queryFn: () => repository.listTasks() });
  const daily = tasks.filter((t) => t.kind === "daily");
  const today = useBeijingDay();
  const overdue = daily.filter((t) => isTaskOverdue(t, today));
  const current = daily.filter((t) => !isTaskOverdue(t, today));
  const [raw, setRaw] = useState("");

  const preview = useMemo(() => {
    if (!raw.trim()) return null;
    const cleaned = cleanGroupMessage(raw);
    const t = extractDailyTime(cleaned);
    return { cleaned, ...t, daily: isDailyNotice(cleaned) };
  }, [raw, today]);

  const complete = useMutation({
    mutationFn: ({ id, checked }: { id: string; checked: boolean }) =>
      repository.updateTask(id, { status: checked ? "done" : "todo" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
    onError: () => toast.error("更新任务状态失败，请重试"),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("无内容");
      const key = dedupKey(raw);
      const seen: string[] = JSON.parse(localStorage.getItem(seenKey) || "[]");
      if (seen.includes(key)) throw new Error("该通知已导入（去重）");
      const firstLine = preview.cleaned.split("\n")[0].slice(0, 40);
      await repository.createTask({
        id: uid(),
        userId: "demo-user",
        title: firstLine || "日常任务",
        dueAt: preview.dueAt,
        status: "todo",
        priority: 65,
        inboxItemId: null,
        estimateHours: 1,
        kind: "daily",
        timeText: preview.timeText,
        createdAt: new Date().toISOString(),
        demo: repository.mode === "demo",
      });
      localStorage.setItem(seenKey, JSON.stringify([...seen, key]));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("已导入日常任务");
      setRaw("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "导入失败"),
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="日常任务专区" description="收集调课、班会、讲座等含时间日期的群通知；自动清洗、去重、提取时间。" />

      <Card className="mb-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Import className="size-4" />导入群通知（QQ/微信转发）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea rows={4} placeholder="粘贴转发的群消息，如「@全体 周五19:00在教三101开班会，收到回复」" value={raw} onChange={(e) => setRaw(e.target.value)} />
          {preview && (
            <div className="rounded-md bg-muted p-3 text-xs">
              <p className="font-medium">清洗后：{preview.cleaned}</p>
              <p className="mt-1 text-muted-foreground">
                识别时间：{preview.dueAt ?? "未识别"} {preview.timeText} · {preview.daily ? "日常事务" : "非典型日常，仍可导入"}
              </p>
            </div>
          )}
          <Button disabled={!preview || importMutation.isPending} onClick={() => importMutation.mutate()}>
            导入为日常任务
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="size-4" />日常任务（{daily.length}）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          {daily.length === 0 ? (
            <EmptyState title="暂无日常任务" hint="导入群通知或在 Agent 对话中创建。" />
          ) : (
            [{ title: "日常记录", tasks: current }, { title: `逾期待处理（${overdue.length}）`, tasks: overdue }].filter((section) => section.tasks.length > 0).map((section) => (
              <section key={section.title} className="flex flex-col gap-2" aria-label={section.title}>
                {overdue.length > 0 && <h2 className="mt-2 text-sm font-medium">{section.title}</h2>}
                {section.tasks === overdue && <p className="text-xs text-muted-foreground">未自动完成或删除；核实后仍可勾选完成。</p>}
                {section.tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                    <Checkbox
                      checked={t.status === "done"}
                      disabled={complete.isPending}
                      onCheckedChange={(checked) => complete.mutate({ id: t.id, checked: checked === true })}
                      aria-label={`${t.status === "done" ? "撤销完成" : "完成"} ${t.title}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      <div className="flex items-center gap-2">
                        <DeadlineTag deadline={t.dueAt} pastLabel={isOpenTask(t) ? "已逾期" : "截止已过"} />
                        {t.timeText && <span className="text-xs text-muted-foreground">{t.timeText}</span>}
                      </div>
                    </div>
                    {t.status === "done" && <Check className="size-4 text-emerald-600" />}
                  </div>
                ))}
              </section>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
