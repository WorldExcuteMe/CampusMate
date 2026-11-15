import { req, type AgentTask } from './api-client';
import type { ChatSession, SessionMsg } from './sessions';
import { mergeTask } from './task-state';
export interface RemoteSession { id: string; title: string; mode: 'auto' | 'daily'; createdAt: number; updatedAt: number; archived?: boolean; deletedAt?: number | null; revision?: number; }
export interface RemoteHistory { session: RemoteSession; messages: SessionMsg[]; tasks: AgentTask[]; }
const ownerHeader = (owner?: string) => owner ? { 'X-Session-Owner': owner } : undefined;
export const listRemoteSessions = async (signal?: AbortSignal, owner?: string) => { const data = await req<{ sessions: RemoteSession[] }>('/v1/sessions', { signal, headers: ownerHeader(owner) }); if (!Array.isArray(data.sessions)) throw new Error('会话列表响应无效'); return data.sessions; };
export const createRemoteSession = async (input: { id: string; title: string; mode: 'auto' | 'daily' }, owner?: string) => (await req<{ session: RemoteSession }>('/v1/sessions', { method: 'POST', body: JSON.stringify(input), headers: ownerHeader(owner) })).session;
export const patchRemoteSession = async (id: string, input: { title?: string; mode?: 'auto' | 'daily'; archived?: boolean; expectedRevision: number }, owner?: string) => (await req<{ session: RemoteSession }>(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input), headers: ownerHeader(owner) })).session;
export const removeRemoteSession = async (id: string, expectedRevision: number, owner?: string) => (await req<{ session: RemoteSession }>(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }), headers: ownerHeader(owner) })).session;
export const getRemoteHistory = async (id: string, signal?: AbortSignal, owner?: string) => { const data = await req<RemoteHistory>(`/v1/sessions/${encodeURIComponent(id)}/history`, { signal, headers: ownerHeader(owner) }); if (!Array.isArray(data.messages) || !Array.isArray(data.tasks) || !data.session) throw new Error('会话记录响应无效'); return data; };
export const importRemoteHistory = async (id: string, messages: SessionMsg[], owner?: string) => { await req(`/v1/sessions/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify({ messages }), headers: ownerHeader(owner) }); };

export function unmatchedMessages(local: ChatSession, history: RemoteHistory): SessionMsg[] {
  const used = new Set<number>();
  const pendingIndex = local.pendingTurn ? local.messages.findIndex(m => m.role === 'user' && m.turnId === local.pendingTurn?.turnId) : -1;
  return local.messages.filter((message, index) => {
    if (pendingIndex >= 0 && index >= pendingIndex) return false;
    const match = history.messages.findIndex((remote, i) => !used.has(i) && remote.role === message.role && ((message.turnId && remote.turnId === message.turnId) || (message.taskId && remote.taskId === message.taskId) || remote.content === message.content));
    if (match >= 0) { used.add(match); return false; } return true;
  });
}
export function hydrateSession(remote: RemoteSession, local?: ChatSession, history?: RemoteHistory): ChatSession {
  const takeMetadata = (remote.revision ?? 0) >= (local?.remoteRevision ?? -1);
  let session: ChatSession = { ...(local ?? { id: remote.id, messages: [], tokens: 0, createdAt: new Date(remote.createdAt).toISOString(), name: remote.title, mode: remote.mode }), backendId: remote.id, ...(takeMetadata ? { name: remote.title, mode: remote.mode, archived: Boolean(remote.archived), remoteRevision: remote.revision ?? 0 } : {}) };
  if (!history) return session;
  const ids = new Set(history.tasks.map(t => t.id));
  const inFlight = session.currentTaskId && ['queued', 'running'].includes(session.taskViews?.[session.currentTaskId]?.task.status ?? '');
  session.currentTaskId = session.currentTaskId && (ids.has(session.currentTaskId) || inFlight) ? session.currentTaskId : history.tasks.at(-1)?.id;
  for (const task of history.tasks) {
    const cached = session.taskViews?.[task.id]?.task;
    if (!cached || (task.updatedAt ?? 0) >= (cached.updatedAt ?? 0)) session = mergeTask(session, task);
  }
  const messages = history.messages.map(message => {
    const cached = local?.messages.find(m => m.role === message.role && ((m.turnId && m.turnId === message.turnId) || (m.taskId && m.taskId === message.taskId)));
    return { ...cached, ...message };
  });
  // A snapshot started before a local submission must not erase that pending turn.
  const pending = local?.messages.filter(m => (local.pendingTurn && m.turnId === local.pendingTurn.turnId || m.taskId && !ids.has(m.taskId) || m.turnId && local.taskViews && Object.values(local.taskViews).some(v => v.task.turnId === m.turnId && !ids.has(v.task.id))) && !messages.some(r => r.role === m.role && ((m.turnId && r.turnId === m.turnId) || (m.taskId && r.taskId === m.taskId) || r.content === m.content))) ?? [];
  for (const task of history.tasks) if ((local?.taskViews?.[task.id]?.task.updatedAt ?? 0) > (task.updatedAt ?? 0)) {
    for (const message of local?.messages.filter(m => m.taskId === task.id || m.turnId === task.turnId) ?? []) {
      const index = messages.findIndex(m => m.role === message.role && (m.taskId === task.id || m.turnId === task.turnId));
      if (index >= 0) messages[index] = message;
      else { const user = messages.findIndex(m => m.role === 'user' && (m.taskId === task.id || m.turnId === task.turnId)); if (user >= 0) messages.splice(user + 1, 0, message); else messages.push(message); }
    }
  }
  return { ...session, messages: [...messages, ...pending], tokens: history.tasks.reduce((n, t) => n + (t.usage?.tokens ?? 0), 0), taskTokenUsage: Object.fromEntries(history.tasks.map(t => [t.id, t.usage?.tokens ?? 0])) };
}
