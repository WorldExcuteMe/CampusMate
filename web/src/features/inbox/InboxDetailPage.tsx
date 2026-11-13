import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ListPlus, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { repository } from "@/app/config";
import { uid } from "@/lib/data/types";
import {
  CategoryBadge,
  ClassBadge,
  DeadlineTag,
  MockBadge,
  PageHeader,
} from "@/components/shared";

export function InboxDetailPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { data: item, isLoading } = useQuery({
    queryKey: ["inbox", id],
    queryFn: () => repository.getInbox(id),
  });
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");

  const taskMutation = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error("无条目");
      await repository.createTask({
        id: uid(),
        userId: item.userId,
        title: taskTitle || `处理：${item.extracted.title}`,
        dueAt: taskDue || item.extracted.deadline,
        status: "todo",
        priority: item.classification.priorityScore,
        inboxItemId: item.id,
        estimateHours: null,
        kind: "general",
        createdAt: new Date().toISOString(),
        demo: item.demo,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("待办已创建，可在 Dashboard 查看");
      setTaskTitle("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "创建失败"),
  });

  const ignoreMutation = useMutation({
    mutationFn: () => repository.updateInbox(id, { status: "ignored" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["inbox", id] });
      toast.success("已忽略");
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (!item) return <p className="text-sm text-muted-foreground">未找到该条目。</p>;

  const e = item.extracted;
  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" size="sm" asChild className="mb-3">
        <Link to="/app/inbox"><ArrowLeft className="size-4" />返回 Inbox</Link>
      </Button>
      <PageHeader
        title={e.title}
        actions={
          <div className="flex items-center gap-2">
            <MockBadge />
            <ClassBadge value={item.classification.class} />
            <CategoryBadge value={e.category} />
          </div>
        }
      />

      <Card className="mb-4">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="发布组织" value={e.org || "—"} />
          <Field label="截止" value={<DeadlineTag deadline={e.deadline} />} />
          <Field label="地点" value={e.location || "—"} />
          <Field label="参与成本" value={e.cost || "—"} />
          <Field label="提取置信度" value={`${Math.round(e.confidence * 100)}%`} />
          <Field label="状态" value={item.status} />
          {e.conditions.length > 0 && (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">参与条件</p>
              <ul className="mt-1 list-disc pl-5 text-sm">{e.conditions.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
          {e.materials.length > 0 && (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">所需材料</p>
              <ul className="mt-1 list-disc pl-5 text-sm">{e.materials.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground">优先级理由</p>
            <p className="mt-1 text-sm">{item.classification.priorityReason}（{item.classification.priorityScore} 分）</p>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">生成待办</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div>
            <Label>任务标题</Label>
            <Input
              placeholder={`处理：${e.title}`}
              value={taskTitle}
              onChange={(ev) => setTaskTitle(ev.target.value)}
            />
          </div>
          <div>
            <Label>截止日期</Label>
            <Input type="date" value={taskDue} onChange={(ev) => setTaskDue(ev.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button disabled={taskMutation.isPending} onClick={() => taskMutation.mutate()}>
              <ListPlus className="size-4" />创建任务
            </Button>
            <Button variant="outline" disabled={ignoreMutation.isPending} onClick={() => ignoreMutation.mutate()}>
              <EyeOff className="size-4" />忽略此条
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">原文证据</CardTitle></CardHeader>
        <CardContent>
          <Separator className="mb-3" />
          <pre className="whitespace-pre-wrap text-sm text-muted-foreground">{item.rawText}</pre>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm">{value}</div>
    </div>
  );
}