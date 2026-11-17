// 多轮聚合：把每轮独立观测合并成会话级 Observation，同时保留每轮 trace 便于定位。
// 人类在聊天框连续输入时，每轮是一个 Task（不同 taskId、同一 session）；这里采用相同语义。
import type {
  BusinessSnapshot, EvalCase, EvalObservation, EvalTrace, EvalTurnObservation, TargetKind, TraceToolCall,
} from "../types.ts";
import type { Usage } from "../../core/types.ts";
import { deriveSteps } from "../trace.ts";

export function emptyBusiness(): BusinessSnapshot {
  return { inbox: [], opportunities: [], pendingApprovals: 0, artifacts: [], evidenceVerified: 0 };
}

export function sumUsage(items: Array<Usage | undefined>): Usage {
  const total: Usage = { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 };
  for (const item of items) {
    if (!item) continue;
    total.tokens += item.tokens ?? 0;
    total.toolCalls += item.toolCalls ?? 0;
    total.wallMs += item.wallMs ?? 0;
    total.costUsd += item.costUsd ?? 0;
  }
  return total;
}

export function renumberTools(turns: EvalTurnObservation[]): TraceToolCall[] {
  const merged: TraceToolCall[] = [];
  for (const turn of turns) for (const call of turn.toolCalls) merged.push({ ...call, seq: merged.length + 1 });
  return merged;
}

// 合并每轮 trace：事件带 turn 标记，llm rounds 带 turn 标记，tools 全局重编号。
export function mergeTurnTraces(caseId: string, target: TargetKind, turns: EvalTurnObservation[], opts: {
  startedAt: number; finishedAt: number; session?: { id: string; messageCount?: number };
}): EvalTrace {
  const events = turns.flatMap((turn, index) => turn.trace.events.map((event) => ({ ...event, turn: index + 1 })))
    .map((event, index) => ({ ...event, seq: index + 1 }));
  const rounds = turns.flatMap((turn, index) => turn.trace.llm.rounds.map((round) => ({ ...round, turn: index + 1 })));
  const models = [...new Set(turns.flatMap((turn) => turn.trace.llm.models))];
  const tools = renumberTools(turns);
  const last = turns[turns.length - 1];
  return {
    caseId, target,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    events,
    llm: { requests: rounds.length, rounds, models, telemetry: turns.flatMap((turn) => turn.trace.llm.telemetry) },
    tools,
    steps: deriveSteps(tools),
    ...(opts.session ? { session: opts.session } : {}),
    turns: turns.map((turn) => turn.trace),
    finalStatus: last?.status ?? "error",
    finalOutput: last?.reply ?? "",
    ...(turns.find((turn) => turn.error)?.error ? { error: turns.find((turn) => turn.error)!.error! } : {}),
    certificate: last?.trace.certificate,
  };
}

export function mergeTurnObservations(c: EvalCase, target: TargetKind, turns: EvalTurnObservation[], opts: {
  startedAt: number; finishedAt: number; session?: { id: string; messageCount?: number };
}): EvalObservation {
  const last = turns[turns.length - 1];
  const status = last?.status ?? "error";
  const reply = last?.reply ?? "";
  const trace = mergeTurnTraces(c.id, target, turns, opts);
  return {
    case: c, target, status, reply,
    toolCalls: trace.tools, trace,
    // 会话级业务事实取最后一轮（存储是累积的，最后一轮即最终状态）。
    business: last?.business ?? emptyBusiness(),
    usage: sumUsage(turns.map((turn) => turn.usage)),
    durationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
    mock: turns.some((turn) => turn.mock),
    ...(trace.error ? { error: trace.error } : {}),
    turns,
  };
}

export function sessionTrace(trace: EvalTrace, session: { id: string; messageCount?: number }): EvalTrace {
  return { ...trace, session };
}
