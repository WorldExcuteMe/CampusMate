// PostgresStore：TaskStore 的 Supabase PostgreSQL 实现（migrations/0002）。
// 队列：事务 + FOR UPDATE SKIP LOCKED + lease；幂等：ON CONFLICT DO NOTHING；事件 append-only。
// Worker 用直连（postgres 角色，表 owner 绕过 RLS）；代码层强制 user_id 隔离。
import { randomUUID } from "node:crypto";
import type { AgentEvent, Checkpoint, EventType, Task, ToolInvocation, Budget } from "../core/types.ts";
import { DEFAULT_BUDGET, EMPTY_USAGE } from "../core/types.ts";
import type { CreateTaskInput, TaskStore } from "./store.ts";
import type { SqlClient, SqlPool } from "./sql.ts";
import { assertTaskTransition } from "./state-machine.ts";
import { sessionInputHash, SessionConflict, type TurnProgress } from "./store.ts";
import { transactionPool } from "./sql.ts";
import { PostgresSessionStore } from "./postgres-session-store.ts";
import type { SessionStore } from "../core/storage-contracts.ts";
import { assertTurnLease, turnMessages } from "../core/session-context.ts";
import { sessionMessages, sessionTurnLimit, type SessionHistoryQuery, type SessionTurn } from "./session-history.ts";

type Row = Record<string, unknown>;

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  return new Date(String(v)).getTime();
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
function j(v: unknown): string { return JSON.stringify(v ?? null); }

function rowToTask(r: Row): Task {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    goalId: r.goal_id ? String(r.goal_id) : undefined,
    sessionId: r.session_id ? String(r.session_id) : undefined,
    turnId: r.turn_id ? String(r.turn_id) : undefined,
    turnSeq: r.turn_seq == null ? undefined : Number(r.turn_seq),
    inputHash: r.input_hash ? String(r.input_hash) : undefined,
    transcriptCommitted: Boolean(r.transcript_committed),
    images: Array.isArray(r.images) ? r.images as string[] : undefined,
    promptUsage: r.prompt_usage as Task["promptUsage"],
    modelConfig: r.model_config as Task["modelConfig"],
    modelRuntime: r.model_runtime as Task["modelRuntime"],
    title: String(r.title),
    intent: String(r.intent ?? ""),
    status: r.status as Task["status"],
    priority: Number(r.priority),
    lease: { owner: (r.lease_owner as string) ?? null, expiresAt: toMs(r.lease_expires_at), heartbeatAt: toMs(r.heartbeat_at) },
    attempt: Number(r.attempt),
    maxAttempts: Number(r.max_attempts),
    budget: (r.budget as Task["budget"]) ?? { ...DEFAULT_BUDGET },
    usage: (r.usage as Task["usage"]) ?? { ...EMPTY_USAGE },
    lastCheckpointId: r.last_checkpoint_id ? String(r.last_checkpoint_id) : undefined,
    cancelRequested: Boolean(r.cancel_requested),
    result: (r.result as Task["result"]) ?? undefined,
    error: r.error ? String(r.error) : undefined,
    createdAt: toMs(r.created_at) ?? 0,
    updatedAt: toMs(r.updated_at) ?? 0,
  };
}

function rowToEvent(r: Row): AgentEvent {
  return {
    id: Number(r.id), taskId: String(r.task_id), userId: String(r.user_id),
    stepId: r.step_id ? String(r.step_id) : undefined, seq: Number(r.seq),
    type: r.type as EventType, payload: (r.payload as Record<string, unknown>) ?? {},
    createdAt: toMs(r.created_at) ?? 0,
  };
}

function rowToCheckpoint(r: Row): Checkpoint {
  return {
    id: String(r.id), taskId: String(r.task_id), userId: String(r.user_id),
    stepId: r.step_id ? String(r.step_id) : undefined,
    eventSeq: Number(r.event_seq), state: r.state as Checkpoint["state"],
    createdAt: toMs(r.created_at) ?? 0,
  };
}

