import { req, type AgentTask } from './api-client';
import type { ChatSession, SessionMsg } from './sessions';
import { mergeTask } from './task-state';
export interface RemoteSession { id: string; title: string; mode: 'auto' | 'daily'; createdAt: number; updatedAt: number; archived?: boolean; deletedAt?: number | null; revision?: number; }
export interface RemoteHistory { session: RemoteSession; messages: SessionMsg[]; tasks: AgentTask[]; }
export interface HistoryItem { key:string; order:[number,number,number,string]; version?:string; messages:SessionMsg[]; task?:AgentTask; }
export interface RemotePage { session:RemoteSession; items:HistoryItem[]; after:string; before?:string; hasMore:boolean; next?:string; totalTokens?:number; }
const ownerHeader = (owner?: string) => owner ? { 'X-Session-Owner': owner } : undefined;
export const listRemoteSessions = async (signal?: AbortSignal, owner?: string) => { const data = await req<{ sessions: RemoteSession[] }>('/v1/sessions', { signal, headers: ownerHeader(owner) }); if (!Array.isArray(data.sessions)) throw new Error('会话列表响应无效'); return data.sessions; };
export const createRemoteSession = async (input: { id: string; title: string; mode: 'auto' | 'daily' }, owner?: string) => (await req<{ session: RemoteSession }>('/v1/sessions', { method: 'POST', body: JSON.stringify(input), headers: ownerHeader(owner) })).session;
export const patchRemoteSession = async (id: string, input: { title?: string; mode?: 'auto' | 'daily'; archived?: boolean; expectedRevision: number }, owner?: string) => (await req<{ session: RemoteSession }>(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input), headers: ownerHeader(owner) })).session;
export const removeRemoteSession = async (id: string, expectedRevision: number, owner?: string) => (await req<{ session: RemoteSession }>(`/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }), headers: ownerHeader(owner) })).session;
export const getRemoteHistory = async (id: string, signal?: AbortSignal, owner?: string) => { const data = await req<RemoteHistory>(`/v1/sessions/${encodeURIComponent(id)}/history`, { signal, headers: ownerHeader(owner) }); if (!Array.isArray(data.messages) || !Array.isArray(data.tasks) || !data.session) throw new Error('会话记录响应无效'); return data; };
export const importRemoteHistory = async (id: string, messages: SessionMsg[], owner?: string) => { await req(`/v1/sessions/${encodeURIComponent(id)}/import`, { method: 'POST', body: JSON.stringify({ messages }), headers: ownerHeader(owner) }); };
export async function getHistoryPage(id:string, before?:string, signal?:AbortSignal, owner?:string):Promise<RemotePage> {
  return req(`/v1/sessions/${encodeURIComponent(id)}/history/page?limit=30${before?'&before='+encodeURIComponent(before):''}`,{signal,headers:ownerHeader(owner)});
}
export async function getHistoryChanges(id:string, after:string, next?:string, signal?:AbortSignal, owner?:string):Promise<RemotePage> {
  return req(`/v1/sessions/${encodeURIComponent(id)}/history/changes?limit=30&after=${encodeURIComponent(after)}${next?'&next='+encodeURIComponent(next):''}`,{signal,headers:ownerHeader(owner)});
}
const compareOrder = (a:NonNullable<SessionMsg['historyOrder']>,b:NonNullable<SessionMsg['historyOrder']>) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2] || a[3].localeCompare(b[3]);
const sameTurn = (m:SessionMsg,n:SessionMsg) => Boolean(m.taskId && n.taskId===m.taskId || m.turnId && n.turnId===m.turnId);
export function mergeHistoryPage(local:ChatSession,page:RemotePage,mode:'initial'|'older'|'changes'):ChatSession {
  if (!Array.isArray(page.items) || typeof page.after!=='string') throw Error('分页历史响应无效');
  let session=hydrateSession(page.session,local);
  if (mode==='changes' && !page.items.length && !local.historyPage?.next && page.totalTokens===undefined && session===local) return local;
  if(mode==='initial') {
    const current=local.currentTaskId, inFlight=current && ['queued','running'].includes(local.taskViews?.[current]?.task.status??'');
    if(!inFlight && (!current || !page.items.some(item=>item.task?.id===current)))session={...session,currentTaskId:page.items.filter(item=>item.task).at(-1)?.task?.id};
  }
  const oldest=local.messages.find(m=>m.historyOrder)?.historyOrder;
  const localTurns=new Set([...Object.values(local.taskViews??{}).filter(v=>v.task.id.startsWith('local:')).map(v=>v.task.turnId),...local.messages.filter(m=>m.taskId?.startsWith('local:')).map(m=>m.turnId)].filter(Boolean));
  const browserOnly=(m:SessionMsg)=>Boolean(m.taskId?.startsWith('local:') || m.turnId && localTurns.has(m.turnId));
  let messages=mode==='initial' ? local.messages.filter(m=>browserOnly(m) || local.pendingTurn && m.turnId===local.pendingTurn.turnId || m.taskId && ['queued','running'].includes(local.taskViews?.[m.taskId]?.task.status??'')) : [...local.messages];
  for (const item of page.items) {
    // Changes to still-unloaded old turns are picked up when that page is read.
    if (mode==='changes' && oldest && compareOrder(item.order,oldest)<0 && !messages.some(m=>m.historyKey===item.key)) continue;
    const cached=messages.find(m=>m.historyKey===item.key);
    if (cached?.historyVersion && item.version && BigInt(cached.historyVersion)>BigInt(item.version)) continue;
    const previous=item.task && session.taskViews?.[item.task.id]?.task;
    if (item.task && previous?.historyRevision && item.version && BigInt(previous.historyRevision)>BigInt(item.version)) continue;
    if (item.task) session=mergeTask(session,item.task);
    const projected=item.messages.map(m=>({ ...local.messages.find(old=>old.role===m.role && (old.historyKey===item.key || sameTurn(old,m))),...m,historyKey:item.key,historyOrder:item.order,historyVersion:item.version }));
    const consumed=new Set<number>();
    messages=messages.filter(m=>{
      if(m.historyKey===item.key || projected.some(n=>sameTurn(m,n)))return false;
      const index=projected.findIndex((n,i)=>!consumed.has(i) && n.imported && browserOnly(m) && m.role===n.role && m.content===n.content);
      if(index<0)return true;consumed.add(index);return false;
    });
    messages.push(...projected);
  }
  messages.sort((a,b)=>a.historyOrder && b.historyOrder ? compareOrder(a.historyOrder,b.historyOrder) || (a.role===b.role?0:a.role==='user'?-1:1) : a.historyOrder?-1:b.historyOrder?1:0);
  const previous=local.historyPage;
  const historyPage=mode==='older' ? { ...previous!,before:page.before,hasMore:page.hasMore } : mode==='changes' ? { ...previous!,after:page.next?previous!.after:page.after,next:page.next } : { after:page.after,before:page.before,hasMore:page.hasMore };
  // Aggregate comes from the server, not the sum of a partial page. Repeated
  // pages/polls must neither reset nor double-count the conversation usage.
  return { ...session,messages,historyPage,tokens:mode==='older'?local.tokens:mode==='changes'?Math.max(local.tokens,page.totalTokens??session.tokens):page.totalTokens??session.tokens };
}

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
  if (!history && local?.backendId===remote.id && (!takeMetadata || local.name===remote.title && local.mode===remote.mode && Boolean(local.archived)===Boolean(remote.archived) && local.remoteRevision===(remote.revision??0))) return local;
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
