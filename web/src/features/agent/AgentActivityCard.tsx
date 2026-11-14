import { useEffect, useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { progressText, type AgentActivity } from "@/lib/agent/progress";

export function AgentActivityCard({ activity }: { activity: AgentActivity }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - activity.startedAt) / 1_000));
  const stageElapsed = Math.max(0, Math.floor((now - activity.stageAt) / 1_000));
  const text = progressText(activity.progress);
  const slow = stageElapsed >= 20 && activity.progress.phase !== "approval";
  return (
    <div className="flex min-w-0 items-start gap-3" data-testid="agent-activity">
      <Bot aria-hidden="true" className="mt-2 size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" />
            {text.label}
          </span>
          <div role="status" aria-live="polite" aria-atomic="true" className="min-w-0 flex-1 basis-40">
            <p className="text-sm font-medium text-foreground">{text.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{text.detail}</p>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label="已等待时间">已等待 {elapsed} 秒</span>
        </div>
        {activity.progress.round && <p className="mt-2 text-xs text-muted-foreground">第 {activity.progress.round} 轮处理</p>}
        {slow && <p className="mt-2 text-xs leading-relaxed text-amber-500" role="note">本阶段已等待 {stageElapsed} 秒，暂未收到新结果，模型或工具服务可能响应较慢。</p>}
      </div>
    </div>
  );
}
