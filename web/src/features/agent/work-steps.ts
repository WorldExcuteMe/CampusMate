import type { AgentEvent } from "@/lib/agent/api-client";

export const TOOL_LABELS: Record<string, string> = {
  web_search: "检索公开资料",
  web_fetch: "核对网页来源",
  read_artifact: "读取完整材料",
  save_opportunity: "保存机会",
  save_to_inbox: "保存通知到信息中心",
  propose_verification: "提交核验提案",
  document_create: "生成文档",
  document_export: "导出文件",
  document_inspect: "检查文档",
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;

export const formatDuration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}毫秒` : ms < 60000 ? `${(ms / 1000).toFixed(1)}秒` : `${Math.floor(ms / 60000)}分${Math.round(ms / 1000) % 60}秒`;

export interface WorkStep {
  key: number;
  name: string;
  label: string;
  ok: boolean | undefined;
  running: boolean;
  recovered: boolean;
  warning: boolean;
  summary: string;
  argsSummary: string;
  durationMs: number | undefined;
  sources: { url: string; host: string }[];
}

function sourceList(value: unknown): { url: string; host: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).flatMap((raw) => {
    try {
      const url = new URL(String(raw));
      return ["http:", "https:"].includes(url.protocol) ? [{ url: url.toString(), host: url.hostname }] : [];
    } catch { return []; }
  });
}

/** 把事件流压成"一步一次工具调用"的可读列表；进行中的步骤没有 result 事件。 */
export function deriveWorkSteps(events: AgentEvent[], taskStatus?: string): WorkStep[] {
  const active = taskStatus ? ["queued", "running"].includes(taskStatus) : false;
  const starts = events.filter((event) => event.type === "tool.called").slice(-16);
  return starts.map((start) => {
    const result = events.find((e) => e.seq > start.seq && e.type === "tool.result" && e.payload.callInstanceId === start.payload.callInstanceId);
    const recovered = events.some((e) => e.type === "tool.recovered" && e.payload.callInstanceId === start.payload.callInstanceId);
    const ok = typeof result?.payload.ok === "boolean" ? result.payload.ok : undefined;
    const running = !result && active;
    const name = String(start.payload.name ?? "tool");
    return {
      key: start.seq,
      name,
      label: toolLabel(name),
      ok,
      running,
      recovered,
      warning: Boolean(result?.payload.warning),
      summary: recovered
        ? "首次失败，已自动重试成功"
        : result
          ? String(result.payload.summary ?? (ok ? "完成" : "未完成"))
          : running ? "正在执行" : "已停止",
      argsSummary: typeof start.payload.argsSummary === "string" ? start.payload.argsSummary : "",
      durationMs: typeof result?.payload.durationMs === "number" ? result.payload.durationMs : undefined,
      sources: sourceList(result?.payload.sourceUrls),
    };
  });
}
