// TaskStore 接口 + 内存实现（开发/测试）。Postgres 适配器实现同一接口（migrations/0002，待应用）。
// 结构化状态=事实来源；事件 append-only；检查点用于恢复；幂等唯一键防重复副作用。
import { randomUUID } from "node:crypto";
import type { AgentEvent, Checkpoint, EventType, Task, TaskStatus, ToolInvocation, Budget, Usage } from "../core/types.ts";
import { DEFAULT_BUDGET, EMPTY_USAGE } from "../core/types.ts";
import { assertTaskTransition } from "./state-machine.ts";

export interface CreateTaskInput {
  userId: string;
  title: string;
  intent?: string;
  images?: string[];
  goalId?: string;
  sessionId?: string;
  priority?: number;
  budget?: Budget;
  maxAttempts?: number;
}

export interface TaskStore {
  createTask(input: CreateTaskInput): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  listTasksByUser(userId: string): Promise<Task[]>;
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

export class InMemoryStore implements TaskStore {
  private tasks = new Map<string, Task>();
  private events: AgentEvent[] = [];
  private checkpoints = new Map<string, Checkpoint>();
  private invocations = new Map<string, ToolInvocation>(); // key: taskId|idempotencyKey
  private eventSeq = new Map<string, number>();
  private eventId = 0;

  async createTask(input: CreateTaskInput): Promise<Task> {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      userId: input.userId,
      goalId: input.goalId,
      sessionId: input.sessionId,
      title: input.title,
      intent: input.intent ?? input.title,
      images: input.images,
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

  async getTask(id: string): Promise<Task | null> {
    return this.tasks.get(id) ?? null;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`task not found: ${id}`);
    if (patch.status && patch.status !== t.status) assertTaskTransition(t.status, patch.status);
    const next: Task = { ...t, ...patch, id: t.id, userId: t.userId, updatedAt: Date.now() };
    this.tasks.set(id, next);
    return next;
  }

  async listTasksByUser(userId: string): Promise<Task[]> {
    return [...this.tasks.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
  }

  // 原子认领：queued 或 lease 过期的 running，按 priority↑ createdAt↑。单线程 JS 内原子；Postgres 用 FOR UPDATE SKIP LOCKED。
  async claimNext(opts: { workerId: string; leaseTtlMs: number; now: number }): Promise<Task | null> {
    const eligible = [...this.tasks.values()]
      .filter((t) => t.status === "queued" || (t.status === "running" && (t.lease.expiresAt ?? 0) < opts.now))
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
    this.tasks.set(id, { ...t, cancelRequested: true, updatedAt: Date.now() });
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