import { createHash, randomUUID } from "node:crypto";
import type { OpportunityInput, OpportunityRecord, OpportunityStore } from "../core/opportunity-store.ts";
import { canonicalArgs } from "./idempotency.ts";
import type { SqlPool } from "./sql.ts";
import { calendarDate, millis, type DbRow } from "./postgres-shared.ts";

function opportunity(r: DbRow): OpportunityRecord { return { id: String(r.id), userId: String(r.user_id), title: String(r.title), type: String(r.type), organizer: String(r.organizer), description: String(r.description), conditions: r.conditions as string[], deadline: r.deadline == null ? null : calendarDate(r.deadline), sourceUrl: String(r.source_url), sourceType: String(r.source_type), collectedAt: new Date(millis(r.collected_at)).toISOString(), status: r.saved_status as OpportunityRecord["status"], demo: Boolean(r.is_demo) }; }
const categories = new Set(["competition", "internship", "scholarship", "activity", "notice", "research", "exchange", "other"]);
export class PostgresOpportunityStore implements OpportunityStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async create(input: OpportunityInput) {
    const normalized = { title: input.title, type: categories.has(input.type ?? "") ? input.type! : "competition", organizer: input.organizer ?? "", description: input.description ?? "", conditions: input.conditions ?? [], deadline: input.deadline ?? null, sourceUrl: input.sourceUrl ?? "", sourceType: input.sourceType ?? "agent" };
    const contentHash = createHash("sha256").update(`private:${input.userId}:${canonicalArgs(normalized)}`).digest("hex");
    return this.pool.transaction(async (client) => {
      await client.query("insert into opportunities(id,title,type,organizer,description,conditions,deadline,source_url,source_type,created_by,content_hash,visibility) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'private') on conflict(content_hash) where content_hash is not null do nothing", [randomUUID(), normalized.title, normalized.type, normalized.organizer, normalized.description, normalized.conditions, normalized.deadline, normalized.sourceUrl, normalized.sourceType, input.userId, contentHash]);
      const parent = await client.query<{ id: string }>("select id from opportunities where content_hash=$1 and created_by=$2 and visibility='private'", [contentHash, input.userId]);
      if (!parent.rows[0]) throw new Error("Opportunity owner forbidden");
      await client.query("insert into user_opportunities(user_id,opportunity_id) values($1,$2) on conflict do nothing", [input.userId, parent.rows[0].id]);
      const r = await client.query<DbRow>("select o.*,u.user_id,u.status as saved_status from opportunities o join user_opportunities u on u.opportunity_id=o.id where o.id=$1 and u.user_id=$2", [parent.rows[0].id, input.userId]); return opportunity(r.rows[0]);
    });
  }
  async savePublic(userId: string, opportunityId: string) {
    const parent = await this.pool.query("select id from opportunities where id=$1 and visibility='public'", [opportunityId]); if (!parent.rows.length) throw new Error("Public opportunity not found or owner forbidden");
    await this.pool.query("insert into user_opportunities(user_id,opportunity_id) values($1,$2) on conflict do nothing", [userId, opportunityId]); return (await this.get(userId, opportunityId))!;
  }
  async listByUser(userId: string) { const r = await this.pool.query<DbRow>("select o.*,u.user_id,u.status as saved_status from opportunities o join user_opportunities u on u.opportunity_id=o.id where u.user_id=$1 and (o.visibility='public' or o.created_by=$1) order by u.created_at desc,o.id", [userId]); return r.rows.map(opportunity); }
  async get(userId: string, id: string) { const r = await this.pool.query<DbRow>("select o.*,u.user_id,u.status as saved_status from opportunities o join user_opportunities u on u.opportunity_id=o.id where u.user_id=$1 and o.id=$2 and (o.visibility='public' or o.created_by=$1)", [userId, id]); return r.rows[0] ? opportunity(r.rows[0]) : null; }
}
