import type { SessionStore, StoredSessionMessage } from '../core/storage-contracts.ts';
import type { Task } from '../core/types.ts';
import { publicConversation, SessionManagementError, type LegacyMessage } from '../core/session-management.ts';
import type { TaskStore } from './store.ts';
import type { SqlPool } from './sql.ts';
import { rowToTask } from './postgres-store.ts';

export type HistoryOrder = [number, number, number, string];
export interface HistoryItem { key: string; order: HistoryOrder; version?: string; messages: ReturnType<typeof publicConversation>; task?: Task; }
export interface HistoryPage { items: HistoryItem[]; after: string; before?: string; hasMore: boolean; next?: string; totalTokens?: number; }
type Cursor = { v: 1; owner: string; session: string; low?: string; upper?: string; nextLow?: string; last?: [string,string]; before?: HistoryOrder };
const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
const numeric = (value: unknown): value is string => typeof value === 'string' && /^\d{1,18}$/.test(value);
const orderValid = (value: unknown): value is HistoryOrder => Array.isArray(value) && value.length === 4 && value.slice(0,3).every(n => Number.isSafeInteger(n) && n >= 0) && typeof value[3] === 'string' && value[3].length < 100;
const compare = (a: HistoryOrder,b: HistoryOrder) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2] || a[3].localeCompare(b[3]);
function cursor(raw: string | undefined, owner: string, session: string): Cursor | undefined {
  if (raw === undefined) return;
  try {
    if (!raw || raw.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
    const c = JSON.parse(Buffer.from(raw,'base64url').toString());
    if (c.v!==1 || c.owner!==owner || c.session!==session || c.before!==undefined && !orderValid(c.before) || c.low!==undefined && !numeric(c.low) || c.upper!==undefined && !numeric(c.upper) || c.nextLow!==undefined && !numeric(c.nextLow) || c.last!==undefined && (!Array.isArray(c.last) || c.last.length!==2 || !numeric(c.last[0]) || typeof c.last[1]!=='string' || c.last[1].length>100)) throw Error();
    return c;
  } catch { throw new SessionManagementError('历史游标无效，请刷新会话后重试',400); }
}
export class SessionFeed {
  private observed = new Map<string, Map<string,{ json:string; xid:string; item:HistoryItem }>>();
  private tick = 0n;
  private sessions: SessionStore; private tasks: TaskStore; private pool?: SqlPool;
  constructor(sessions: SessionStore, tasks: TaskStore, pool?: SqlPool) { this.sessions=sessions; this.tasks=tasks; this.pool=pool; }
  async read(owner: string, session: string, options: { limit?: string; before?: string; after?: string; next?: string } = {}): Promise<HistoryPage> {
    const parent = await this.sessions.get(owner,session);
    if (!parent || parent.deletedAt) throw new SessionManagementError('会话不存在或已删除',404);
    const limit = options.limit === undefined ? 30 : Number(options.limit);
    if (!Number.isInteger(limit) || limit<1 || limit>50 || options.before && options.after || options.next && !options.after) throw new SessionManagementError('分页参数无效，页大小须为1至50',400);
    const before = cursor(options.before,owner,session), after = cursor(options.after,owner,session), next = cursor(options.next,owner,session);
    if (options.before && !before?.before || options.after && !after?.low || options.next && (!next?.last || !next.upper || !next.nextLow || next.low !== after?.low)) throw new SessionManagementError('历史游标类型无效',400);
    const scope = { v:1 as const,owner,session };
    let rows: { item: HistoryItem; xid:string }[], low: string, upper: string, memoryTokens=0;
    if (this.pool) {
      // xmin, not xmax/last-sequence, is the safe next watch watermark: an
      // older uncommitted writer can commit AFTER this response. Replay that
      // overlap and merge by stable group key/version. No timestamp guessing.
      const stamp = (await this.pool.query<{low:string;upper:string}>('select txid_snapshot_xmin(txid_current_snapshot())::text as low, txid_snapshot_xmax(txid_current_snapshot())::text as upper')).rows[0];
      low=stamp.low; upper=next?.upper ?? stamp.upper;
      if (after && (BigInt(after.low!)>BigInt(stamp.upper) || next?.upper && BigInt(next.upper)>BigInt(stamp.upper))) throw new SessionManagementError('增量游标已失效，请重新加载最近消息',409);
      const where = after ? 'xid >= $3::bigint and xid < $4::bigint and (xid,key) > ($5::bigint,$6::text)' : '(kind,at,ord,key) < ($7::int,$8::bigint,$9::bigint,$10::text)';
      const order = after ? 'xid asc,key asc' : 'kind desc,at desc,ord desc,key desc';
      const b = before?.before ?? [2,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,'~'];
      // Pick only bounded metadata first; materialize full task/message payloads
      // AFTER LIMIT, never transport every task/body belonging to the account.
      const data = await this.pool.query<any>(`with bounds as (select $3::bigint as lo,$4::bigint as hi,$5::bigint as last_xid,$6::text as last_key,$7::int as kind,$8::bigint as at,$9::bigint as ord,$10::text as key), items as (
        select 't:'||id::text as key,1 as kind,floor(extract(epoch from created_at)*1000)::bigint as at,coalesce(turn_seq,0)::bigint as ord,'task' as type,id::text as ref,history_xid as xid from agent_tasks where user_id=$1 and session_id=$2
        union all select 'm:'||id::text,1,floor(extract(epoch from created_at)*1000)::bigint,seq,'message',id::text,history_xid from agent_session_messages where user_id=$1 and session_id=$2 and task_id is null and role in ('user','assistant') and coalesce(jsonb_array_length(content->'tool_calls'),0)=0
        union all select 'l:'||entry.ordinality::text,0,0,entry.ordinality,'legacy',entry.ordinality::text,s.legacy_xid from agent_sessions s cross join lateral jsonb_array_elements(s.legacy_history) with ordinality as entry(value,ordinality) where s.user_id=$1 and s.id=$2
      ), picked as materialized (select * from items where ${where} order by ${order} limit $11)
      select p.*,case p.type when 'task' then (select to_jsonb(t)-'images' from agent_tasks t where t.id=p.ref::uuid and t.user_id=$1 and t.session_id=$2)
        when 'message' then (select to_jsonb(m) from agent_session_messages m where m.id=p.ref::uuid and m.user_id=$1 and m.session_id=$2)
        else (select legacy_history->(p.ref::int-1) from agent_sessions where id=$2 and user_id=$1) end as payload from picked p order by ${order}`,
        [owner,session,after?.low ?? '0',upper,next?.last?.[0] ?? '-1',next?.last?.[1] ?? '',...b,limit+1]);
      rows=data.rows.map(r => {
        const key=String(r.key), order:HistoryOrder=[Number(r.kind),Number(r.at),Number(r.ord),key];
        if (r.type==='task') { const task=rowToTask(r.payload); return { xid:String(r.xid),item:{key,order,task,messages:publicConversation([task],[],[])} }; }
        const messages=r.type==='legacy' ? publicConversation([],[],[r.payload as LegacyMessage]) : publicConversation([],[{...r.payload.content,seq:Number(r.payload.seq),createdAt:Number(r.at)} as StoredSessionMessage],[]);
        return {xid:String(r.xid),item:{key,order,messages}};
      });
    } else {
      const tasks=await (this.tasks.listTasksBySession ? this.tasks.listTasksBySession(owner,session) : this.tasks.listTasksByUser(owner).then(rows=>rows.filter(t=>t.sessionId===session)));
      memoryTokens=tasks.reduce((sum,t)=>sum+(t.usage?.tokens??0),0);
      const messages=await this.sessions.listMessages(owner,session), legacy=await this.sessions.legacyHistory(owner,session);
      const items: HistoryItem[]=[...tasks.map(task=>({key:'t:'+task.id,order:[1,task.createdAt,task.turnSeq??0,'t:'+task.id] as HistoryOrder,task,messages:publicConversation([task],[],[])})),
        ...messages.filter(m=>!m.taskId && ['user','assistant'].includes(m.role) && !m.tool_calls?.length).map(m=>({key:'m:'+m.id,order:[1,m.createdAt,m.seq,'m:'+m.id] as HistoryOrder,messages:publicConversation([],[m],[])})),
        ...legacy.map((m,i)=>({key:'l:'+(i+1),order:[0,0,i+1,'l:'+(i+1)] as HistoryOrder,messages:publicConversation([],[],[m])}))];
      const key=owner+':'+session, seen=this.observed.get(key)??new Map(); this.observed.set(key,seen);
      for (const item of items) { const json=JSON.stringify(item); if (seen.get(item.key)?.json!==json) seen.set(item.key,{json,xid:String(++this.tick),item}); }
      low=String(this.tick+1n); upper=next?.upper??low;
      if(after && BigInt(after.low!)>BigInt(low))throw new SessionManagementError('增量游标已失效，请重新加载最近消息',409);
      rows=[...seen.values()].map(({item,xid})=>({item,xid})).filter(r=> after ? BigInt(r.xid)>=BigInt(after.low!) && BigInt(r.xid)<BigInt(upper) && (!next?.last || BigInt(r.xid)>BigInt(next.last[0]) || r.xid===next.last[0] && r.item.key>next.last[1]) : !before?.before || compare(r.item.order,before.before)<0)
        .sort((a,b)=>after ? (BigInt(a.xid)<BigInt(b.xid)?-1:BigInt(a.xid)>BigInt(b.xid)?1:a.item.key.localeCompare(b.item.key)) : compare(b.item.order,a.item.order)).slice(0,limit+1);
    }
    const hasMore=rows.length>limit, selected=rows.slice(0,limit), last=selected.at(-1);
    const afterToken=encode({...scope,low:next?.nextLow??low});
    let totalTokens: number | undefined;
    if (!after || selected.length) totalTokens=this.pool ? Number((await this.pool.query<{total:string}>("select coalesce(sum((usage->>'tokens')::numeric),0)::text as total from agent_tasks where user_id=$1 and session_id=$2",[owner,session])).rows[0].total) : memoryTokens;
    return {items:selected.map(r=>({...r.item,version:r.xid})).sort((a,b)=>compare(a.order,b.order)),after:afterToken,
      ...(!after && last ? {before:encode({...scope,before:last.item.order})}:{}),hasMore,
      ...(after && hasMore && last ? {next:encode({...scope,low:after.low,upper,nextLow:next?.nextLow??low,last:[last.xid,last.item.key]})}:{}),totalTokens};
  }
}
