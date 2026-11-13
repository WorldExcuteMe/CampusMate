import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { repository, isDemo, llmProvider } from "@/app/config";
import { resetDemo } from "@/lib/data/demo";
import { PageHeader } from "@/components/shared";
import { ProviderSettings } from "./ProviderSettings";

export function SettingsPage() {
  const { data: runs = [] } = useQuery({ queryKey: ["runs"], queryFn: () => repository.listAgentRuns() });

  async function exportData() {
    const payload = {
      profile: await repository.getProfile(),
      inbox: await repository.listInbox(),
      tasks: await repository.listTasks(),
      opportunities: await repository.listOpportunities(),
      reports: await repository.listReports(),
      agentRuns: await repository.listAgentRuns(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "campusmate-data.json";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("已导出当前数据");
  }

  function reset() {
    resetDemo();
    toast.success("演示数据已重置，刷新后生效");
    setTimeout(() => window.location.reload(), 600);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="设置" description="运行模式、模型供应商、数据管理与隐私。" />

      <ProviderSettings />

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">运行模式</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p>数据层：<strong>{isDemo ? "Demo（本地演示数据）" : "Supabase（真实用户）"}</strong></p>
          <p>AI Provider：<strong>{llmProvider.name}</strong>（{llmProvider.mock ? "Mock，明确标识" : "真实模型"}）</p>
          <p className="text-xs text-muted-foreground">真实模式需配置 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY；模型密钥仅存于服务端 Edge Function。</p>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">Agent 执行记录（{runs.length}）</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
          {runs.slice(0, 5).map((r) => (
            <p key={r.id}>{r.taskType} · {r.status} · {r.provider}/{r.model} · {r.startedAt.slice(11, 19)}</p>
          ))}
          {runs.length === 0 && <p>暂无执行记录。</p>}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle className="text-base">数据管理</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={exportData}><Download className="size-4" />导出我的数据</Button>
          {isDemo && <Button variant="outline" onClick={reset}><RotateCcw className="size-4" />重置演示数据</Button>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4" />隐私说明</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>聊天记录与简历属敏感个人材料。真实模式下数据按用户隔离（RLS），上传文件存私有 Storage，删除账户将级联清除数据与文件。演示模式不采集任何真实个人数据。</p>
        </CardContent>
      </Card>
    </div>
  );
}