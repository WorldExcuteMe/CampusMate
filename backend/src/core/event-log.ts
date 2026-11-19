// 会话事件日志（Phase 1）：类型化、append-only、可重放的会话事实。
// 借鉴 DSH 的核心设计：模型可见历史不再是"直接拼接的 transcript"，而是事件日志的纯投影（deriveMessages）。
// 这样 resume 等价于重放、崩溃修复等价于追加关闭事件、审计/调试拿到的是一等事实。
// 本模块先独立于现有 agent-loop 交付：下一步把 loop 切换为"事件权威 + 投影"（保留 transcript 兼容层）。
import type { ChatMessage, ToolCall } from "./types.ts";

export type TurnEndReason = "completed" | "budget" | "cancelled" | "approval" | "error" | "interrupted";

export type SessionEvent =
  | { type: "turn/start"; turnId: string; user: string; at: number }
  | { type: "step/start"; turnId: string; step: number; at: number }
  | { type: "user/message"; content: string; at: number }
  | { type: "assistant/message"; content: string; toolCalls?: ToolCall[]; at: number }
  | { type: "tool/call"; callId: string; name: string; args: Record<string, unknown>; at: number }
  | { type: "tool/result"; callId: string; content: string; ok: boolean; at: number }
  | { type: "system/notice"; content: string; kind?: string; at: number }
  | { type: "checkpoint"; state: Record<string, unknown>; at: number }
  | { type: "turn/end"; turnId: string; reason: TurnEndReason; at: number };

export interface SessionLog {
  append(event: SessionEvent): Promise<void>;
  events(): readonly SessionEvent[];
}

export class InMemorySessionLog implements SessionLog {
  private readonly buffer: SessionEvent[] = [];
  async append(event: SessionEvent): Promise<void> { this.buffer.push(structuredClone(event)); }
  events(): readonly SessionEvent[] { return this.buffer; }
}

// 纯投影：只保留模型可见消息；tool/call 只作为配对依据，tool/result 变成 role=tool。
// 配对不完整的日志不应直接喂给模型（见 repairEvents），否则会产生孤儿 tool 消息。
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    if (event.type === "user/message") messages.push({ role: "user", content: event.content });
    else if (event.type === "assistant/message") messages.push({ role: "assistant", content: event.content, ...(event.toolCalls?.length ? { tool_calls: structuredClone(event.toolCalls) } : {}) });
    else if (event.type === "tool/result") messages.push({ role: "tool", content: event.content, tool_call_id: event.callId });
    else if (event.type === "system/notice") messages.push({ role: "system", content: event.content });
  }
  return messages;
}

export interface ReplayState {
  messages: ChatMessage[];
  openTurn: boolean;
  openTurnId: string | null;
  pendingCalls: Array<{ callId: string; name: string }>;
  lastCheckpoint: Record<string, unknown> | null;
  lastStep: number;
}

export function replay(events: readonly SessionEvent[]): ReplayState {
  const byId = new Map<string, string>();
  const state: ReplayState = { messages: [], openTurn: false, openTurnId: null, pendingCalls: [], lastCheckpoint: null, lastStep: 0 };
  for (const event of events) {
    switch (event.type) {
      case "turn/start": state.openTurn = true; state.openTurnId = event.turnId; break;
      case "turn/end": state.openTurn = false; state.openTurnId = null; state.pendingCalls = []; break;
      case "step/start": state.lastStep = Math.max(state.lastStep, event.step); break;
      case "tool/call": state.pendingCalls.push({ callId: event.callId, name: event.name }); byId.set(event.callId, event.name); break;
      case "tool/result": state.pendingCalls = state.pendingCalls.filter((call) => call.callId !== event.callId); break;
      case "checkpoint": state.lastCheckpoint = event.state; break;
      default: break;
    }
    void byId;
  }
  state.messages = deriveMessages(events);
  return state;
}

// 崩溃/中断修复：为未完成的工具调用补上结构化错误结果，并为未关闭的 turn 追加 interrupted 结束事件。
// 返回"需要追加到日志尾部"的事件（幂等：已完整的日志返回空数组）。
export function repairEvents(events: readonly SessionEvent[], now: () => number = Date.now): SessionEvent[] {
  const closedCalls = new Set(events.filter((event) => event.type === "tool/result").map((event) => (event as Extract<SessionEvent, { type: "tool/result" }>).callId));
  const pending = events.filter((event): event is Extract<SessionEvent, { type: "tool/call" }> => event.type === "tool/call" && !closedCalls.has(event.callId));
  const lastTurn = [...events].reverse().find((event) => event.type === "turn/start" || event.type === "turn/end");
  const suffix: SessionEvent[] = pending.map((call) => ({
    type: "tool/result" as const,
    callId: call.callId,
    content: JSON.stringify({ error: "会话中断：工具调用没有返回结果（已由恢复流程补齐）", class: "interrupted" }),
    ok: false,
    at: now(),
  }));
  if (lastTurn?.type === "turn/start") {
    const alreadyEnded = events.some((event) => event.type === "turn/end" && event.turnId === lastTurn.turnId);
    if (!alreadyEnded) suffix.push({ type: "turn/end", turnId: lastTurn.turnId, reason: "interrupted", at: now() });
  }
  return suffix;
}

export function newTurnId(now: () => number = Date.now): string { return `turn-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

export async function appendEvents(log: SessionLog, events: readonly SessionEvent[]): Promise<number> {
  for (const event of events) await log.append(event);
  return events.length;
}
// 持久化适配器（Phase 2a）：把会话事件写入任务事件流（type = "session.event"），
// 新 turn/resume 时从事件流重建连续日志。存储接口保持最小化，避免 core/event-log 依赖 runtime 实现。
export interface SessionEventStore {
  appendEvent(input: { taskId: string; userId: string; type: "session.event"; payload: { event: SessionEvent } }): Promise<unknown>;
  listEvents(taskId: string): Promise<Array<{ type: string; payload: Record<string, unknown> }>>;
}

export class StoreSessionLog implements SessionLog {
  private readonly buffer: SessionEvent[];
  private readonly deps: { taskId: string; userId: string; store: SessionEventStore; sanitize?: (event: SessionEvent) => SessionEvent };
  constructor(deps: { taskId: string; userId: string; store: SessionEventStore; initial?: SessionEvent[]; sanitize?: (event: SessionEvent) => SessionEvent }) {
    this.deps = { taskId: deps.taskId, userId: deps.userId, store: deps.store, sanitize: deps.sanitize };
    this.buffer = [...(deps.initial ?? [])];
  }
  static async load(store: SessionEventStore, taskId: string, userId: string, sanitize?: (event: SessionEvent) => SessionEvent): Promise<StoreSessionLog> {
    const rows = await store.listEvents(taskId);
    const initial = rows
      .filter((row) => row.type === "session.event")
      .map((row) => (row.payload as { event?: SessionEvent }).event)
      .filter((event): event is SessionEvent => Boolean(event && typeof (event as { type?: unknown }).type === "string"));
    return new StoreSessionLog({ taskId, userId, store, initial, sanitize });
  }
  async append(event: SessionEvent): Promise<void> {
    const persisted = this.deps.sanitize ? this.deps.sanitize(structuredClone(event)) : structuredClone(event);
    await this.deps.store.appendEvent({ taskId: this.deps.taskId, userId: this.deps.userId, type: "session.event", payload: { event: persisted } });
    this.buffer.push(structuredClone(event));
  }
  events(): readonly SessionEvent[] { return this.buffer; }
}

