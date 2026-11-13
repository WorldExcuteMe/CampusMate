// 五类记忆隔离存储。User/Session/Task/Episodic/Procedural 各自隔离键，跨用户/会话/任务检索默认禁止。
// Task State 事实来源在 agent_tasks（此处不重复）；Episodic 引用 agent_events；Procedural 需 evaluator 验证。
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./types.ts";

// 1. User Memory：画像/偏好/长期目标（per user）。
export interface UserMemory { userId: string; profile: Record<string, unknown>; preferences: Record<string, unknown>; updatedAt: number; }

// 2. Session Context：单会话对话历史/会话级偏好（per session + user）。
export interface SessionContext { sessionId: string; userId: string; messages: ChatMessage[]; summary?: string; updatedAt: number; }

// 3. Episodic Memory：任务执行经历（per task + user，引用事件）。
export interface EpisodicEntry { id: string; taskId: string; userId: string; eventSeq: number; type: string; payload: Record<string, unknown>; createdAt: number; }

// 4. Procedural Memory：已验证可复用技能/流程（per user，需 evaluator 验证）。
export interface ProceduralSkill { id: string; userId: string; name: string; steps: unknown; verifiedBy: "evaluator"; successRate: number; createdAt: number; }

export interface MemoryStore {
  // User
  getUserMemory(userId: string): Promise<UserMemory | null>;
  setUserMemory(userId: string, profile: Record<string, unknown>, preferences: Record<string, unknown>): Promise<UserMemory>;
  // Session（隔离：必须匹配 userId）
  getSession(sessionId: string, userId: string): Promise<SessionContext | null>;
  appendSession(sessionId: string, userId: string, messages: ChatMessage[]): Promise<SessionContext>;
  // Episodic（隔离：必须匹配 taskId + userId）
  addEpisodic(entry: { taskId: string; userId: string; eventSeq: number; type: string; payload?: Record<string, unknown> }): Promise<EpisodicEntry>;
  listEpisodic(taskId: string, userId: string): Promise<EpisodicEntry[]>;
  // Procedural（仅 evaluator 验证后可写；检索按 user）
  addProcedural(skill: { userId: string; name: string; steps: unknown; verifiedBy: "evaluator"; successRate?: number }): Promise<ProceduralSkill>;
  listProcedural(userId: string): Promise<ProceduralSkill[]>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private user = new Map<string, UserMemory>();
  private sessions = new Map<string, SessionContext>(); // key: sessionId|userId
  private episodic: EpisodicEntry[] = [];
  private procedural = new Map<string, ProceduralSkill>();

  async getUserMemory(userId: string): Promise<UserMemory | null> { return this.user.get(userId) ?? null; }
  async setUserMemory(userId: string, profile: Record<string, unknown>, preferences: Record<string, unknown>): Promise<UserMemory> {
    const m: UserMemory = { userId, profile, preferences, updatedAt: Date.now() };
    this.user.set(userId, m);
    return m;
  }

  async getSession(sessionId: string, userId: string): Promise<SessionContext | null> {
    const s = this.sessions.get(`${sessionId}|${userId}`);
    return s ?? null; // 跨用户不可见
  }
  async appendSession(sessionId: string, userId: string, messages: ChatMessage[]): Promise<SessionContext> {
    const key = `${sessionId}|${userId}`;
    const prev = this.sessions.get(key);
    const next: SessionContext = { sessionId, userId, messages: [...(prev?.messages ?? []), ...messages], summary: prev?.summary, updatedAt: Date.now() };
    this.sessions.set(key, next);
    return next;
  }

  async addEpisodic(entry: { taskId: string; userId: string; eventSeq: number; type: string; payload?: Record<string, unknown> }): Promise<EpisodicEntry> {
    const e: EpisodicEntry = { id: randomUUID(), taskId: entry.taskId, userId: entry.userId, eventSeq: entry.eventSeq, type: entry.type, payload: entry.payload ?? {}, createdAt: Date.now() };
    this.episodic.push(e);
    return e;
  }
  async listEpisodic(taskId: string, userId: string): Promise<EpisodicEntry[]> {
    return this.episodic.filter((e) => e.taskId === taskId && e.userId === userId).sort((a, b) => a.eventSeq - b.eventSeq);
  }

  async addProcedural(skill: { userId: string; name: string; steps: unknown; verifiedBy: "evaluator"; successRate?: number }): Promise<ProceduralSkill> {
    if (skill.verifiedBy !== "evaluator") throw new Error("Procedural 技能须经 evaluator 验证");
    const s: ProceduralSkill = { id: randomUUID(), userId: skill.userId, name: skill.name, steps: skill.steps, verifiedBy: "evaluator", successRate: skill.successRate ?? 0, createdAt: Date.now() };
    this.procedural.set(s.id, s);
    return s;
  }
  async listProcedural(userId: string): Promise<ProceduralSkill[]> {
    return [...this.procedural.values()].filter((s) => s.userId === userId);
  }
}