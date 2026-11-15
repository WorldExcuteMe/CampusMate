import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { opportunityTimeState, OPPORTUNITY_TIME_LABELS, type OpportunityTimeState } from "@/lib/time-policy";
import { useBeijingDay } from "@/lib/use-beijing-day";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRepository } from "@/app/auth";
import { CategoryBadge, DeadlineTag, EmptyState, PageHeader } from "@/components/shared";
import type { NoticeCategory } from "@/lib/schemas";

export function RadarPage() {
  const repository = useRepository();
  const { data: opps = [] } = useQuery({
    queryKey: ["opps"],
    queryFn: () => repository.listOpportunities(),
  });
  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("all");
  const [time, setTime] = useState<OpportunityTimeState | "all">("active");
  const today = useBeijingDay();

  const matching = useMemo(() => opps.filter((o) =>
    (type === "all" || o.type === type) &&
    (!q.trim() || `${o.title} ${o.organizer}`.toLowerCase().includes(q.trim().toLowerCase())),
  ), [opps, q, type]);

  const filtered = useMemo(
    () =>
      matching.filter((o) => time === "all" || opportunityTimeState(o, today) === time),
    [matching, time, today],
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Opportunity Radar" description="按北京时间管理截止日期；过期记录保留在历史分类，不自动删除。" />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="搜索机会…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="competition">学科竞赛</SelectItem>
            <SelectItem value="internship">实习招聘</SelectItem>
            <SelectItem value="research">科研项目</SelectItem>
            <SelectItem value="scholarship">奖学金</SelectItem>
            <SelectItem value="activity">校园活动</SelectItem>
            <SelectItem value="opensource">开源项目</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="机会时效筛选">
        {(["active", "expired", "unknown", "archived", "all"] as const).map((value) => (
          <Button key={value} size="sm" variant={time === value ? "default" : "outline"}
            aria-pressed={time === value} onClick={() => setTime(value)}>
            {value === "all" ? "全部" : OPPORTUNITY_TIME_LABELS[value]}（{value === "all" ? matching.length : matching.filter((o) => opportunityTimeState(o, today) === value).length}）
          </Button>
        ))}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">“有效”仅表示未到已知截止日期，不代表来源或参与资格已核验；无有效日期的机会请在“待核实日期”查看。</p>

      {filtered.length === 0 ? (
        <EmptyState title="没有匹配的机会" hint="可切换时效分类或调整搜索条件；历史记录没有被删除。" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((o) => (
            <Link key={o.id} to={`/app/radar/${o.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-center gap-2">
                    <CategoryBadge value={o.type as NoticeCategory} />
                    <Badge variant="outline">{OPPORTUNITY_TIME_LABELS[opportunityTimeState(o, today)]}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">{o.sourceType}</span>
                  </div>
                  <p className="font-medium leading-snug">{o.title}</p>
                  <p className="text-xs text-muted-foreground">{o.organizer}</p>
                  <DeadlineTag deadline={o.deadline} />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
