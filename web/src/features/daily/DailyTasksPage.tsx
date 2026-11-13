import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Import, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { repository } from "@/app/config";
import { uid } from "@/lib/data/types";
import { cleanGroupMessage, dedupKey, extractDailyTime, isDailyNotice } from "@/lib/ingest/clean";
import { DeadlineTag, EmptyState, PageHeader } from "@/components/shared";

const SEEN_KEY = "campusmate.daily.seen";

export function DailyTasksPage() {
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery({ queryKey: ["tasks"], queryFn: () => repository.listTasks() });
  const daily = tasks.filter((t) => t.kind === "daily");
  const [raw, setRaw] = useState("");

  const preview = useMemo(() => {
    if (!raw.trim()) return null;
    const cleaned = cleanGroupMessage(raw);
    const t = extractDailyTime(cleaned);
    return { cleaned, ...t, daily: isDailyNotice(cleaned) };
  }, [raw]);

  const complete = useMutation({
    mutationFn: (id: string) => repository.updateTask(id, { status: "done" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("无内容");
      const key = dedupKey(raw);
      const seen: string[] = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
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
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, key]));
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
            daily.map((t) => (
              <div key={t.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                <Checkbox checked={t.status === "done"} onCheckedChange={() => complete.mutate(t.id)} aria-label={`完成 ${t.title}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  <div className="flex items-center gap-2">
                    <DeadlineTag deadline={t.dueAt} />
                    {t.timeText && <span className="text-xs text-muted-foreground">{t.timeText}</span>}
                  </div>
                </div>
                {t.status === "done" && <Check className="size-4 text-emerald-600" />}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}