import { useState } from "react";
import { Gauge, Coins, Pencil, Check, RotateCcw } from "lucide-react";

export interface ContextUsageProps {
  /** 最近一次请求的窗口输入 token（估算或后端上报） */
  used: number | null | undefined;
  /** 模型上下文上限 */
  cap: number | null | undefined;
  /** 本任务累计 tokens */
  tokens?: number;
  /** 最近一次请求的 usage（来自后端 modelRuntime.lastRequest） */
  lastRequest?: {
    usage?: { cacheRead?: number | null; inputTotal?: number | null; output?: number | null; reasoning?: number | null; costUsd?: number | null };
  };
  compressed?: boolean;
  pruned?: boolean;
  model?: string;
  /** 最近一次请求首 token 延迟（毫秒） */
  ttftMs?: number | null;
  /** 当前任务轮次与工具步数（来自事件流） */
  turns?: number;
  steps?: number;
  /** 是否允许在当前页面实时修改上下文上限 */
  capEditable?: boolean;
  /** 传 null 表示恢复模型默认上限 */
  onCapChange?: (value: number | null) => void;
}

function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/**
 * 上下文/用量紧凑指示器：图标 + 占用百分比 + 已用/上限，附带缓存命中与累计 token。
 * 上限可在原地修改（仅影响本会话的预算显示与前端裁剪），支持恢复模型默认。
 */
export function ContextUsage({ used, cap, tokens, lastRequest, compressed, pruned, model, ttftMs, turns, steps, capEditable, onCapChange }: ContextUsageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const pct = used != null && cap ? Math.max(0, Math.min(100, Math.round((used / cap) * 100))) : null;
  const request = lastRequest?.usage;
  const cacheHit = request?.cacheRead != null && request?.inputTotal ? Math.round((request.cacheRead / request.inputTotal) * 100) : null;
  const title = [
    `上下文占用：${used == null ? "未知" : `${used.toLocaleString()} tok`} / ${cap == null ? "上限未知" : `${cap.toLocaleString()} tok`}`,
    `模型 ${model ?? "未知"} 上限 ${cap?.toLocaleString() ?? "未知"} tok`,
    `累计用量 ${(tokens ?? 0).toLocaleString()} tok`,
    cacheHit == null ? "缓存命中：暂无（首次请求或未上报）" : `缓存命中：${cacheHit}%（${request?.cacheRead?.toLocaleString()} / ${request?.inputTotal?.toLocaleString()} tok）`,
    request ? `最近请求：输入 ${request.inputTotal ?? "?"} tok · 输出 ${request.output ?? "?"} tok · 思考 ${request.reasoning ?? 0} tok${request.costUsd != null ? ` · 成本 $${request.costUsd.toFixed(6)}` : ""}` : "",
    compressed ? "历史已压缩" : "",
    pruned ? "较旧工具结果已截断" : "",
  ].filter(Boolean).join("\n");

  const startEdit = () => { setDraft(cap ? String(cap) : ""); setEditing(true); };
  const commit = () => {
    const value = Number(draft);
    if (!Number.isFinite(value) || value < 8_000 || value > 2_000_000) { setEditing(false); return; }
    onCapChange?.(Math.round(value));
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 px-2 py-1 text-[11px] leading-none text-muted-foreground">
        <Gauge aria-hidden="true" className="size-3.5 shrink-0 text-primary/80" />
        <input
          autoFocus
          aria-label="上下文上限（tokens）"
          type="number"
          min={8_000}
          max={2_000_000}
          step={1_000}
          className="w-24 rounded border border-border bg-background px-1 py-0.5 text-[11px] tabular-nums"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            if (event.key === "Escape") setEditing(false);
          }}
        />
        <span className="text-[10px]">tok</span>
        <button type="button" aria-label="保存上下文上限" title="保存（8K–2M）" onClick={commit}><Check className="size-3" /></button>
        <button type="button" aria-label="恢复模型默认上限" title="恢复自动" onClick={() => { onCapChange?.(null); setEditing(false); }}><RotateCcw className="size-3" /></button>
      </span>
    );
  }

  return (
    <span
      aria-label="上下文占用"
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 px-2 py-1 text-[11px] leading-none text-muted-foreground"
    >
      <Gauge aria-hidden="true" className="size-3.5 shrink-0 text-primary/80" />
      <span className="tabular-nums font-medium text-foreground/80">{pct == null ? "窗口未知" : `${pct}%`}</span>
      <span className="tabular-nums text-muted-foreground">
        {formatTokens(used)}/{formatTokens(cap)}
      </span>
      {capEditable && onCapChange && (
        <button type="button" aria-label="修改上下文上限" title="修改本会话上下文上限" onClick={startEdit} className="text-muted-foreground hover:text-foreground">
          <Pencil className="size-3" />
        </button>
      )}
      <span aria-hidden="true" className="text-border">·</span>
      <span className="tabular-nums" title="本任务累计 tokens">
        <Coins aria-hidden="true" className="mr-0.5 inline size-3" />
        {formatTokens(tokens)} tok
      </span>
      {cacheHit != null && <span className="tabular-nums" title="最近请求缓存命中率">缓存 {cacheHit}%</span>}
      {(turns != null || steps != null) && <span className="tabular-nums" title="当前任务轮次与工具步数">{turns ?? 0} 轮 {steps ?? 0} 步</span>}
      {ttftMs != null && <span className="tabular-nums" title="最近一次请求的首 token 延迟">首 token {(ttftMs / 1000).toFixed(2)}s</span>}
      {compressed && <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-600">已压缩</span>}
      {pruned && !compressed && <span className="rounded bg-info/15 px-1 py-0.5 text-info">工具截断</span>}
      <span className="sr-only" title={title}>窗口输入 {used ?? "未知"} / {cap?.toLocaleString() ?? "上限未知"} tok</span>
    </span>
  );
}