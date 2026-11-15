import type { ChatMessage, Task } from "../core/types.ts";

// Dialogue is a bounded projection of durable Task inputs/results. No second,
// append-only copy to duplicate on retries or lose in an independent MemoryStore.
export interface SessionHistoryQuery {
  userId: string;
  sessionId: string;
  beforeTaskId: string;
  maxTurns?: number;
}
export type SessionTurn = Pick<Task, "intent" | "status" | "result" | "error">;
export const MAX_SESSION_TURNS = 20;
export const MAX_SESSION_MESSAGE_CHARS = 6_000;
export const MAX_SESSION_HISTORY_CHARS = 48_000;
export function sessionTurnLimit(requested?: number): number {
  return Number.isFinite(requested) ? Math.max(1, Math.min(MAX_SESSION_TURNS, Math.floor(requested!))) : 12;
}
function clip(text: string): string {
  if (text.length <= MAX_SESSION_MESSAGE_CHARS) return text;
  return text.slice(0, 4_400) + "\n[历史消息已截断]\n" + text.slice(-1_500);
}

// Input order must be oldest to newest. Keep whole user/assistant pairs only.
export function sessionMessages(turns: SessionTurn[]): ChatMessage[] {
  const pairs: ChatMessage[][] = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!["succeeded", "failed", "cancelled"].includes(turn.status)) continue;
    const summary = turn.result?.summary || turn.error || "未保存最终答复。";
    const status = turn.status === "failed" ? "[历史任务失败，不代表操作已完成]\n"
      : turn.status === "cancelled" ? "[历史任务已取消，不代表操作已完成]\n" : "";
    const input = clip(turn.intent);
    const reply = status + clip(summary);
    if (size + input.length + reply.length > MAX_SESSION_HISTORY_CHARS) break;
    pairs.unshift([{ role: "user", content: input }, { role: "assistant", content: reply }]);
    size += input.length + reply.length;
  }
  return pairs.flat();
}
