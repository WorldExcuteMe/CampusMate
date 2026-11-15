import { randomUUID } from "node:crypto";
import type { AppendSessionMessage, ArtifactStore, ArtifactWrite, ProviderStore, ProviderWrite, SessionStore, StoredArtifact, StoredProvider, StoredSession, StoredSessionMessage } from "../core/storage-contracts.ts";
import { InMemoryPersonalContextStore, type CourseSchedule, type ImportJob, type ScheduleException } from "../core/personal-context.ts";
import { InMemoryApprovalStore } from "./approval.ts";
import { InMemoryEvidenceStore } from "../core/evidence.ts";
import { assertSecret, messageEnvelope, requireUuid, sameJson, validateArtifact } from "./postgres-shared.ts";
import type { TaskStore } from "./store.ts";
import { SessionManagementError, validateSessionPatch, validateLegacyMessages, unfinishedSessionTask, type SessionPatch, type LegacyMessage } from '../core/session-management.ts';
import { canonicalArgs } from './idempotency.ts';

async function ownedTask(tasks: TaskStore, userId: string, taskId: string, sessionId?: string) {
  const task = await tasks.getTask(taskId);
  if (!task || task.userId !== userId || (sessionId !== undefined && task.sessionId !== sessionId)) throw new Error("Task owner/session forbidden");
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  private messages = new Map<string, StoredSessionMessage[]>();
  private tasks: TaskStore;
  private legacy = new Map<string, LegacyMessage[]>();
  constructor(tasks: TaskStore) { this.tasks = tasks; }
  forkForTask(tasks: TaskStore, sessionId: string): MemorySessionStore {
    const staged = new MemorySessionStore(tasks);
    const parent = this.sessions.get(sessionId);
    if (parent) staged.sessions.set(sessionId, structuredClone(parent));
    staged.messages.set(sessionId, structuredClone(this.messages.get(sessionId) ?? []));
    return staged;
  }
  commitSession(sessionId: string, staged: MemorySessionStore): void {
    const parent = staged.sessions.get(sessionId);
    if (!parent) throw new Error("Session owner forbidden");
    const current = this.sessions.get(sessionId);
    if (current?.deletedAt) throw new SessionManagementError('会话已删除');
    this.sessions.set(sessionId, structuredClone({ ...parent, ...(current ? { title: current.title, mode: current.mode, archived: current.archived, deletedAt: current.deletedAt, revision: current.revision } : {}) }));
    this.messages.set(sessionId, structuredClone(staged.messages.get(sessionId) ?? []));
  }
  async create(input: { userId: string; id?: string; title?: string; mode?: "auto" | "daily" }): Promise<StoredSession> {
    const id = input.id ?? randomUUID(); requireUuid(id);
    const existing = this.sessions.get(id);
    if (existing) { if (existing.userId !== input.userId) throw new Error("Session owner forbidden"); if (existing.deletedAt) throw new SessionManagementError('会话已删除，请新建会话'); return structuredClone(existing); }
    const now = Date.now();
    const session: StoredSession = { id, userId: input.userId, title: input.title ?? "新会话", mode: input.mode ?? "auto", summaryThroughSeq: 0, createdAt: now, updatedAt: now };
    this.sessions.set(id, session); return structuredClone(session);
  }
  async get(userId: string, id: string) { const s = this.sessions.get(id); return s?.userId === userId ? structuredClone(s) : null; }
  async list(userId: string) { return structuredClone([...this.sessions.values()].filter((s) => s.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt)); }
  async patch(userId: string, id: string, patch: SessionPatch) {
    validateSessionPatch(patch); const s = this.sessions.get(id);
    if (!s || s.userId !== userId || s.deletedAt) throw new SessionManagementError('会话不存在或已删除', 404);
    if ((s.revision ?? 0) !== patch.expectedRevision) throw new SessionManagementError('会话已被其他窗口修改，请刷新后重试');
    Object.assign(s, { ...(patch.title !== undefined ? { title: patch.title.trim() } : {}), ...(patch.mode !== undefined ? { mode: patch.mode } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}), revision: (s.revision ?? 0) + 1, updatedAt: Date.now() }); return structuredClone(s);
  }
  async remove(userId: string, id: string, expectedRevision: number) {
    validateSessionPatch({ expectedRevision });
    const work = async () => { const s = this.sessions.get(id);
      if (!s || s.userId !== userId) throw new SessionManagementError('会话不存在', 404);
      if (s.deletedAt) return structuredClone(s);
      if ((s.revision ?? 0) !== expectedRevision) throw new SessionManagementError('会话已被其他窗口修改，请刷新后重试');
      if ((await this.tasks.listTasksByUser(userId)).some(t => t.sessionId === id && unfinishedSessionTask(t))) throw new SessionManagementError('会话有未结束任务，请先完成或取消任务再删除');
      s.deletedAt = Date.now(); s.updatedAt = Date.now(); s.revision = (s.revision ?? 0) + 1; return structuredClone(s);
    };
    return this.tasks.sessionTransaction ? this.tasks.sessionTransaction(id, work) : work();
  }
  async importLegacy(userId: string, id: string, input: LegacyMessage[]) {
    const s = await this.get(userId, id); if (!s || s.deletedAt) throw new SessionManagementError('会话不存在或已删除', 404);
    const messages = validateLegacyMessages(input), old = this.legacy.get(id);
    if (old && canonicalArgs(old) !== canonicalArgs(messages)) throw new SessionManagementError('云端已有不同的导入记录，本地备份已保留');
    this.legacy.set(id, structuredClone(messages));
  }
  async legacyHistory(userId: string, id: string) { const s = await this.get(userId, id); return s && !s.deletedAt ? structuredClone(this.legacy.get(id) ?? []) : []; }
  async appendMessage(input: AppendSessionMessage): Promise<StoredSessionMessage> {
    requireUuid(input.sessionId);
    const parent = await this.get(input.userId, input.sessionId); if (!parent || parent.deletedAt) throw new Error("Session owner forbidden");
    if (input.taskId) await ownedTask(this.tasks, input.userId, input.taskId, input.sessionId);
    if (!input.turnId || !input.messageKey) throw new Error("Message requires stable turn/key");
    const rows = this.messages.get(input.sessionId) ?? [];
    const existing = rows.find((m) => m.messageKey === input.messageKey);
    if (existing) {
      if (existing.turnId !== input.turnId || existing.taskId !== input.taskId || !sameJson(messageEnvelope(existing), messageEnvelope(input))) throw new Error("Message key conflict");
      return structuredClone(existing);
    }
    const row = { ...structuredClone(input), id: randomUUID(), seq: rows.length + 1, createdAt: Date.now() };
    this.messages.set(input.sessionId, [...rows, row]); this.sessions.get(input.sessionId)!.updatedAt = row.createdAt;
    return structuredClone(row);
  }
  async listMessages(userId: string, sessionId: string, afterSeq = 0) { return await this.get(userId, sessionId) ? structuredClone((this.messages.get(sessionId) ?? []).filter((m) => m.seq > afterSeq)) : []; }
  async updateSummary(userId: string, sessionId: string, summary: string, throughSeq: number) {
    const s = this.sessions.get(sessionId); if (s?.userId !== userId) return null;
    if (!Number.isInteger(throughSeq) || throughSeq < s.summaryThroughSeq || throughSeq > (this.messages.get(sessionId)?.length ?? 0)) throw new Error("Invalid summary sequence");
    const next = { ...s, summary, summaryThroughSeq: throughSeq, updatedAt: Date.now() }; this.sessions.set(sessionId, next); return structuredClone(next);
  }
}

