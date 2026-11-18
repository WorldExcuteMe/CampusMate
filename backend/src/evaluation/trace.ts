// Trace 采集与归一化：把「脚本循环 hooks / 事件日志 / 工具包装器」统一成可评测的执行轨迹。
// 事实来源：runtime 的 append-only 事件（llm.request/response、tool.called/result、eval.*）+
// 工具包装器记录的参数（事件 payload 刻意不含参数，避免敏感信息进日志）。
import type { TraceLlmRound, TraceStep, TraceToolCall, TargetKind, EvalTrace } from "./types.ts";
import { toolResultFailed } from "../core/tool-result.ts";

export interface TraceCollector {
  events: EvalTrace["events"];
  tools: TraceToolCall[];
  llmRounds: TraceLlmRound[];
  models: string[];
  telemetry: unknown[];
  addEvent(type: string, payload: Record<string, unknown>, at?: number): void;
  addTool(call: Omit<TraceToolCall, "seq">): void;
  addLlmRound(round: TraceLlmRound): void;
  addModel(model: string | undefined | null): void;
  addTelemetry(telemetry: unknown): void;
  build(input: {
    startedAt: number;
    finishedAt: number;
    finalStatus: string;
    finalOutput: string;
    checkpointMessageCount?: number;
    certificate?: EvalTrace["certificate"];
    error?: string;
  }): EvalTrace;
}

export function createTraceCollector(caseId: string, target: TargetKind): TraceCollector {
  const events: EvalTrace["events"] = [];
  const tools: TraceToolCall[] = [];
  const llmRounds: TraceLlmRound[] = [];
  const models: string[] = [];
  const telemetry: unknown[] = [];
  let seq = 0;
  return {
    events, tools, llmRounds, models, telemetry,
    addEvent(type, payload, at = Date.now()) {
      events.push({ seq: ++seq, type, payload, at });
    },
    addTool(call) {
      tools.push({ seq: tools.length + 1, ...call });
    },
    addLlmRound(round) {
      llmRounds.push(round);
      if (round.telemetry !== undefined) telemetry.push(round.telemetry);
    },
    addModel(model) {
      if (model && !models.includes(model)) models.push(model);
    },
    addTelemetry(value) {
      if (value !== undefined) telemetry.push(value);
    },
    build(input) {
      return {
        caseId, target,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        events,
        llm: { requests: llmRounds.length, rounds: llmRounds, models, telemetry },
        tools,
        steps: deriveSteps(tools),
        ...(input.checkpointMessageCount !== undefined ? { checkpointMessageCount: input.checkpointMessageCount } : {}),
        finalStatus: input.finalStatus,
        finalOutput: input.finalOutput,
        ...(input.certificate ? { certificate: input.certificate } : {}),
        ...(input.error ? { error: input.error } : {}),
      };
    },
  };
}

// 从工具调用序列推导步骤（不伪造模型思维过程，只表示可观测动作）。
export function deriveSteps(tools: TraceToolCall[]): TraceStep[] {
  if (!tools.length) return [{ kind: "summarize", title: "直接答复" }];
  const steps: TraceStep[] = [{ kind: "plan", title: `调用 ${tools[0].name} 开始执行` }];
  for (const tool of tools) steps.push({ kind: "act", title: tool.name, detail: okLabel(tool) });
  steps.push({ kind: "summarize", title: "汇总答复" });
  return steps;
}

function okLabel(tool: TraceToolCall): string {
  if (tool.approvalPending) return "等待审批，未执行";
  return tool.ok ? "成功" : "失败/错误观测";
}

export function traceToolSequence(trace: Pick<EvalTrace, "tools">): string[] {
  return trace.tools.map((tool) => tool.approvalPending ? `${tool.name}(approval)` : tool.ok ? tool.name : `${tool.name}(error)`);
}

export function observedTokenTotal(telemetry: unknown[]): number {
  return telemetry.reduce<number>((sum, item) => {
    const usage = (item as { usage?: { inputTotal?: unknown; output?: unknown } } | undefined)?.usage;
    const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    return sum + count(usage?.inputTotal) + count(usage?.output);
  }, 0);
}

export function previewToolResult(raw: string, max = 4000): string {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  return text.length > max ? text.slice(0, max) + `…(+${text.length - max} chars)` : text;
}

export function isToolResultOk(raw: string): boolean {
  return !toolResultFailed(raw);
}

// 面向工作 Agent 的紧凑轨迹摘要（≤约 12 行），完整 trace 落盘。
export function traceDigest(trace: EvalTrace, maxTools = 12): string {
  const lines: string[] = [];
  lines.push(`tools(${trace.tools.length}): ${traceToolSequence(trace).slice(0, maxTools).join(" → ") || "无"}${trace.tools.length > maxTools ? " → …" : ""}`);
  const rounds = trace.llm.rounds.map((r) => `${r.round}${r.stage ? `:${r.stage}` : ""}${r.toolCalls ? `→${r.toolCalls}call` : ""}`);
  lines.push(`llm: ${rounds.slice(0, maxTools).join(" , ") || "无记录"} | model=${trace.llm.models.join(",") || "unknown"}`);
  if (trace.certificate) lines.push(`certificate: ${trace.certificate.passed ? "passed" : "failed"} (${trace.certificate.criteria.filter((c) => !c.passed).map((c) => c.id).slice(0, 6).join(",") || "无失败项"})`);
  if (trace.error) lines.push(`error: ${trace.error.slice(0, 200)}`);
  lines.push(`reply: ${trace.finalOutput.replace(/\s+/g, " ").slice(0, 240)}`);
  return lines.join("\n");
}
