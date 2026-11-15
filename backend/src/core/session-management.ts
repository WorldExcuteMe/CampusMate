import type { Task } from './types.ts';
import type { StoredSessionMessage } from './storage-contracts.ts';
import { contentText } from './context.ts';
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR } from '../../../shared/tool-protocol.ts';
export class SessionManagementError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
export interface SessionPatch { title?: string; mode?: 'auto' | 'daily'; archived?: boolean; expectedRevision: number; }
export interface LegacyMessage { role: 'user' | 'assistant'; content: string; failed?: boolean; mock?: boolean; editedFrom?: number; imported?: boolean; }
export function validateSessionPatch(patch: SessionPatch) {
  if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0) throw new SessionManagementError('会话版本无效', 400);
  if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 160)) throw new SessionManagementError('会话名称须为1至160个字符', 400);
  if (patch.mode !== undefined && !['auto', 'daily'].includes(patch.mode)) throw new SessionManagementError('会话模式无效', 400);
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw new SessionManagementError('归档状态无效', 400);
}
export function validateLegacyMessages(value: unknown): LegacyMessage[] {
  if (!Array.isArray(value) || value.length > 5000 || JSON.stringify(value).length > 2000000) throw new SessionManagementError('历史记录过大，请保留本地备份后分批导出', 400);
  return value.map(m => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new SessionManagementError('历史消息格式无效', 400);
    return { role: m.role, content: m.content, ...(m.failed === true ? { failed: true } : {}), ...(m.mock === true ? { mock: true } : {}), ...(Number.isSafeInteger(m.editedFrom) && m.editedFrom > 0 ? { editedFrom: m.editedFrom } : {}), imported: true };
  });
}
export const unfinishedSessionTask = (task: Pick<Task, 'status'>) => ['queued', 'running', 'paused', 'needs_input'].includes(task.status);

export function publicConversation(tasks: Task[], rows: StoredSessionMessage[], imported: LegacyMessage[]) {
  type Message = LegacyMessage & { taskId?: string; turnId?: string };
  const groups: { at: number; order: number; messages: Message[] }[] = rows.filter(m => !m.taskId && ['user', 'assistant'].includes(m.role) && !m.tool_calls?.length).map(m => ({ at: m.createdAt, order: m.seq, messages: [{ role: m.role as 'user' | 'assistant', content: m.role === 'assistant' && hasRawToolMarkup(contentText(m.content)) ? TOOL_PROTOCOL_ERROR : contentText(m.content), turnId: m.turnId }] }));
  for (const task of tasks) {
    const messages: Message[] = [{ role: 'user', content: task.intent, taskId: task.id, turnId: task.turnId ?? task.id }];
    if (!['queued', 'running'].includes(task.status)) {
      let content = task.result?.summary ?? task.error ?? (task.status === 'cancelled' ? '任务已取消，记录已保留。' : '任务尚未完成，请查看执行面板。');
      const malformed = hasRawToolMarkup(content); if (malformed) content = TOOL_PROTOCOL_ERROR;
      messages.push({ role: 'assistant', content, taskId: task.id, turnId: task.turnId ?? task.id, failed: task.status === 'failed' || malformed });
    }
    groups.push({ at: task.createdAt, order: task.turnSeq ?? 0, messages });
  }
  return [...imported.map(m => ({ ...m, imported: true })), ...groups.sort((a, b) => a.at - b.at || a.order - b.order).flatMap(g => g.messages)];
}
