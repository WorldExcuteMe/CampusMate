// Agent Benchmark 类型。确定性验证为主，关键业务字段不用 LLM-as-judge。
import type { ChatResult, ToolDef } from "../../src/core/types.ts";

export type BenchmarkCategory = "planning" | "long_horizon" | "environment" | "tool_reliability" | "recovery" | "evidence" | "personalization";

export interface BenchmarkCheck { name: string; required: boolean; fn: (ctx: BenchmarkRunContext) => boolean; }

export interface BenchmarkRunContext {
  reply: string;
  actions: string[];
  toolCalls: number;
  mock: boolean;
  budgetExceeded: boolean;
  paused: boolean;
  rounds: number;
  evidenceVerified?: number;
  certificatePassed?: boolean;
  recovered?: boolean;
  output?: Record<string, unknown>;
}

export interface BenchmarkCase {
  id: string;
  category: BenchmarkCategory;
  userGoal: string;
  environment: string;
  initialContext: Record<string, unknown>;
  availableCapabilities: string[];
  expectedOutputs: string[];
  acceptanceCriteria: string[];
  expectedEvidence: string[];
  failureConditions: string[];
  evaluationMethod: "deterministic" | "integration" | "manual_realworld";
  // 执行配置（deterministic/integration）：scripted transport + mock tools。
  script?: Partial<ChatResult>[];
  tools?: ToolDef[];
  toolImpl?: (name: string, args: Record<string, unknown>) => Promise<string>;
  budget?: { tokens: number; toolCalls: number; wallMs: number; costUsd: number };
  checks?: BenchmarkCheck[];
  // manual_realworld：需开发者真实环境，runner 标 BLOCKED_EXTERNAL。
}

export interface BenchmarkResult {
  id: string; category: BenchmarkCategory; passed: boolean;
  checks: { name: string; passed: boolean; required: boolean }[];
  status: "VERIFIED" | "FAILED" | "BLOCKED_EXTERNAL";
  costUsd: number; durationMs: number; toolCalls: number; humanIntervention: number;
  failureReason?: string;
}

export interface BenchmarkMetrics {
  total: number; verified: number; failed: number; blocked: number;
  endToEndSuccessRate: number;
  byCategory: Record<string, { total: number; passed: number; rate: number }>;
  evidenceCoverage: number;
  recoverySuccessRate: number;
  environmentGeneralizationRate: number;
  humanInterventionRate: number;
  avgCostUsd: number; avgDurationMs: number;
}