export class MemoryProviderStore implements ProviderStore {
  private items = new Map<string, StoredProvider>();
  async upsert(input: ProviderWrite): Promise<StoredProvider> {
    assertSecret(input.encryptedSecret);
    if (!input.providerId || !input.modelId || !input.baseUrl) throw new Error("Provider configuration incomplete");
    const key = `${input.userId}|${input.providerId}`; const old = this.items.get(key); const now = Date.now();
    const next: StoredProvider = { ...input, contextLimit: input.contextLimit === null ? undefined : input.contextLimit ?? old?.contextLimit, capabilities: structuredClone(input.capabilities ?? old?.capabilities ?? {}), metadataSource: input.metadataSource ?? old?.metadataSource ?? "configured", encryptedSecret: input.removeSecret ? undefined : structuredClone(input.encryptedSecret ?? old?.encryptedSecret), isDefault: input.isDefault ?? old?.isDefault ?? false, createdAt: old?.createdAt ?? now, updatedAt: now };
    if (next.isDefault) for (const p of this.items.values()) if (p.userId === input.userId) p.isDefault = false;
    this.items.set(key, next); return structuredClone(next);
  }
  async get(userId: string, providerId: string) { return structuredClone(this.items.get(`${userId}|${providerId}`) ?? null); }
  async list(userId: string) { return structuredClone([...this.items.values()].filter((p) => p.userId === userId)); }
  async delete(userId: string, providerId: string) { return this.items.delete(`${userId}|${providerId}`); }
}

