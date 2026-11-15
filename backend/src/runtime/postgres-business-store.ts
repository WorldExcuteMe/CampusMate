import { createHash } from 'node:crypto';
import type { BusinessStore, BusinessOwner, BusinessResult, BusinessToolName, MergeNotice } from '../core/business-tools.ts';
import { businessDate, businessText, planInboxMerges } from '../core/business-tools.ts';
import type { SqlClient, SqlPool } from './sql.ts';
import { assertTaskOwner, json, requireUuid, type DbRow } from './postgres-shared.ts';
import { canonicalArgs } from './idempotency.ts';

function stableId(userId: string, tool: string, input: unknown): string {
  const h = createHash('sha256').update(canonicalArgs({ userId, tool, input })).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const result = (fields: Record<string, unknown>): BusinessResult => ({ ok: true, storage: 'postgres', ...fields });
async function insertTask(client: SqlClient, owner: BusinessOwner, id: string, title: string, dueAt: string | null, kind: 'daily' | 'general', timeText: string) {
  const inserted = await client.query('insert into tasks(id,user_id,title,due_at,kind,time_text,status,priority,estimate_hours) values($1,$2,$3,$4,$5,$6,\'todo\',$7,$8) on conflict(id) do nothing returning id', [id, owner.userId, title, dueAt, kind, timeText, kind === 'daily' ? 65 : 70, kind === 'daily' ? 1 : 2]);
  const saved = await client.query<DbRow>('select id,status from tasks where id=$1 and user_id=$2', [id, owner.userId]);
  if (!saved.rows[0]) throw new Error('待办未保存或无权访问');
  return { taskId: id, deduped: !inserted.rows.length, status: saved.rows[0].status };
}

export class PostgresBusinessStore implements BusinessStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async execute(name: BusinessToolName, args: Record<string, unknown>, owner: BusinessOwner): Promise<BusinessResult> {
    requireUuid(owner.userId); requireUuid(owner.taskId);
    return this.pool.transaction(async client => {
      await assertTaskOwner(client, owner.userId, owner.taskId);
      // Serialize this owner's business writes (including merge snapshots), not other users.
      const profile = await client.query('select id from profiles where id=$1 for update', [owner.userId]);
      if (!profile.rows.length) throw new Error('用户画像不存在，无法保存');
      if (name === 'save_to_inbox') {
        const title = businessText(args, 'title', 500, true), summary = businessText(args, 'summary', 20000, true);
        const deadline = businessDate(args, 'deadline'), source = businessText(args, 'source', 2000);
        const requested = businessText(args, 'category', 40);
        const categories = ['competition', 'internship', 'research', 'scholarship', 'activity', 'opensource', 'notice', 'daily'];
        if (requested && !categories.includes(requested)) throw new Error('category 无效');
        // daily is an ingestion hint, not a valid noticeCategory in the existing UI schema.
        const category = requested === 'daily' || !requested ? 'notice' : requested;
        let sourceUrl: string | null = null;
        if (/^https?:\/\//i.test(source)) { const url = new URL(source); if (url.username || url.password) throw new Error('来源链接不能包含凭证'); sourceUrl = url.href; }
        const input = { title, summary, category, deadline, source };
        const id = stableId(owner.userId, name, input);
        const rawText = `${title}\n${summary}${source ? `\n来源：${source}` : ''}`;
        const extracted = { title, summary, category, deadline, sourceUrl, org: '', conditions: [], materials: [], cost: null, location: null, evidenceExcerpt: summary, confidence: 0.5 };
        const classification = { class: 'normal', priorityScore: 50, priorityReason: 'Agent整理，待人工确认与核实', riskSignals: [] };
        const inserted = await client.query('insert into inbox_items(id,user_id,raw_text,source_url,source_type,extracted,classification,status,extraction_mock) values($1,$2,$3,$4,\'text\',$5::jsonb,$6::jsonb,\'pending_review\',false) on conflict(id) do nothing returning id', [id, owner.userId, rawText, sourceUrl, json(extracted), json(classification)]);
        const saved = await client.query('select id,status from inbox_items where id=$1 and user_id=$2', [id, owner.userId]);
        if (!saved.rows.length) throw new Error('通知未保存或无权访问');
        return result({ id, title, deduped: !inserted.rows.length, status: saved.rows[0].status, note: '已保存到本人收件箱；保存不代表已核验。' });
      }
      if (name === 'create_daily_task') {
        const title = businessText(args, 'title', 500, true), dueAt = businessDate(args, 'dueAt'), timeText = businessText(args, 'timeText', 2000);
        const id = stableId(owner.userId, name, { title, dueAt, timeText });
        return result({ ...await insertTask(client, owner, id, title, dueAt, 'daily', timeText), title, dueAt, note: '待办已保存，可在任务与目标查看；重复项保留原状态。' });
      }
      if (name === 'set_growth_goal') {
        const goal = businessText(args, 'goal', 500, true), dueAt = businessDate(args, 'dueAt');
        const input = { goal, dueAt }, goalId = stableId(owner.userId, 'goal', input), taskId = stableId(owner.userId, 'goal-task', input);
        await client.query('insert into goals(id,user_id,title,target_date) values($1,$2,$3,$4) on conflict(id) do nothing', [goalId, owner.userId, goal, dueAt]);
        if (!(await client.query('select id from goals where id=$1 and user_id=$2', [goalId, owner.userId])).rows.length) throw new Error('目标未保存或无权访问');
        await client.query('update profiles set goals=array_append(goals,$2) where id=$1 and not ($2=any(goals))', [owner.userId, goal]);
        const saved = await insertTask(client, owner, taskId, goal, dueAt, 'general', '');
        return result({ goalId, goal, dueAt, ...saved, note: '目标、画像目标与对应待办已在同一事务保存。' });
      }
      const rows = await client.query<DbRow>("select id,extracted,source_url,status,merged_from from inbox_items where user_id=$1 and status in ('pending_review','confirmed') order by id for update", [owner.userId]);
      if (rows.rows.length > 2000) throw new Error('通知过多，请先按批次整理，未做任何更改');
      const notices: MergeNotice[] = rows.rows.map(r => { const e = r.extracted as Record<string, unknown>; return { id: String(r.id), title: typeof e.title === 'string' ? e.title : '', deadline: typeof e.deadline === 'string' ? e.deadline : null, sourceUrl: String(r.source_url ?? e.sourceUrl ?? '') || null, status: String(r.status), mergedFrom: (r.merged_from ?? []) as string[] }; }).filter(n => n.title.trim());
      const plans = planInboxMerges(notices);
      for (const plan of plans) {
        await client.query('update inbox_items set merged_from=$3 where id=$1 and user_id=$2', [plan.canonical.id, owner.userId, plan.mergedFrom]);
        for (const dup of plan.duplicates) {
          await client.query('update tasks set inbox_item_id=$3 where user_id=$1 and inbox_item_id=$2', [owner.userId, dup.id, plan.canonical.id]);
          await client.query("update inbox_items set status='archived' where id=$1 and user_id=$2", [dup.id, owner.userId]);
        }
      }
      return result({ merged: plans.reduce((n, p) => n + p.duplicates.length, 0), clusters: plans.length, note: '重复项仅归档，原文保留；冲突日期/年度/轮次不合并。' });
    });
  }
}
