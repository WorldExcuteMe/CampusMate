import { randomUUID } from "node:crypto";
import type { Evidence, EvidenceStore } from "../core/evidence.ts";
import type { SqlPool } from "./sql.ts";
import { assertTaskOwner, millis, optionalText, type DbRow } from "./postgres-shared.ts";

function evidence(r: DbRow): Evidence { return { id: String(r.id), taskId: String(r.task_id), userId: String(r.user_id), sourceUrl: String(r.source_url), excerpt: String(r.excerpt), supports: String(r.supports), confidence: Number(r.confidence), retrievedAt: millis(r.retrieved_at), verified: Boolean(r.verified), artifactId: optionalText(r.artifact_id) }; }
export class PostgresEvidenceStore implements EvidenceStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async add(input: Parameters<EvidenceStore["add"]>[0]) {
    await assertTaskOwner(this.pool, input.userId, input.taskId);
    if (input.artifactId) {
      const parent = await this.pool.query("select id from agent_artifacts where id=$1 and task_id=$2 and user_id=$3", [input.artifactId, input.taskId, input.userId]);
      if (!parent.rows.length) throw new Error("Artifact owner/task forbidden");
    }
    const r = await this.pool.query<DbRow>("insert into agent_evidence(id,task_id,user_id,source_url,excerpt,supports,confidence,artifact_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *", [randomUUID(), input.taskId, input.userId, input.sourceUrl, input.excerpt, input.supports, input.confidence ?? 0.5, input.artifactId ?? null]);
    return evidence(r.rows[0]);
  }
  async get(id: string) { const r = await this.pool.query<DbRow>("select * from agent_evidence where id=$1", [id]); return r.rows[0] ? evidence(r.rows[0]) : null; }
  async listByTask(taskId: string) { const r = await this.pool.query<DbRow>("select * from agent_evidence where task_id=$1 order by retrieved_at,id", [taskId]); return r.rows.map(evidence); }
  async markVerified(id: string, verified: boolean) { const r = await this.pool.query<DbRow>("update agent_evidence set verified=$2 where id=$1 returning *", [id, verified]); return r.rows[0] ? evidence(r.rows[0]) : null; }
}
