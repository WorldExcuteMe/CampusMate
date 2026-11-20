import { CheckCircle2, ChevronRight, Clock3, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentEvent } from "@/lib/agent/api-client";
import { deriveWorkSteps, formatDuration } from "./work-steps";

/** 对话时间线里的过程摘要：默认一行，运行中自动展开，完成后可回看。 */
export function MessageWorkSteps({ events, status }: { events: AgentEvent[]; status?: string }) {
  const steps = deriveWorkSteps(events, status);
  const thinking = events.filter((event) => event.type === "thinking.summary").slice(-3);
  if (!steps.length && !thinking.length) return null;
  const running = steps.some((step) => step.running);
  const failed = steps.some((step) => step.ok === false && !step.running);
  const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const Icon = running ? Loader2 : failed ? XCircle : CheckCircle2;
  return (
    <details open={running} className="group/steps mt-2 w-full text-xs">
      <summary
        className={cn(
          "flex w-fit cursor-pointer select-none items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
          running && "text-foreground",
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", running && "animate-spin text-primary", failed && "text-destructive", !running && !failed && "text-success")} />
        <span>{steps.length ? (running ? `正在执行 · ${steps.length} 步` : `工作步骤 · ${steps.length} 步${total ? ` · ${formatDuration(total)}` : ""}`) : `思考摘要 · ${thinking.length} 段`}</span>
        <ChevronRight className="size-3 shrink-0 transition-transform group-open/steps:rotate-90" />
      </summary>
      {steps.length > 0 && <ol aria-label="工作步骤" className="mt-1.5 space-y-1 border-l border-border pl-3">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-2 py-0.5">
            {step.running ? (
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
            ) : step.recovered || step.warning ? (
              <Clock3 className="mt-0.5 size-3.5 shrink-0 text-warning" />
            ) : step.ok === false ? (
              <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
            )}
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-foreground">{step.label}</span>
                {step.durationMs !== undefined && <span className="text-[11px] tabular-nums text-muted-foreground">{formatDuration(step.durationMs)}</span>}
              </p>
              <p className="mt-0.5 leading-5 text-muted-foreground">{step.summary}</p>
              {step.argsSummary && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">参数 · {step.argsSummary}</p>}
              {step.sources.map(({ url, host }) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="mt-0.5 block truncate text-primary underline underline-offset-2">
                  来源 · {host}
                </a>
              ))}
            </div>
          </li>
        ))}
      </ol>}
      {thinking.length > 0 && <div className="mt-1.5 space-y-1 border-l border-border pl-3 text-muted-foreground"><p className="text-[11px]">思考摘要（自动截取，非完整推理）</p>{thinking.map((event) => <p key={event.seq} className="leading-5">{String(event.payload.excerpt ?? "已思考")}{event.payload.truncated ? "…" : ""}</p>)}</div>}
    </details>
  );
}
