import { randomUUID } from "node:crypto";
import type { ArtifactStore, ArtifactWrite, StoredArtifact } from "../core/storage-contracts.ts";
import type { SqlPool } from "./sql.ts";
import { assertTaskOwner, json, millis, optionalText, requireUuid, sameJson, validateArtifact, type DbRow } from "./postgres-shared.ts";

function artifact(r: DbRow): StoredArtifact { return { id: String(r.id), userId: String(r.user_id), taskId: String(r.task_id), documentId: String(r.document_id), revision: Number(r.revision), kind: String(r.kind), inline: r.inline ?? undefined, storagePath: optionalText(r.storage_path), sha256: String(r.sha256), createdAt: millis(r.created_at) }; }
export class PostgresArtifactStore implements ArtifactStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async create(input: ArtifactWrite) {
    await assertTaskOwner(this.pool, input.userId, input.taskId); validateArtifact(input);
    const documentId = input.documentId ?? randomUUID(); requireUuid(documentId);
    return this.pool.transaction(async (client) => {
      const r = await client.query<DbRow>(`insert into agent_artifacts(id,task_id,user_id,document_id,revision,kind,inline,storage_path,sha256) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
        on conflict(task_id,document_id,revision) do nothing returning *`, [randomUUID(), input.taskId, input.userId, documentId, input.revision ?? 1, input.kind, input.inline === undefined ? null : json(input.inline), input.storagePath ?? null, input.sha256]);
      if (r.rows[0]) return artifact(r.rows[0]);
      const old = await client.query<DbRow>("select * from agent_artifacts where user_id=$1 and task_id=$2 and document_id=$3 and revision=$4", [input.userId, input.taskId, documentId, input.revision ?? 1]);
      if (!old.rows[0]) throw new Error("Artifact owner forbidden");
      const found = artifact(old.rows[0]);
      if (found.sha256 !== input.sha256 || !sameJson(found.inline, input.inline) || found.storagePath !== input.storagePath || found.kind !== input.kind) throw new Error("Artifact revision conflict");
      return found;
    });
  }
  async get(userId: string, id: string) { const r = await this.pool.query<DbRow>("select * from agent_artifacts where user_id=$1 and id=$2", [userId, id]); return r.rows[0] ? artifact(r.rows[0]) : null; }
  async listByTask(userId: string, taskId: string) { const r = await this.pool.query<DbRow>("select * from agent_artifacts where user_id=$1 and task_id=$2 order by revision,created_at,id", [userId, taskId]); return r.rows.map(artifact); }
}
