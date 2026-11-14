import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles, Save, ListPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { llmProvider } from "@/app/config";
import { useRepository } from "@/app/auth";
import { runInboxPipeline, type AgentRun } from "@/lib/agent/orchestrator";
import {
  extractedNoticeSchema,
  noticeCategory,
  type Classification,
  type ExtractedNotice,
  type NoticeCategory,
} from "@/lib/schemas";
import { uid, type InboxItem } from "@/lib/data/types";
import { ClassBadge, MockBadge, PageHeader } from "@/components/shared";

const SAMPLE = `关于举办2026年全国大学生人工智能创新大赛的通知
主办单位：教务处
参赛条件：全日制在校本科生，组队不超过3人
报名截止：2026年11月25日
所需材料：项目计划书、团队成员信息
地点：线上初赛，决赛在校本部`;

export function NewInboxPage() {
  const repository = useRepository();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [rawText, setRawText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [extracted, setExtracted] = useState<ExtractedNotice | null>(null);
  const [classification, setClassification] = useState<Classification | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const extractMutation = useMutation({
    mutationFn: async () => {
      setError(null);
      return runInboxPipeline(
        { rawText, sourceUrl: sourceUrl || null, sourceType: "text" },
        llmProvider,
      );
    },
    onSuccess: (res) => {
      setExtracted(res.extracted);
      setClassification(res.classification);
      setRun(res.run);
      toast.success("提取完成，请审核结构化结果");
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "提取失败";
      setError(msg);
      toast.error(`提取失败：${msg}`);
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!extracted || !classification || !run) throw new Error("请先提取");
      const parsed = extractedNoticeSchema.parse(extracted);
      const item: InboxItem = {
        id: uid(),
        userId: repository.mode === "demo" ? "demo-user" : "me",
        rawText,
        sourceUrl: sourceUrl || null,
        sourceType: "text",
        extracted: parsed,
        classification,
        status: "confirmed",
        createdAt: new Date().toISOString(),
        demo: repository.mode === "demo",
        extractionMock: run.mock,
      };
      await repository.createInbox(item);
      await repository.logAgentRun(run);
      await repository.logActivity({
        id: uid(),
        userId: item.userId,
        eventType: "inbox.confirmed",
        entityType: "inbox_item",
        entityId: item.id,
        createdAt: new Date().toISOString(),
      });
      return item;
    },
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      toast.success("已确认保存到 Inbox");
      navigate(`/app/inbox/${item.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "保存失败"),
  });

  const taskMutation = useMutation({
    mutationFn: async () => {
      if (!extracted) throw new Error("请先提取");
      const item: InboxItem = {
        id: uid(),
        userId: repository.mode === "demo" ? "demo-user" : "me",
        rawText,
        sourceUrl: sourceUrl || null,
        sourceType: "text",
        extracted: extractedNoticeSchema.parse(extracted),
        classification: classification!,
        status: "confirmed",
        createdAt: new Date().toISOString(),
        demo: repository.mode === "demo",
        extractionMock: run?.mock ?? true,
      };
      await repository.createInbox(item);
      if (run) await repository.logAgentRun(run);
      await repository.createTask({
        id: uid(),
        userId: item.userId,
        title: `处理：${item.extracted.title}`,
        dueAt: item.extracted.deadline,
        status: "todo",
        priority: classification?.priorityScore ?? 50,
        inboxItemId: item.id,
        estimateHours: null,
        kind: "general",
        createdAt: new Date().toISOString(),
        demo: item.demo,
      });
      return item;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("已保存并生成待办，可在 Dashboard 查看");
      navigate("/app");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "操作失败"),
  });

  function patch<K extends keyof ExtractedNotice>(key: K, value: ExtractedNotice[K]) {
    setExtracted((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const busy = extractMutation.isPending || saveMutation.isPending || taskMutation.isPending;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="导入通知" description="粘贴通知文本 → AI 提取 → 审核修改 → 确认保存 / 生成待办。" />

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">1. 输入通知</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            rows={8}
            placeholder="粘贴校园通知文本…"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-xs"
              placeholder="来源 URL（可选）"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={() => setRawText(SAMPLE)}>
              填入示例
            </Button>
            <Button
              className="ml-auto"
              disabled={!rawText.trim() || busy}
              onClick={() => extractMutation.mutate()}
            >
              {extractMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              AI 提取
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      {extracted && classification && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">2. 审核结构化结果</CardTitle>
            <div className="flex items-center gap-2">
              {run?.mock ? <MockBadge /> : <span className="text-xs text-emerald-700">真实模型提取</span>}
              <ClassBadge value={classification.class} />
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="notice-title">标题</Label>
                <Input id="notice-title" value={extracted.title} onChange={(e) => patch("title", e.target.value)} />
              </div>
              <div>
                <Label>类别</Label>
                <Select
                  value={extracted.category}
                  onValueChange={(v) => patch("category", v as NoticeCategory)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {noticeCategory.options.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>截止日期</Label>
                <Input
                  type="date"
                  value={extracted.deadline ?? ""}
                  onChange={(e) => patch("deadline", e.target.value || null)}
                />
              </div>
              <div>
                <Label>发布组织</Label>
                <Input value={extracted.org} onChange={(e) => patch("org", e.target.value)} />
              </div>
              <div>
                <Label>地点</Label>
                <Input value={extracted.location ?? ""} onChange={(e) => patch("location", e.target.value || null)} />
              </div>
              <div className="sm:col-span-2">
                <Label>摘要</Label>
                <Textarea rows={2} value={extracted.summary} onChange={(e) => patch("summary", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <Label>参与条件（每行一条）</Label>
                <Textarea
                  rows={2}
                  value={extracted.conditions.join("\n")}
                  onChange={(e) => patch("conditions", e.target.value.split("\n").filter(Boolean))}
                />
              </div>
            </div>

            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              <p>优先级 {classification.priorityScore} · {classification.priorityReason}</p>
              {classification.riskSignals.length > 0 && (
                <p className="mt-1 text-rose-600">风险信号：{classification.riskSignals.join("、")}</p>
              )}
              {run && <p className="mt-1">提取来源：{run.provider} / {run.model}（{run.mock ? "Mock" : "真实模型"}）</p>}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => saveMutation.mutate()}>
                <Save className="size-4" />确认保存
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => taskMutation.mutate()}>
                <ListPlus className="size-4" />保存并生成待办
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
