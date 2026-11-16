// TaskStore 接口 + 内存实现（开发/测试）。Postgres 适配器实现同一接口（migrations/0002，待应用）。
// 结构化状态=事实来源；事件 append-only；检查点用于恢复；幂等唯一键防重复副作用。
import { randomUUID } from "node:crypto";
import type { AgentEvent, Checkpoint, EventType, Task, TaskStatus, ToolInvocation, Budget, Usage } from "../core/types.ts";
import { DEFAULT_BUDGET, EMPTY_USAGE } from "../core/types.ts";
import { assertTaskTransition } from "./state-machine.ts";
import type { SessionStore } from "../core/storage-contracts.ts";
import type { MemorySessionStore } from "./memory-storage.ts";
import { canonicalArgs, sha256 } from "./idempotency.ts";
import { assertTurnLease, turnMessages } from "../core/session-context.ts";
import { sessionMessages, sessionTurnLimit, type SessionHistoryQuery } from "./session-history.ts";

export interface CreateTaskInput {
  userId: string;
  title: string;
  intent?: string;
  images?: string[];
  goalId?: string;
  sessionId?: string;
  turnId?: string;
  turnSeq?: number;
  inputHash?: string;
  modelConfig?: Task["modelConfig"];
  priority?: number;
  budget?: Budget;
  maxAttempts?: number;
}

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  createSessionTask?(input: CreateTaskInput & { sessionId: string; turnId: string }, sessions: SessionStore): Promise<{ task: Task; deduped: boolean }>;
  resumeSessionTask?(id: string, userId: string, budget?: Budget): Promise<Task>;
  saveTurnProgress?(input: TurnProgress, sessions: SessionStore): Promise<Task>;
  finishSessionTurn?(input: TurnProgress & { patch: Partial<Task> }, sessions: SessionStore): Promise<Task>;
  getTask(id: string, options?: { includeImages?: boolean }): Promise<Task | null>;
  pauseTaskIfOwned?(input: { taskId: string; userId: string; workerId: string; attempt: number; now: number; error: string }): Promise<boolean>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  listTasksByUser(userId: string): Promise<Task[]>;
  // Session metadata only; image inputs remain available through getTask.
  listSessionTasks(userId: string, sessionId: string): Promise<Task[]>;
  listSessionHistory(query: SessionHistoryQuery): Promise<import("../core/types.ts").ChatMessage[]>;
  claimNext(opts: { workerId: string; leaseTtlMs: number; now: number }): Promise<Task | null>;
  renewLease(id: string, workerId: string, leaseTtlMs: number, now: number): Promise<boolean>;
  requestCancel(id: string, userId: string): Promise<boolean>;
  appendEvent(input: { taskId: string; userId: string; stepId?: string; type: EventType; payload?: Record<string, unknown> }): Promise<AgentEvent>;
  listEvents(taskId: string, afterSeq?: number): Promise<AgentEvent[]>;
  writeCheckpoint(input: { taskId: string; userId: string; stepId?: string; eventSeq: number; state: Checkpoint["state"] }): Promise<Checkpoint>;
  getCheckpoint(id: string): Promise<Checkpoint | null>;
  latestCheckpoint(taskId: string): Promise<Checkpoint | null>;
  recordInvocation(inv: ToolInvocation): Promise<{ deduped: boolean; invocation: ToolInvocation }>;
  getInvocation(taskId: string, idempotencyKey: string): Promise<ToolInvocation | null>;
}

export interface TurnProgress {
  taskId: string; userId: string; workerId: string; attempt: number; now: number;
  state: Checkpoint["state"];
}

export class SessionConflict extends Error { readonly status = 409; }
export function sessionInputHash(input: CreateTaskInput): string {
  return sha256(canonicalArgs({ title: input.title, intent: input.intent ?? input.title, images: input.images ?? [], priority: input.priority ?? 50, budget: input.budget ?? DEFAULT_BUDGET, modelConfig: input.modelConfig ?? null }));
}

