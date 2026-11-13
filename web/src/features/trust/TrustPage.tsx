import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { repository } from "@/app/config";
import { EmptyState, PageHeader, VerifyBadge } from "@/components/shared";

export function TrustPage() {
  const { data: reports = [] } = useQuery({
    queryKey: ["reports"],
    queryFn: () => repository.listReports(),
  });
  const { data: opps = [] } = useQuery({
    queryKey: ["opps"],
    queryFn: () => repository.listOpportunities(),
  });
  const titleOf = (id: string) => opps.find((o) => o.id === id)?.title ?? id;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Trust Engine" description="每条核验结论都有证据支持；无法核验 ≠ 诈骗。" />
      {reports.length === 0 ? (
        <EmptyState title="暂无核验报告" />
      ) : (
        <div className="flex flex-col gap-3">
          {reports.map((r) => (
            <Link key={r.id} to={`/app/trust/${r.id}`}>
              <Card className="transition-shadow hover:shadow-md">
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-center gap-2">
                    <VerifyBadge value={r.status} />
                    <span className="font-medium">{titleOf(r.opportunityId)}</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{r.summary}</p>
                  <p className="text-xs text-muted-foreground">{r.evidence.length} 条证据</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}