import { randomUUID } from "node:crypto";
import type { AppendSessionMessage, SessionStore, StoredSession, StoredSessionMessage } from "../core/storage-contracts.ts";
import type { ChatMessage } from "../core/types.ts";
import type { SqlPool } from "./sql.ts";
import { assertTaskOwner, json, messageEnvelope, millis, optionalText, requireUuid, sameJson, type DbRow } from "./postgres-shared.ts";

function session(r: DbRow): StoredSession { return { id: String(r.id), userId: String(r.user_id), title: String(r.title), mode: r.mode as StoredSession["mode"], summary: String(r.summary ?? ""), summaryThroughSeq: Number(r.summary_through_seq), createdAt: millis(r.created_at), updatedAt: millis(r.updated_at) }; }
function message(r: DbRow): StoredSessionMessage { return { ...(r.content as ChatMessage), id: String(r.id), userId: String(r.user_id), sessionId: String(r.session_id), turnId: String(r.turn_id), messageKey: String(r.message_key), taskId: optionalText(r.task_id), seq: Number(r.seq), createdAt: millis(r.created_at) }; }
export class PostgresSessionStore implements SessionStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async create(input: { userId: string; id?: string; title?: string; mode?: "auto" | "daily" }) {
    const id = input.id ?? randomUUID(); requireUuid(id);
    await this.pool.query("insert into agent_sessions(id,user_id,title,mode) values($1,$2,$3,$4) on conflict(id) do nothing", [id, input.userId, input.title ?? "新会话", input.mode ?? "auto"]);
    const found = await this.get(input.userId, id); if (!found) throw new Error("Session owner forbidden"); return found;
  }
  async get(userId: string, id: string) { requireUuid(id); const r = await this.pool.query<DbRow>("select * from agent_sessions where id=$1 and user_id=$2", [id, userId]); return r.rows[0] ? session(r.rows[0]) : null; }
  async list(userId: string) { const r = await this.pool.query<DbRow>("select * from agent_sessions where user_id=$1 order by updated_at desc,id", [userId]); return r.rows.map(session); }
  async appendMessage(input: AppendSessionMessage) {
    requireUuid(input.sessionId); if (!input.turnId || !input.messageKey) throw new Error("Message requires stable turn/key");
    return this.pool.transaction(async (client) => {
      const parent = await client.query<DbRow>("select * from agent_sessions where id=$1 and user_id=$2 for update", [input.sessionId, input.userId]);
      if (!parent.rows[0]) throw new Error("Session owner forbidden");
      if (input.taskId) await assertTaskOwner(client, input.userId, input.taskId, input.sessionId);
      const old = await client.query<DbRow>("select * from agent_session_messages where user_id=$1 and session_id=$2 and message_key=$3", [input.userId, input.sessionId, input.messageKey]);
      if (old.rows[0]) {
        const found = message(old.rows[0]);
        if (found.turnId !== input.turnId || found.taskId !== input.taskId || !sameJson(messageEnvelope(found), messageEnvelope(input))) throw new Error("Message key conflict");
        return found;
      }
      await client.query("insert into agent_session_turns(user_id,session_id,turn_id) values($1,$2,$3) on conflict do nothing", [input.userId, input.sessionId, input.turnId]);
      const r = await client.query<DbRow>("insert into agent_session_messages(id,user_id,session_id,turn_id,message_key,task_id,seq,role,content) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) returning *", [randomUUID(), input.userId, input.sessionId, input.turnId, input.messageKey, input.taskId ?? null, Number(parent.rows[0].next_seq), input.role, json(messageEnvelope(input))]);
      await client.query("update agent_sessions set next_seq=next_seq+1,updated_at=now() where id=$1 and user_id=$2", [input.sessionId, input.userId]);
      return message(r.rows[0]);
    });
  }
  async listMessages(userId: string, sessionId: string, afterSeq = 0) { requireUuid(sessionId); const r = await this.pool.query<DbRow>("select * from agent_session_messages where user_id=$1 and session_id=$2 and seq>$3 order by seq", [userId, sessionId, afterSeq]); return r.rows.map(message); }
  async updateSummary(userId: string, sessionId: string, summary: string, throughSeq: number) {
    requireUuid(sessionId); if (!Number.isInteger(throughSeq) || throughSeq < 0) throw new Error("Invalid summary sequence");
    const r = await this.pool.query<DbRow>("update agent_sessions set summary=$3,summary_through_seq=$4,updated_at=now() where user_id=$1 and id=$2 and summary_through_seq<=$4 and next_seq>$4 returning *", [userId, sessionId, summary, throughSeq]);
    if (r.rows[0]) return session(r.rows[0]);
    if (await this.get(userId, sessionId)) throw new Error("Invalid summary sequence"); return null;
  }
}