function rowToInvocation(r: Row): ToolInvocation {
  return {
    id: String(r.id), taskId: String(r.task_id), userId: String(r.user_id),
    stepId: r.step_id ? String(r.step_id) : undefined, toolName: String(r.tool_name),
    idempotencyKey: String(r.idempotency_key), argsHash: String(r.args_hash),
    runtime: r.runtime as ToolInvocation["runtime"], status: r.status as ToolInvocation["status"],
    approvalId: r.approval_id ? String(r.approval_id) : undefined,
    result: r.result ?? undefined, error: r.error ? String(r.error) : undefined,
    attempt: Number(r.attempt), startedAt: toMs(r.started_at) ?? 0, finishedAt: toMs(r.finished_at) ?? undefined,
  };
}

export class PostgresStore implements TaskStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  async createSessionTask(input: CreateTaskInput & { sessionId: string; turnId: string }, _sessions: SessionStore): Promise<{ task: Task; deduped: boolean }> {
    return this.pool.transaction(async (client) => {
      const parent = await client.query<Row>("select * from agent_sessions where id=$1 and user_id=$2 for update", [input.sessionId, input.userId]);
      if (!parent.rows[0]) throw new Error("Session owner forbidden");
      const hash = sessionInputHash(input);
      const existing = await client.query<Row>("select * from agent_tasks where user_id=$1 and session_id=$2 and turn_id=$3", [input.userId, input.sessionId, input.turnId]);
      if (existing.rows[0]) { const task = rowToTask(existing.rows[0]); if (task.inputHash !== hash) throw new SessionConflict("同一轮次的输入冲突"); return { task, deduped: true }; }
      await client.query("insert into agent_session_turns(user_id,session_id,turn_id) values($1,$2,$3)", [input.userId, input.sessionId, input.turnId]);
      const pool = transactionPool(client);
      const task = await new PostgresStore(pool).createTask({ ...input, inputHash: hash, turnSeq: Number(parent.rows[0].next_turn_seq) });
      await new PostgresSessionStore(pool).appendMessage({ userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, messageKey: `${input.turnId}:user`, taskId: task.id, role: "user", content: task.images?.length ? [{ type: "text", text: task.intent }, ...task.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : task.intent });
      await client.query("update agent_sessions set next_turn_seq=next_turn_seq+1 where id=$1", [input.sessionId]);
      return { task, deduped: false };
    });
  }

  async resumeSessionTask(id: string, userId: string, budget?: Budget): Promise<Task> {
    return this.pool.transaction(async (client) => {
      const tasks = new PostgresStore(transactionPool(client));
      const task = await tasks.getTask(id);
      if (!task || task.userId !== userId) throw new Error("Task owner forbidden");
      if (task.sessionId) await client.query("select id from agent_sessions where id=$1 and user_id=$2 for update", [task.sessionId, userId]);
      if (task.status === "failed" && task.turnSeq !== undefined && (await client.query("select id from agent_tasks where user_id=$1 and session_id=$2 and turn_seq>$3 limit 1", [userId, task.sessionId, task.turnSeq])).rows.length) throw new SessionConflict("后续对话已开始，请用新消息继续；原任务记录已保留。");
      return tasks.updateTask(id, { status: "queued", transcriptCommitted: false, ...(budget ? { budget } : {}), error: "" });
    });
  }

