import type { ChatMessage, Task } from "./types.ts";
import type { StoredSessionMessage, AppendSessionMessage } from "./storage-contracts.ts";
import { contentText } from "./context.ts";

export class LeaseLostError extends Error {}
export function assertTurnLease(task: Task | null | undefined, fence: { userId: string; workerId: string; attempt: number; now: number }): asserts task is Task {
  if (!task || task.userId !== fence.userId || task.status !== "running" || task.lease.owner !== fence.workerId || task.attempt !== fence.attempt || (task.lease.expiresAt ?? 0) <= fence.now) throw new LeaseLostError("Task lease is no longer owned by this worker");
}

// Only complete native tool groups may become immutable conversation history.
export function completeTranscript(transcript: ChatMessage[]): ChatMessage[] {
  const complete: ChatMessage[] = [];
  for (let index = 0; index < transcript.length;) {
    const message = transcript[index];
    if (message.role === "assistant" && transcript[index + 1]?.role === "user" && /__approval_pending__|__budget_pending__/.test(JSON.stringify(transcript[index + 1].content))) break;
    if (message.role === "assistant" && message.tool_calls?.length) {
      const group = [message];
      let next = index + 1;
      while (transcript[next]?.role === "tool") group.push(transcript[next++]);
      if (message.tool_calls.some((call) => !group.some((m) => m.role === "tool" && m.tool_call_id === call.id)) || group.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("__approval_pending__"))) break;
      complete.push(...group); index = next;
    } else { complete.push(message); index++; }
  }
  return complete;
}

export function turnMessages(task: Task, transcript: ChatMessage[]): AppendSessionMessage[] {
  return completeTranscript(transcript).map((message, index) => ({ ...message, userId: task.userId, sessionId: task.sessionId!, taskId: task.id, turnId: task.turnId ?? task.id, messageKey: `${task.turnId ?? task.id}:transcript:${index}` }));
}

export function sessionHistory(rows: StoredSessionMessage[], tasks: Task[], current: Task): ChatMessage[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return rows.filter((m) => m.role !== "system" && m.taskId !== current.id && (current.turnSeq === undefined || !m.taskId || (byId.get(m.taskId)?.turnSeq ?? 0) < current.turnSeq))
    .sort((a, b) => ((byId.get(a.taskId ?? "")?.turnSeq ?? 0) - (byId.get(b.taskId ?? "")?.turnSeq ?? 0)) || a.seq - b.seq)
    .map(({ role, content, tool_calls, tool_call_id }) => ({ role, content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}) }));
}

// Preserve direct user statements, with provenance and correction order; never infer a profile.
export function identityContext(rows: StoredSessionMessage[], tasks: Task[], current: Task): string {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const facts = rows.filter((m) => m.role === "user" && m.taskId !== current.id && (current.turnSeq === undefined || (byId.get(m.taskId ?? "")?.turnSeq ?? 0) < current.turnSeq))
    .sort((a, b) => (byId.get(a.taskId ?? "")?.turnSeq ?? 0) - (byId.get(b.taskId ?? "")?.turnSeq ?? 0) || a.seq - b.seq)
    .flatMap((m) => contentText(m.content).split(/(?<=[。！？\n])/).filter((line) => /我(?:是|的|叫|现在|目前)|专业|年级|学校|更正|改为|擅长|预算|约束|要求/.test(line)).map((line) => `[seq=${m.seq}] ${line}`));
  if (!facts.length) return "";
  if (facts.join("\n").length > 16000) throw new Error("身份与约束超出保留预算，请开启新会话并确认当前资料");
  return `【用户直接陈述，按会话顺序；最新明确纠正优先于旧画像和摘要】\n${facts.join("\n")}`;
}

export function committedPrefix(rows: StoredSessionMessage[], tasks: Task[]): number {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let through = 0;
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    if (row.taskId && !byId.get(row.taskId)?.transcriptCommitted) break;
    through = row.seq;
  }
  return through;
}
