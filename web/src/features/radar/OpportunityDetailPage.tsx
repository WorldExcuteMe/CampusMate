import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ShieldCheck, ListPlus, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRepository } from "@/app/auth";
import { uid } from "@/lib/data/types";
import { CategoryBadge, DeadlineTag, PageHeader, VerifyBadge } from "@/components/shared";
import type { NoticeCategory } from "@/lib/schemas";
import { opportunityTimeState, OPPORTUNITY_TIME_LABELS } from "@/lib/time-policy";
import { useBeijingDay } from "@/lib/use-beijing-day";

export function OpportunityDetailPage() {
  const repository = useRepository();
  const today = useBeijingDay();
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const { data: opp } = useQuery({ queryKey: ["opp", id], queryFn: () => repository.getOpportunity(id) });
  const { data: reports = [] } = useQuery({ queryKey: ["reports"], queryFn: () => repository.listReports() });
  const report = reports.find((r) => r.opportunityId === id);

  const planMutation = useMutation({
    mutationFn: async () => {
      if (!opp) throw new Error("无机会");
      const state = opportunityTimeState(opp);
      if (state === "expired" || state === "archived") throw new Error("该机会已过期或已归档，请核实新的有效通知后再创建计划");
      await repository.createTask({
        id: uid(),
        userId: "demo-user",
        title: `准备参与：${opp.title}`,
        dueAt: opp.deadline,
        status: "todo",
        priority: 70,
        inboxItemId: null,
        estimateHours: 4,
        kind: "opportunity",
        createdAt: new Date().toISOString(),
        demo: opp.demo,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("已创建参与计划待办");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "创建计划失败，请重试"),
  });

  if (!opp) return <p className="text-sm text-muted-foreground">未找到该机会。</p>;
  const timeState = opportunityTimeState(opp, today);
  const historical = timeState === "expired" || timeState === "archived";

  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" size="sm" asChild className="mb-3">
        <Link to="/app/radar"><ArrowLeft className="size-4" />返回雷达</Link>
      </Button>
      <PageHeader
        title={opp.title}
        actions={<CategoryBadge value={opp.type as NoticeCategory} />}
      />
      <Card className="mb-4">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
          <Info label="主办方" value={opp.organizer} />
          <Info label="截止" value={<DeadlineTag deadline={opp.deadline} />} />
          <Info label="时效状态" value={OPPORTUNITY_TIME_LABELS[timeState]} />
          <Info label="来源类型" value={opp.sourceType} />
          <Info label="采集时间" value={opp.collectedAt.slice(0, 10)} />
          <div className="sm:col-span-2">
            <p className="text-xs text-muted-foreground">描述</p>
            <p className="mt-1 text-sm">{opp.description}</p>
          </div>
          {opp.conditions.length > 0 && (
            <div className="sm:col-span-2">
              <p className="text-xs text-muted-foreground">参与条件</p>
              <ul className="mt-1 list-disc pl-5 text-sm">{opp.conditions.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          )}
          <div className="sm:col-span-2">
            <a href={opp.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
              <ExternalLink className="size-3" />来源链接（示例域名）
            </a>
          </div>
        </CardContent>
      </Card>

      {historical && <p className="mb-3 text-sm text-muted-foreground" role="status">此为{OPPORTUNITY_TIME_LABELS[timeState]}的历史记录，不再创建参与计划。记录与核验报告仍保留供查阅。</p>}
      {timeState === "unknown" && <p className="mb-3 text-sm text-amber-600" role="status">截止日期待核实，请先查看原始通知；不要将其视为已确认可报名的机会。</p>}
      <div className="mb-4 flex flex-wrap gap-2">
        <Button disabled={planMutation.isPending || historical} onClick={() => planMutation.mutate()}>
          <ListPlus className="size-4" />创建参与计划
        </Button>
        {report && (
          <Button variant="secondary" asChild>
            <Link to={`/app/trust/${report.id}`}><ShieldCheck className="size-4" />查看核验报告</Link>
          </Button>
        )}
      </div>

      {report && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">可信度核验</CardTitle>
            <VerifyBadge value={report.status} />
          </CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">{report.summary}</p></CardContent>
        </Card>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm">{value}</div>
    </div>
  );
}
