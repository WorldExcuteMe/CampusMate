import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { repository } from "@/app/config";
import { CategoryBadge, DeadlineTag, EmptyState, PageHeader } from "@/components/shared";
import type { NoticeCategory } from "@/lib/schemas";

export function RadarPage() {
  const { data: opps = [] } = useQuery({
    queryKey: ["opps"],
    queryFn: () => repository.listOpportunities(),
  });
  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("all");

  const filtered = useMemo(
    () =>
      opps.filter(
        (o) =>
          (type === "all" || o.type === type) &&
          (q === "" || o.title.includes(q) || o.organizer.includes(q)),
      ),
    [opps, q, type],
  );

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Opportunity Radar" description="来自官方白名单来源的机会，含竞赛、实习、科研等。" />
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

      {filtered.length === 0 ? (
        <EmptyState title="没有匹配的机会" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((o) => (
            <Link key={o.id} to={`/app/radar/${o.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-center gap-2">
                    <CategoryBadge value={o.type as NoticeCategory} />
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