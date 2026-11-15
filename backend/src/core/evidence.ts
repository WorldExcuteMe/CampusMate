// 证据存储与验收契约。证据独立于压缩摘要存储；Evaluator 直接读原始证据核验。
// 执行 Agent 不得自判成功；VERIFIED 必须有独立核验过的证据。
import { randomUUID } from "node:crypto";
import type { AcceptanceCriterion } from "./types.ts";

export interface Evidence {
  id: string;
  taskId: string;
  userId: string;
  sourceUrl: string;
  excerpt: string;
  supports: string;
  confidence: number;
  retrievedAt: number;
  verified: boolean;        // Evaluator 独立核验后置 true
  artifactId?: string;
}

export interface EvidenceStore {
  add(input: { taskId: string; userId: string; sourceUrl: string; excerpt: string; supports: string; confidence?: number; artifactId?: string }): Promise<Evidence>;
  get(id: string): Promise<Evidence | null>;
  listByTask(taskId: string): Promise<Evidence[]>;
  markVerified(id: string, verified: boolean): Promise<Evidence | null>;
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private items = new Map<string, Evidence>();
  async add(input: { taskId: string; userId: string; sourceUrl: string; excerpt: string; supports: string; confidence?: number; artifactId?: string }): Promise<Evidence> {
    const e: Evidence = { id: randomUUID(), taskId: input.taskId, userId: input.userId, sourceUrl: input.sourceUrl, excerpt: input.excerpt, supports: input.supports, confidence: input.confidence ?? 0.5, retrievedAt: Date.now(), verified: false, artifactId: input.artifactId };
    this.items.set(e.id, e);
    return e;
  }
  async get(id: string): Promise<Evidence | null> { return this.items.get(id) ?? null; }
  async listByTask(taskId: string): Promise<Evidence[]> { return [...this.items.values()].filter((e) => e.taskId === taskId); }
  async markVerified(id: string, verified: boolean): Promise<Evidence | null> {
    const e = this.items.get(id);
    if (!e) return null;
    const next = { ...e, verified };
    this.items.set(id, next);
    return next;
  }
}

// 验收评估输入：产物/证据/结构化字段/计数/过期项/来源引用。
export interface EvaluationInput {
  artifacts: { id: string; kind: string; nonEmpty: boolean }[];
  evidence: Evidence[];
  fields: Record<string, unknown>;
  counts: Record<string, number>;
  expiredCount: number;
  citedSources: string[];
  reply: string;
}

export interface CriterionOutcome { id: string; passed: boolean; evidenceIds: string[]; note: string; }

// 单条验收判定（纯函数部分；evidence_verified 的重抓在 Evaluator 异步处理）。
export function evaluateCriterion(c: AcceptanceCriterion, input: EvaluationInput): CriterionOutcome {
  const p = c.params ?? {};
  switch (c.kind) {
    case "artifact_exists": {
      const kind = p.kind ? String(p.kind) : null;
      const hit = input.artifacts.filter((a) => a.nonEmpty && (!kind || a.kind === kind));
      return { id: c.id, passed: hit.length > 0, evidenceIds: hit.map((a) => a.id), note: hit.length ? "产物存在且非空" : "缺少非空产物" };
    }
    case "field_present": {
      const field = String(p.field ?? "");
      const v = input.fields[field];
      const ok = v !== undefined && v !== null && v !== "";
      return { id: c.id, passed: ok, evidenceIds: [], note: ok ? `字段 ${field} 存在` : `缺少字段 ${field}` };
    }
    case "count_min": {
      const key = String(p.key ?? "");
      const min = Number(p.min ?? 1);
      const n = input.counts[key] ?? 0;
      return { id: c.id, passed: n >= min, evidenceIds: [], note: `${key}=${n}（需≥${min}）` };
    }
    case "no_expired": {
      return { id: c.id, passed: input.expiredCount === 0, evidenceIds: [], note: input.expiredCount === 0 ? "无过期项" : `含 ${input.expiredCount} 过期项` };
    }
    case "source_cited": {
      const ok = input.citedSources.length > 0;
      return { id: c.id, passed: ok, evidenceIds: [], note: ok ? `引用 ${input.citedSources.length} 来源` : "未引用来源" };
    }
    case "evidence_verified": {
      // 异步重抓核验在 Evaluator 处理；此处仅检查是否有证据候选。
      const min = Number(p.min ?? 1);
      const ok = input.evidence.length >= min;
      return { id: c.id, passed: ok, evidenceIds: input.evidence.map((e) => e.id), note: ok ? "有证据候选（待独立核验）" : "缺少证据" };
    }
    default:
      return { id: c.id, passed: false, evidenceIds: [], note: `未知验收类型 ${c.kind}` };
  }
}