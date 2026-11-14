// 核验提案与 VERIFIED 落库门控。模型只产提案（status 建议 + 证据），不直接落 VERIFIED。
// 落库门控：evaluated_by=evaluator 且 evidence_count>=1 且全部证据 verified 才允许 VERIFIED。
import type { Evidence } from "./evidence.ts";

export type VerificationStatus = "VERIFIED" | "PARTIALLY_VERIFIED" | "UNVERIFIED" | "CONFLICTING" | "RISK_FLAGGED";

export interface VerificationProposal {
  opportunityId: string;
  proposedStatus: VerificationStatus;   // 模型建议（不被直接信任）
  summary: string;
  evidence: { sourceUrl: string; excerpt: string; supports: string; confidence?: number }[];
}

export interface VerificationRecord {
  opportunityId: string;
  status: VerificationStatus;
  summary: string;
  evaluatedBy: "pending" | "evaluator" | "human";
  evidenceCount: number;
  evidenceVerifiedCount: number;
}

// 模型自填 VERIFIED 一律降级为 UNVERIFIED（提案不被直接信任）。
export function sanitizeProposedStatus(proposed: VerificationStatus): VerificationStatus {
  return proposed === "VERIFIED" ? "UNVERIFIED" : proposed;
}

// 落库门控：VERIFIED 仅当 Evaluator 核验且 ≥1 条全部 verified 的证据。
export function canPersistVerified(record: { evaluatedBy: string; evidenceCount: number; evidenceVerifiedCount: number }): boolean {
  return record.evaluatedBy === "evaluator" && record.evidenceCount >= 1 && record.evidenceVerifiedCount === record.evidenceCount && record.evidenceVerifiedCount >= 1;
}

// 由 Evaluator 核验后的证据决定最终落库状态。
export function resolveVerifiedStatus(proposed: VerificationStatus, verifiedEvidence: Evidence[]): { status: VerificationStatus; evaluatedBy: "evaluator"; evidenceCount: number; evidenceVerifiedCount: number } {
  const evidenceCount = verifiedEvidence.length;
  const evidenceVerifiedCount = verifiedEvidence.filter((e) => e.verified).length;
  const record = { evaluatedBy: "evaluator" as const, evidenceCount, evidenceVerifiedCount };
  let status: VerificationStatus;
  if (proposed === "CONFLICTING" || proposed === "RISK_FLAGGED") status = proposed; // 风险/冲突保留
  else if (canPersistVerified(record)) status = "VERIFIED";
  else if (evidenceVerifiedCount > 0) status = "PARTIALLY_VERIFIED";
  else status = "UNVERIFIED";
  return { status, evaluatedBy: "evaluator", evidenceCount, evidenceVerifiedCount };
}

// 冲突检测：两个来源对同一字段（如截止）给出不同值 → CONFLICTING。
export function detectConflict(values: string[]): boolean {
  const distinct = new Set(values.filter((v) => v != null && v !== ""));
  return distinct.size > 1;
}