export class InMemoryStore implements TaskStore {
  private tasks = new Map<string, Task>();
  private events: AgentEvent[] = [];
  private checkpoints = new Map<string, Checkpoint>();
  private invocations = new Map<string, ToolInvocation>(); // key: taskId|idempotencyKey
  private eventSeq = new Map<string, number>();
  private eventId = 0;
  private sessionTails = new Map<string, Promise<void>>();

  private async sessionTransaction<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.sessionTails.set(sessionId, tail);
    await previous;
    try { return await fn(); } finally { release(); if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId); }
  }

  async createSessionTask(input: CreateTaskInput & { sessionId: string; turnId: string }, sessions: SessionStore): Promise<{ task: Task; deduped: boolean }> {
    return this.sessionTransaction(input.sessionId, async () => {
      if (!await sessions.get(input.userId, input.sessionId)) throw new Error("Session owner forbidden");
      const hash = sessionInputHash(input);
      const turns = [...this.tasks.values()].filter((t) => t.userId === input.userId && t.sessionId === input.sessionId);
      const existing = turns.find((t) => t.turnId === input.turnId);
      if (existing) { if (existing.inputHash !== hash) throw new SessionConflict("同一轮次的输入冲突"); return { task: existing, deduped: true }; }
      const scratch = new InMemoryStore();
      const task = await scratch.createTask({ ...input, inputHash: hash, turnSeq: Math.max(0, ...turns.map((t) => t.turnSeq ?? 0)) + 1 });
      const memory = sessions as MemorySessionStore;
      const draft = memory.forkForTask(scratch, input.sessionId);
      await draft.appendMessage({ userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, messageKey: `${input.turnId}:user`, taskId: task.id, role: "user", content: task.images?.length ? [{ type: "text", text: task.intent }, ...task.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : task.intent });
      // Publish both records synchronously after every fallible operation succeeded.
      memory.commitSession(input.sessionId, draft);
      this.tasks.set(task.id, task);
      await this.appendEvent({ taskId: task.id, userId: task.userId, type: "task.queued", payload: { title: task.title } });
      return { task, deduped: false };
    });
  }

  async resumeSessionTask(id: string, userId: string, budget?: Budget): Promise<Task> {
    const task = await this.getTask(id);
    if (!task || task.userId !== userId) throw new Error("Task owner forbidden");
    return this.sessionTransaction(task.sessionId ?? id, async () => {
      if (task.status === "failed" && task.turnSeq !== undefined && [...this.tasks.values()].some((t) => t.userId === userId && t.sessionId === task.sessionId && (t.turnSeq ?? 0) > task.turnSeq!)) throw new SessionConflict("后续对话已开始，请用新消息继续；原任务记录已保留。");
      return this.updateTask(id, { status: "queued", transcriptCommitted: false, ...(budget ? { budget } : {}), error: "" });
    });
  }

  private async persistSessionTurn(input: TurnProgress, sessions: SessionStore, patch?: Partial<Task>): Promise<Task> {
    const task = this.tasks.get(input.taskId);
    assertTurnLease(task, input);
    return this.sessionTransaction(task.sessionId!, async () => {
      const memory = sessions as MemorySessionStore;
      const staged = memory.forkForTask(this, task.sessionId!);
      for (const message of turnMessages(task, input.state.transcript ?? [])) await staged.appendMessage(message);
      const current = this.tasks.get(task.id);
      assertTurnLease(current, input);
      if (patch?.status && patch.status !== current.status) assertTaskTransition(current.status, patch.status);
      const checkpoint: Checkpoint = { id: randomUUID(), taskId: task.id, userId: task.userId, eventSeq: 0, state: structuredClone(input.state), createdAt: input.now };
      memory.commitSession(task.sessionId!, staged);
      this.checkpoints.set(checkpoint.id, checkpoint);
      const next = { ...current, ...patch, usage: structuredClone(input.state.usage), lastCheckpointId: checkpoint.id, transcriptCommitted: Boolean(patch), updatedAt: input.now };
      await this.appendEvent({ taskId: task.id, userId: task.userId, type: "checkpoint.written", payload: { checkpointId: checkpoint.id } });
      if (patch?.status && ["succeeded", "failed", "cancelled"].includes(patch.status)) await this.appendEvent({ taskId: task.id, userId: task.userId, type: `task.${patch.status}` as EventType, payload: { reason: patch.error, partial: patch.result?.partial } });
      this.tasks.set(task.id, next);
      return next;
    });
  }
  async saveTurnProgress(input: TurnProgress, sessions: SessionStore): Promise<Task> { return this.persistSessionTurn(input, sessions); }
  async finishSessionTurn(input: TurnProgress & { patch: Partial<Task> }, sessions: SessionStore): Promise<Task> { return this.persistSessionTurn(input, sessions, input.patch); }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      userId: input.userId,
      goalId: input.goalId,
      sessionId: input.sessionId,
      turnId: input.turnId, turnSeq: input.turnSeq, inputHash: input.inputHash, transcriptCommitted: false,
      title: input.title,
      intent: input.intent ?? input.title,
      images: input.images,
      modelConfig: input.modelConfig,
      status: "queued",
      priority: input.priority ?? 50,
      lease: { owner: null, expiresAt: null, heartbeatAt: null },
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      budget: input.budget ?? { ...DEFAULT_BUDGET },
      usage: { ...EMPTY_USAGE },
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    await this.appendEvent({ taskId: task.id, userId: task.userId, type: "task.queued", payload: { title: task.title } });
    return task;
  }

  async getTask(id: string, options?: { includeImages?: boolean }): Promise<Task | null> {
    const task = this.tasks.get(id) ?? null;
    if (!task || options?.includeImages !== false) return task;
    const { images: _images, ...state } = task; return state;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`task not found: ${id}`);
    if (patch.status && patch.status !== t.status) assertTaskTransition(t.status, patch.status);
    const next: Task = { ...t, ...patch, id: t.id, userId: t.userId, updatedAt: Date.now() };
    this.tasks.set(id, next);
    return next;
  }

  // Compatibility projection for pre-turn tasks; the Worker uses full SessionStore transcripts.
  async listSessionHistory(query: SessionHistoryQuery): Promise<import("../core/types.ts").ChatMessage[]> {
    const anchor = this.tasks.get(query.beforeTaskId);
    if (!query.sessionId || !anchor || anchor.userId !== query.userId || anchor.sessionId !== query.sessionId) return [];
    const queued = new Map<string, AgentEvent>();
    for (const event of this.events) if (event.type === "task.queued" && event.userId === query.userId && !queued.has(event.taskId)) queued.set(event.taskId, event);
    const anchorSeq = queued.get(anchor.id)?.id;
    if (anchorSeq === undefined) return [];
    const turns = [...queued.values()].filter(event => event.id < anchorSeq).map(event => this.tasks.get(event.taskId)).filter((task): task is Task => Boolean(task && task.userId === query.userId && task.sessionId === query.sessionId && ["succeeded", "failed", "cancelled"].includes(task.status))).slice(-sessionTurnLimit(query.maxTurns));
    return sessionMessages(turns);
  }
  async listTasksByUser(userId: string): Promise<Task[]> {
    return [...this.tasks.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  }
  async listSessionTasks(userId: string, sessionId: string): Promise<Task[]> {
    return (await this.listTasksByUser(userId)).filter(t => t.sessionId === sessionId).map(({ images: _images, ...task }) => task);
  }

  // 原子认领：queued 或 lease 过期的 running，按 priority↑ createdAt↑。单线程 JS 内原子；Postgres 用 FOR UPDATE SKIP LOCKED。
  async claimNext(opts: { workerId: string; leaseTtlMs: number; now: number }): Promise<Task | null> {
    const eligible = [...this.tasks.values()]
      .filter((t) => t.status === "queued" || (t.status === "running" && (t.lease.expiresAt ?? 0) < opts.now))
      .filter((t) => t.turnSeq === undefined || ![...this.tasks.values()].some((earlier) => earlier.userId === t.userId && earlier.sessionId === t.sessionId && (earlier.turnSeq ?? Infinity) < t.turnSeq! && (!["succeeded", "failed", "cancelled"].includes(earlier.status) || !earlier.transcriptCommitted)))
      .sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt));
    const t = eligible[0];
    if (!t) return null;
    const reclaimed = t.status === "running";
    const next: Task = {
      ...t,
      status: "running",
      attempt: reclaimed ? t.attempt + 1 : t.attempt,
      lease: { owner: opts.workerId, expiresAt: opts.now + opts.leaseTtlMs, heartbeatAt: opts.now },
      updatedAt: opts.now,
    };
    this.tasks.set(t.id, next);
    await this.appendEvent({ taskId: t.id, userId: t.userId, type: "task.claimed", payload: { workerId: opts.workerId, reclaimed } });
    return next;
  }

  async renewLease(id: string, workerId: string, leaseTtlMs: number, now: number): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t || t.lease.owner !== workerId || t.status !== "running") return false;
    this.tasks.set(id, { ...t, lease: { owner: workerId, expiresAt: now + leaseTtlMs, heartbeatAt: now }, updatedAt: now });
    return true;
  }

  async requestCancel(id: string, userId: string): Promise<boolean> {
    const t = this.tasks.get(id);
    if (!t || t.userId !== userId) return false;
    if (["succeeded", "failed", "cancelled"].includes(t.status)) return false;
    const terminal = t.turnId && ["queued", "paused", "needs_input"].includes(t.status);
    if (terminal) await this.appendEvent({ taskId: id, userId, type: "task.cancelled", payload: { reason: "user_requested" } });
    this.tasks.set(id, { ...t, cancelRequested: true, ...(terminal ? { status: "cancelled", transcriptCommitted: true } as const : {}), updatedAt: Date.now() });
    return true;
  }

  async appendEvent(input: { taskId: string; userId: string; stepId?: string; type: EventType; payload?: Record<string, unknown> }): Promise<AgentEvent> {
    const seq = (this.eventSeq.get(input.taskId) ?? 0) + 1;
    this.eventSeq.set(input.taskId, seq);
    const ev: AgentEvent = {
      id: ++this.eventId,
      taskId: input.taskId,
      userId: input.userId,
      stepId: input.stepId,
      seq,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: Date.now(),
    };
    this.events.push(ev);
    return ev;
  }

  async listEvents(taskId: string, afterSeq = 0): Promise<AgentEvent[]> {
    return this.events.filter((e) => e.taskId === taskId && e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  }

  async writeCheckpoint(input: { taskId: string; userId: string; stepId?: string; eventSeq: number; state: Checkpoint["state"] }): Promise<Checkpoint> {
    const cp: Checkpoint = { id: randomUUID(), taskId: input.taskId, userId: input.userId, stepId: input.stepId, eventSeq: input.eventSeq, state: input.state, createdAt: Date.now() };
    this.checkpoints.set(cp.id, cp);
    const t = this.tasks.get(input.taskId);
    if (t) this.tasks.set(input.taskId, { ...t, lastCheckpointId: cp.id, updatedAt: Date.now() });
    await this.appendEvent({ taskId: input.taskId, userId: input.userId, stepId: input.stepId, type: "checkpoint.written", payload: { checkpointId: cp.id, eventSeq: input.eventSeq } });
    return cp;
  }

  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    return this.checkpoints.get(id) ?? null;
  }

  async latestCheckpoint(taskId: string): Promise<Checkpoint | null> {
    const cps = [...this.checkpoints.values()].filter((c) => c.taskId === taskId).sort((a, b) => b.createdAt - a.createdAt);
    return cps[0] ?? null;
  }

  // 幂等：同 (taskId, idempotencyKey) 已存在 → deduped（返回已有记录，不重复副作用）。
  async recordInvocation(inv: ToolInvocation): Promise<{ deduped: boolean; invocation: ToolInvocation }> {
    const k = `${inv.taskId}|${inv.idempotencyKey}`;
    const existing = this.invocations.get(k);
    if (existing) return { deduped: true, invocation: existing };
    this.invocations.set(k, inv);
    return { deduped: false, invocation: inv };
  }

  async getInvocation(taskId: string, idempotencyKey: string): Promise<ToolInvocation | null> {
    return this.invocations.get(`${taskId}|${idempotencyKey}`) ?? null;
  }
}
