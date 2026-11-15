import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRepository } from "@/app/auth";
import { PageHeader, VerifyBadge } from "@/components/shared";

const RESULT_LABEL: Record<string, string> = {
  pass: "通过",
  warn: "待补充",
  fail: "不通过",
  unknown: "未知",
};

export function TrustReportPage() {
  const repository = useRepository();
  const { id = "" } = useParams();
  const { data: report } = useQuery({ queryKey: ["report", id], queryFn: () => repository.getReport(id) });

  if (!report) return <p className="text-sm text-muted-foreground">未找到该报告。</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <Button variant="ghost" size="sm" asChild className="mb-3">
        <Link to="/app/trust"><ArrowLeft className="size-4" />返回核验列表</Link>
      </Button>
      <PageHeader title="可信度核验报告" actions={<VerifyBadge value={report.status} />} />

      <Card className="mb-4">
        <CardContent className="p-4"><p className="text-sm">{report.summary}</p></CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">核验项</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.findings.map((f, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{f.item}</TableCell>
                  <TableCell>{RESULT_LABEL[f.result] ?? f.result}</TableCell>
                  <TableCell className="text-muted-foreground">{f.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">证据（{report.evidence.length}）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {report.evidence.map((e, i) => (
            <div key={i} className="rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{e.sourceType}</span>
                <span>· 置信度 {Math.round(e.confidence * 100)}%</span>
                <span>· {e.retrievedAt.slice(0, 10)}</span>
              </div>
              <p className="mt-1 text-sm">「{e.excerpt}」</p>
              <p className="mt-1 text-xs text-muted-foreground">支持结论：{e.supports}</p>
              <a href={e.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="size-3" />{e.sourceUrl}
              </a>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}