  private async persistSessionTurn(input: TurnProgress, patch?: Partial<Task>): Promise<Task> {
    return this.pool.transaction(async (client) => {
      const hint = await client.query<Row>("select session_id from agent_tasks where id=$1 and user_id=$2", [input.taskId, input.userId]);
      await client.query("select id from agent_sessions where id=$1 and user_id=$2 for update", [hint.rows[0]?.session_id, input.userId]);
      const locked = await client.query<Row>("select * from agent_tasks where id=$1 and user_id=$2 for update", [input.taskId, input.userId]);
      const task = locked.rows[0] ? rowToTask(locked.rows[0]) : null;
      assertTurnLease(task, input);
      const pool = transactionPool(client);
      const sessions = new PostgresSessionStore(pool);
      for (const message of turnMessages(task, input.state.transcript ?? [])) await sessions.appendMessage(message);
      const store = new PostgresStore(pool);
      await store.writeCheckpoint({ taskId: task.id, userId: task.userId, eventSeq: 0, state: input.state });
      const next = await store.updateTask(task.id, { ...patch, usage: input.state.usage, transcriptCommitted: Boolean(patch) });
      if (patch?.status && ["succeeded", "failed", "cancelled"].includes(patch.status)) await store.appendEvent({ taskId: task.id, userId: task.userId, type: `task.${patch.status}` as EventType, payload: { reason: patch.error, partial: patch.result?.partial } });
      return next;
    });
  }
  async saveTurnProgress(input: TurnProgress, _sessions: SessionStore): Promise<Task> { return this.persistSessionTurn(input); }
  async finishSessionTurn(input: TurnProgress & { patch: Partial<Task> }, _sessions: SessionStore): Promise<Task> { return this.persistSessionTurn(input, input.patch); }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = randomUUID();
    const now = Date.now();
    const r = await this.pool.query(
      `insert into agent_tasks (id,user_id,goal_id,session_id,title,intent,status,priority,attempt,max_attempts,budget,usage,cancel_requested,created_at,updated_at,turn_id,turn_seq,input_hash,images,model_config)
       values ($1,$2,$3,$4,$5,$6,'queued',$7,0,$8,$9::jsonb,$10::jsonb,false,$11::timestamptz,$11::timestamptz,$12,$13,$14,$15::jsonb,$16::jsonb) returning *`,
      [id, input.userId, input.goalId ?? null, input.sessionId ?? null, input.title, input.intent ?? input.title,
       input.priority ?? 50, input.maxAttempts ?? 3, j(input.budget ?? DEFAULT_BUDGET), j(EMPTY_USAGE), iso(now), input.turnId ?? null, input.turnSeq ?? null, input.inputHash ?? null, j(input.images ?? null), j(input.modelConfig ?? null)],
    );
    const task = rowToTask(r.rows[0]);
    await this.appendEvent({ taskId: task.id, userId: task.userId, type: "task.queued", payload: { title: task.title } });
    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    const r = await this.pool.query(`select * from agent_tasks where id=$1`, [id]);
    return r.rows[0] ? rowToTask(r.rows[0]) : null;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const current = await this.getTask(id);
    if (!current) throw new Error(`task not found: ${id}`);
    if (patch.status && patch.status !== current.status) assertTaskTransition(current.status, patch.status);
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown, cast?: string) => { params.push(val); sets.push(`${col}=$${params.length}${cast ?? ""}`); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.priority !== undefined) add("priority", patch.priority);
    if (patch.attempt !== undefined) add("attempt", patch.attempt);
    if (patch.maxAttempts !== undefined) add("max_attempts", patch.maxAttempts);
    if (patch.budget !== undefined) add("budget", j(patch.budget), "::jsonb");
    if (patch.usage !== undefined) add("usage", j(patch.usage), "::jsonb");
    if (patch.lastCheckpointId !== undefined) add("last_checkpoint_id", patch.lastCheckpointId);
    if (patch.cancelRequested !== undefined) add("cancel_requested", patch.cancelRequested);
    if (patch.result !== undefined) add("result", j(patch.result), "::jsonb");
    if (patch.error !== undefined) add("error", patch.error);
    if (patch.intent !== undefined) add("intent", patch.intent);
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.transcriptCommitted !== undefined) add("transcript_committed", patch.transcriptCommitted);
    if (patch.promptUsage !== undefined) add("prompt_usage", j(patch.promptUsage), "::jsonb");
    if (patch.modelConfig !== undefined) add("model_config", j(patch.modelConfig), "::jsonb");
    if (patch.modelRuntime !== undefined) add("model_runtime", j(patch.modelRuntime), "::jsonb");
    if (patch.lease !== undefined) {
      add("lease_owner", patch.lease.owner);
      add("lease_expires_at", patch.lease.expiresAt == null ? null : iso(patch.lease.expiresAt), "::timestamptz");
      add("heartbeat_at", patch.lease.heartbeatAt == null ? null : iso(patch.lease.heartbeatAt), "::timestamptz");
    }
    add("updated_at", iso(Date.now()), "::timestamptz");
    params.push(id);
    const r = await this.pool.query(`update agent_tasks set ${sets.join(",")} where id=$${params.length} returning *`, params);
    return rowToTask(r.rows[0]);
  }

  async listSessionHistory(query: SessionHistoryQuery): Promise<import("../core/types.ts").ChatMessage[]> {
    if (!query.sessionId) return [];
    const result = await this.pool.query<SessionTurn>(`with queued as (
      select e.task_id,min(e.id) as turn_seq from agent_events e join agent_tasks scoped on scoped.id=e.task_id and scoped.user_id=e.user_id
      where e.user_id=$1 and scoped.session_id=$2 and e.type='task.queued' group by e.task_id
    ), anchor as (select q.turn_seq from agent_tasks t join queued q on q.task_id=t.id where t.id=$3 and t.user_id=$1 and t.session_id=$2)
    select t.intent,t.status,t.result,t.error from agent_tasks t join queued q on q.task_id=t.id
    where t.user_id=$1 and t.session_id=$2 and q.turn_seq < (select turn_seq from anchor) and t.status in ('succeeded','failed','cancelled')
    order by q.turn_seq desc limit $4`,[query.userId,query.sessionId,query.beforeTaskId,sessionTurnLimit(query.maxTurns)]);
    return sessionMessages(result.rows.reverse());
  }
  async listTasksByUser(userId: string): Promise<Task[]> {
    const r = await this.pool.query(`select * from agent_tasks where user_id=$1 order by created_at desc`, [userId]);
    return r.rows.map(rowToTask);
  }

  // 原子认领：事务 + FOR UPDATE SKIP LOCKED。queued 或 lease 过期的 running；重认领 attempt+1。
  async claimNext(opts: { workerId: string; leaseTtlMs: number; now: number }): Promise<Task | null> {
    const nowIso = iso(opts.now);
    const expIso = iso(opts.now + opts.leaseTtlMs);
    const claimed = await this.pool.transaction(async (client: SqlClient) => {
      const r = await client.query(
        `with picked as (
           select id, status from agent_tasks candidate
           where (status='queued' or (status='running' and lease_expires_at < $2::timestamptz))
           and (turn_seq is null or not exists (
             select 1 from agent_tasks earlier where earlier.user_id=candidate.user_id and earlier.session_id=candidate.session_id
               and earlier.turn_seq<candidate.turn_seq
               and (earlier.status not in ('succeeded','failed','cancelled') or not earlier.transcript_committed)
           ))
           order by priority, created_at
           for update skip locked limit 1
         )
         update agent_tasks t set
           status='running', lease_owner=$1, lease_expires_at=$3::timestamptz, heartbeat_at=$2::timestamptz,
           attempt = t.attempt + case when picked.status='running' then 1 else 0 end,
           updated_at=$2::timestamptz
         from picked where t.id=picked.id returning t.*`,
        [opts.workerId, nowIso, expIso],
      );
      return r.rows[0] ? rowToTask(r.rows[0]) : null;
    });
    if (claimed) await this.appendEvent({ taskId: claimed.id, userId: claimed.userId, type: "task.claimed", payload: { workerId: opts.workerId } });
    return claimed;
  }

  async renewLease(id: string, workerId: string, leaseTtlMs: number, now: number): Promise<boolean> {
    const r = await this.pool.query(
      `update agent_tasks set lease_expires_at=$3::timestamptz, heartbeat_at=$2::timestamptz, updated_at=$2::timestamptz
       where id=$1 and lease_owner=$4 and status='running' returning id`,
      [id, iso(now), iso(now + leaseTtlMs), workerId],
    );
    return r.rowCount > 0;
  }

  async requestCancel(id: string, userId: string): Promise<boolean> {
    return this.pool.transaction(async (client) => {
    const r = await client.query<Row>(`update agent_tasks set cancel_requested=true,
      transcript_committed=case when turn_id is not null and status in ('queued','paused','needs_input') then true else transcript_committed end,
      status=case when turn_id is not null and status in ('queued','paused','needs_input') then 'cancelled' else status end,
      updated_at=$3::timestamptz where id=$1 and user_id=$2 and status not in ('succeeded','failed','cancelled') returning id,status`, [id, userId, iso(Date.now())]);
    if (r.rows[0]?.status === "cancelled") await new PostgresStore(transactionPool(client)).appendEvent({ taskId: id, userId, type: "task.cancelled", payload: { reason: "user_requested" } });
    return r.rowCount > 0;
    });
  }

  async appendEvent(input: { taskId: string; userId: string; stepId?: string; type: EventType; payload?: Record<string, unknown> }): Promise<AgentEvent> {
    return this.pool.transaction(async (client) => {
    await client.query("select id from agent_tasks where id=$1 and user_id=$2 for update", [input.taskId, input.userId]);
    const r = await client.query(
      `insert into agent_events (task_id,user_id,step_id,seq,type,payload)
       select $1,$2,$3, coalesce(max(seq),0)+1, $4, $5::jsonb from agent_events where task_id=$1
       returning *`,
      [input.taskId, input.userId, input.stepId ?? null, input.type, j(input.payload ?? {})],
    );
    return rowToEvent(r.rows[0]);
    });
  }

  async listEvents(taskId: string, afterSeq = 0): Promise<AgentEvent[]> {
    const r = await this.pool.query(`select * from agent_events where task_id=$1 and seq>$2 order by seq`, [taskId, afterSeq]);
    return r.rows.map(rowToEvent);
  }

  async writeCheckpoint(input: { taskId: string; userId: string; stepId?: string; eventSeq: number; state: Checkpoint["state"] }): Promise<Checkpoint> {
    const id = randomUUID();
    const r = await this.pool.query(
      `insert into agent_checkpoints (id,task_id,user_id,step_id,event_seq,state) values ($1,$2,$3,$4,$5,$6::jsonb) returning *`,
      [id, input.taskId, input.userId, input.stepId ?? null, input.eventSeq, j(input.state)],
    );
    await this.pool.query(`update agent_tasks set last_checkpoint_id=$2, updated_at=$3::timestamptz where id=$1`, [input.taskId, id, iso(Date.now())]);
    await this.appendEvent({ taskId: input.taskId, userId: input.userId, stepId: input.stepId, type: "checkpoint.written", payload: { checkpointId: id, eventSeq: input.eventSeq } });
    return rowToCheckpoint(r.rows[0]);
  }

  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    const r = await this.pool.query(`select * from agent_checkpoints where id=$1`, [id]);
    return r.rows[0] ? rowToCheckpoint(r.rows[0]) : null;
  }

  async latestCheckpoint(taskId: string): Promise<Checkpoint | null> {
    const r = await this.pool.query(`select * from agent_checkpoints where task_id=$1 order by created_at desc limit 1`, [taskId]);
    return r.rows[0] ? rowToCheckpoint(r.rows[0]) : null;
  }

  // 幂等：ON CONFLICT (task_id,idempotency_key) DO NOTHING；冲突则返回已有记录（deduped）。
  async recordInvocation(inv: ToolInvocation): Promise<{ deduped: boolean; invocation: ToolInvocation }> {
    const r = await this.pool.query(
      `insert into agent_tool_invocations (id,task_id,user_id,step_id,tool_name,idempotency_key,args_hash,runtime,status,approval_id,result,error,attempt,started_at,finished_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::timestamptz,$15::timestamptz)
       on conflict (task_id, idempotency_key) do nothing returning *`,
      [inv.id, inv.taskId, inv.userId, inv.stepId ?? null, inv.toolName, inv.idempotencyKey, inv.argsHash, inv.runtime, inv.status,
       inv.approvalId ?? null, j(inv.result ?? null), inv.error ?? null, inv.attempt, iso(inv.startedAt), inv.finishedAt == null ? null : iso(inv.finishedAt)],
    );
    if (r.rows[0]) return { deduped: false, invocation: rowToInvocation(r.rows[0]) };
    const existing = await this.getInvocation(inv.taskId, inv.idempotencyKey);
    return { deduped: true, invocation: existing ?? inv };
  }

  async getInvocation(taskId: string, idempotencyKey: string): Promise<ToolInvocation | null> {
    const r = await this.pool.query(`select * from agent_tool_invocations where task_id=$1 and idempotency_key=$2`, [taskId, idempotencyKey]);
    return r.rows[0] ? rowToInvocation(r.rows[0]) : null;
  }
}
