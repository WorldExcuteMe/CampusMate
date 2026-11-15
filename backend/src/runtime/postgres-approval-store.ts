import { randomUUID } from "node:crypto";
import type { Approval, ApprovalStore } from "./approval.ts";
import type { SqlPool } from "./sql.ts";
import { assertTaskOwner, json, millis, type DbRow } from "./postgres-shared.ts";

function approval(r: DbRow): Approval {
  return { id: String(r.id), taskId: String(r.task_id), userId: String(r.user_id), toolName: String(r.tool_name), args: r.args as Record<string, unknown>, idempotencyKey: String(r.idempotency_key), risk: String(r.risk), status: r.status as Approval["status"], createdAt: millis(r.created_at), decidedAt: r.decided_at == null ? undefined : millis(r.decided_at) };
}
export class PostgresApprovalStore implements ApprovalStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async create(input: Parameters<ApprovalStore["create"]>[0]): Promise<Approval> {
    return this.pool.transaction(async (client) => {
      await assertTaskOwner(client, input.userId, input.taskId);
      await client.query("insert into agent_approvals(id,task_id,user_id,tool_name,args,idempotency_key,risk) values($1,$2,$3,$4,$5::jsonb,$6,$7) on conflict(task_id,idempotency_key) do nothing", [randomUUID(), input.taskId, input.userId, input.toolName, json(input.args), input.idempotencyKey, input.risk]);
      const r = await client.query<DbRow>("select * from agent_approvals where task_id=$1 and idempotency_key=$2 and user_id=$3", [input.taskId, input.idempotencyKey, input.userId]);
      if (!r.rows[0]) throw new Error("Approval owner forbidden");
      return approval(r.rows[0]);
    });
  }
  async get(id: string) { const r = await this.pool.query<DbRow>("select * from agent_approvals where id=$1", [id]); return r.rows[0] ? approval(r.rows[0]) : null; }
  async findByKey(taskId: string, key: string) { const r = await this.pool.query<DbRow>("select * from agent_approvals where task_id=$1 and idempotency_key=$2", [taskId, key]); return r.rows[0] ? approval(r.rows[0]) : null; }
  async decide(id: string, userId: string, decision: "approved" | "rejected") {
    const r = await this.pool.query<DbRow>("update agent_approvals set status=$3,decided_at=now() where id=$1 and user_id=$2 and status='pending' returning *", [id, userId, decision]);
    if (r.rows[0]) return approval(r.rows[0]);
    const existing = await this.get(id); return existing?.userId === userId ? existing : null;
  }
  async listPendingByUser(userId: string) { const r = await this.pool.query<DbRow>("select * from agent_approvals where user_id=$1 and status='pending' order by created_at,id", [userId]); return r.rows.map(approval); }
}