export class MemoryArtifactStore implements ArtifactStore {
  private items = new Map<string, StoredArtifact>(); private tasks: TaskStore;
  constructor(tasks: TaskStore) { this.tasks = tasks; }
  async create(input: ArtifactWrite): Promise<StoredArtifact> {
    await ownedTask(this.tasks, input.userId, input.taskId); validateArtifact(input);
    const documentId = input.documentId ?? randomUUID(); requireUuid(documentId); const revision = input.revision ?? 1;
    const old = [...this.items.values()].find((a) => a.taskId === input.taskId && a.documentId === documentId && a.revision === revision);
    if (old) { if (old.sha256 !== input.sha256 || !sameJson(old.inline, input.inline) || old.storagePath !== input.storagePath || old.kind !== input.kind) throw new Error("Artifact revision conflict"); return structuredClone(old); }
    const next: StoredArtifact = { ...structuredClone(input), id: randomUUID(), documentId, revision, createdAt: Date.now() }; this.items.set(next.id, next); return structuredClone(next);
  }
  async get(userId: string, id: string) { const a = this.items.get(id); return a?.userId === userId ? structuredClone(a) : null; }
  async listByTask(userId: string, taskId: string) { return structuredClone([...this.items.values()].filter((a) => a.userId === userId && a.taskId === taskId).sort((a, b) => a.revision - b.revision)); }
}

export class ValidatedMemoryApprovalStore extends InMemoryApprovalStore {
  private tasks: TaskStore;
  constructor(tasks: TaskStore) { super(); this.tasks = tasks; }
  override async create(input: Parameters<InMemoryApprovalStore["create"]>[0]) { await ownedTask(this.tasks, input.userId, input.taskId); return super.create(input); }
}
export class ValidatedMemoryEvidenceStore extends InMemoryEvidenceStore {
  private tasks: TaskStore;
  private artifacts: ArtifactStore;
  constructor(tasks: TaskStore, artifacts: ArtifactStore) { super(); this.tasks = tasks; this.artifacts = artifacts; }
  override async add(input: Parameters<InMemoryEvidenceStore["add"]>[0]) {
    await ownedTask(this.tasks, input.userId, input.taskId);
    if (input.artifactId) {
      const artifact = await this.artifacts.get(input.userId, input.artifactId);
      if (!artifact || artifact.taskId !== input.taskId) throw new Error("Artifact owner/task forbidden");
    }
    return super.add(input);
  }
}
export class ValidatedMemoryPersonalContextStore extends InMemoryPersonalContextStore {
  private async term(userId: string, termId: string) { if (!(await this.listTerms(userId)).some((t) => t.id === termId)) throw new Error("Term owner forbidden"); }
  override async saveSchedules(userId: string, termId: string, rows: Omit<CourseSchedule, "id" | "userId" | "termId">[]) { await this.term(userId, termId); return super.saveSchedules(userId, termId, rows); }
  override async addException(input: Omit<ScheduleException, "id">) {
    await this.term(input.userId, input.termId);
    if (input.scheduleId && !(await this.listSchedules(input.userId, input.termId)).some((s) => s.id === input.scheduleId)) throw new Error("Schedule owner forbidden");
    return super.addException(input);
  }
  override async createImportJob(input: Omit<ImportJob, "id">) { await this.term(input.userId, input.termId); return super.createImportJob(input); }
  override async updateImportJob(id: string, patch: Partial<ImportJob>) {
    if (!patch.userId) throw new Error("Import job owner required");
    const old = this.jobs.get(id);
    if (!old || old.userId !== patch.userId) return null;
    if (patch.termId && patch.termId !== old.termId) throw new Error("Import job term forbidden");
    return super.updateImportJob(id, { status: patch.status ?? old.status, previewCount: patch.previewCount ?? old.previewCount, errorCount: patch.errorCount ?? old.errorCount, version: patch.version ?? old.version });
  }
}
