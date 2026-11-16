import type { AgentEvent, AgentTask } from "./api-client";
import type { ChatSession, SessionMsg } from "./sessions";
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR } from '../../../../shared/tool-protocol';
export const stoppedTask = (status: string) => ["paused", "needs_input", "succeeded", "failed", "cancelled"].includes(status);
export function taskReason(task: AgentTask, events: AgentEvent[]): string {
  const last = [...events].reverse().find((event) => event.type === "task.needs_input");
  return task.result?.completion?.reason ?? String(last?.payload.reason ?? "");
}
export function taskReply(task: AgentTask, events: AgentEvent[]): string {
  const reason = taskReason(task, events);
  const labels: Record<string, string> = { approval_pending: "任务等待你的审批，请在执行面板处理。", budget_exceeded: "预算已用完，请调整预算后继续。", output_incomplete: "输出尚未完成，已保留草稿，可以继续。", persistence_failed: "任务记录暂未保存，请恢复重试或取消。", execution_interrupted: "执行中断，记录已保留，可恢复或取消。", missing_information: "需要补充材料，请根据任务说明用新消息继续。" };
  if (task.status === "cancelled") return "任务已取消，执行记录已保留。";
  if ((task.status === "paused" || task.status === "needs_input") && labels[reason]) return labels[reason] + (task.result?.summary ? "\n\n" + task.result.summary : "");
  return task.result?.summary ?? task.error ?? (task.status === "succeeded" ? "任务已完成。" : "任务等待处理，请查看执行说明。");
}
function bounded(records: NonNullable<ChatSession["taskViews"]>) {
  return Object.fromEntries(Object.entries(records).sort(([, a], [, b]) => (b.task.turnSeq ?? 0) - (a.task.turnSeq ?? 0) || (b.task.createdAt ?? 0) - (a.task.createdAt ?? 0)).slice(0, 40));
}
export function mergeTask(session: ChatSession, incoming: AgentTask): ChatSession {
  if (hasRawToolMarkup(incoming.result?.summary ?? '')) incoming = { ...incoming, status: 'failed', error: TOOL_PROTOCOL_ERROR, result: { ...incoming.result!, summary: TOOL_PROTOCOL_ERROR, partial: true, completion: { state: 'partial', reason: 'tool_protocol_error' } } };
  const previous = session.taskViews?.[incoming.id];
  if (previous?.task.historyRevision && incoming.historyRevision && BigInt(incoming.historyRevision)<BigInt(previous.task.historyRevision)) return session;
  const combined = { ...previous?.task, ...incoming };
  const keys = ["id", "userId", "title", "sessionId", "turnId", "turnSeq", "status", "usage", "budget", "result", "error", "promptUsage", "modelConfig", "modelRuntime", "cancelRequested", "createdAt", "updatedAt", "historyRevision"] as const;
  const task = Object.fromEntries(keys.filter((key) => combined[key] !== undefined).map((key) => [key, combined[key]])) as unknown as AgentTask;
  const events = previous?.events ?? [];
  const taskViews = bounded({ ...session.taskViews, [task.id]: { ...previous, task, events, lastSeq: previous?.lastSeq ?? 0 } });
  let next: ChatSession = { ...session, taskViews, currentTaskId: session.currentTaskId ?? task.id };
  if (next.currentTaskId === task.id) next = { ...next, contextUsed: task.promptUsage?.inputTokens ?? next.contextUsed, contextCap: task.promptUsage?.contextLimit ?? undefined, promptSource: task.promptUsage?.source ?? "unknown", actualModel: task.modelRuntime?.actualModel ?? next.actualModel, configuredModel: task.modelConfig?.modelId ?? next.configuredModel };
  if (!stoppedTask(task.status)) return next;
  const reply: SessionMsg = { role: "assistant", content: taskReply(task, events), taskId: task.id, turnId: task.turnId, failed: task.status === "failed" };
  const messages = [...session.messages];
  const index = messages.findIndex((m) => m.role === "assistant" && m.taskId === task.id);
  const user = task.turnId ? messages.findIndex((m) => m.role === "user" && m.turnId === task.turnId) : -1;
  // The task monitor can see more tasks than the loaded history page. Cache
  // their execution state, but never append orphan replies or recount usage.
  if (session.historyPage && index<0 && user<0) return { ...next,taskTokenUsage:{...session.taskTokenUsage,[task.id]:task.usage?.tokens??0} };
  if (index >= 0) messages[index] = { ...messages[index], ...reply };
  else if (user >= 0) messages.splice(user + 1, 0, { ...reply, ...(messages[user].historyKey ? { historyKey: messages[user].historyKey, historyOrder: messages[user].historyOrder, historyVersion: messages[user].historyVersion } : {}) });
  else messages.push(reply);
  const total = task.usage?.tokens ?? 0;
  const baseline = session.taskTokenUsage?.[task.id] ?? (index >= 0 ? total : 0);
  next = { ...next, messages, tokens: session.tokens + Math.max(0, total - baseline), taskTokenUsage: { ...session.taskTokenUsage, [task.id]: Math.max(total, baseline) }, pendingTurn: session.pendingTurn?.taskId === task.id || session.pendingTurn?.turnId === task.turnId ? undefined : session.pendingTurn };
  return next;
}
export function mergeEvent(session: ChatSession, event: AgentEvent): ChatSession {
  const previous = session.taskViews?.[event.taskId];
  if (!previous || event.seq <= previous.lastSeq) return session;
  let draft = previous.draft ?? "";
  if (event.type === "llm.request") draft = "";
  if (event.type === "llm.delta" && typeof event.payload.text === "string") draft = (draft + event.payload.text).slice(-12000);
  if (event.type === "llm.response" && Number(event.payload.toolCalls) > 0) draft = "";
  const events = event.type === "llm.delta" ? previous.events : [...previous.events, event].slice(-300);
  const next = { ...session, taskViews: { ...session.taskViews, [event.taskId]: { ...previous, events, draft, lastSeq: event.seq } } };
  return stoppedTask(previous.task.status) && event.type === "task.needs_input" ? mergeTask(next, previous.task) : next;
}
