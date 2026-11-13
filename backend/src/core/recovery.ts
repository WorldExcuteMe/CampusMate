// RecoveryEngine：按 ErrorClass 选择差异化恢复策略，有限重试/重规划，禁止无限循环。
// 策略：retry/backoff/repair/alternate/replan/pause/stop/reexecute。
import type { ErrorClass } from "./types.ts";

export type RecoveryAction = "retry" | "backoff" | "repair" | "alternate" | "replan" | "pause" | "stop" | "reexecute";

export interface RecoveryDecision {
  action: RecoveryAction;
  delayMs: number;
  reason: string;
  exhausted?: boolean; // 达到上限 → 升级为 stop/pause
}

export interface RecoveryLimits { maxRetries: number; maxReplans: number; maxReexecutes: number; baseDelayMs: number; }
export const DEFAULT_LIMITS: RecoveryLimits = { maxRetries: 3, maxReplans: 2, maxReexecutes: 2, baseDelayMs: 500 };

export interface RecoveryState { retries: number; replans: number; reexecutes: number; }
export function initialRecoveryState(): RecoveryState { return { retries: 0, replans: 0, reexecutes: 0 }; }

// 错误类型 → 基础策略（不含计数上限）。
function baseStrategy(cls: ErrorClass): { action: RecoveryAction; reason: string } {
  switch (cls) {
    case "transport": return { action: "backoff", reason: "网络临时故障：有限重试+指数退避" };
    case "rate_limit": return { action: "backoff", reason: "Rate Limit：等待退避" };
    case "invalid_model_output": return { action: "repair", reason: "模型输出异常：修复或重新请求" };
    case "tool_transient": return { action: "retry", reason: "工具临时故障：有限重试" };
    case "tool_permanent": return { action: "alternate", reason: "工具永久故障：替代工具或重新规划" };
    case "permission": return { action: "pause", reason: "权限不足：暂停并请求用户授权" };
    case "budget": return { action: "stop", reason: "预算超限：停止并交付已有结果" };
    case "evaluation": return { action: "reexecute", reason: "验收失败：分析差距，有限次数重新执行" };
    default: return { action: "stop", reason: "未知错误：停止" };
  }
}

export class RecoveryEngine {
  private limits: RecoveryLimits;
  constructor(limits: Partial<RecoveryLimits> = {}) { this.limits = { ...DEFAULT_LIMITS, ...limits }; }

  // 决策并推进计数。retry/backoff/repair 共用 retries；alternate→replan 共用 replans；reexecute 独立。
  decide(cls: ErrorClass, state: RecoveryState): RecoveryDecision {
    const base = baseStrategy(cls);
    const L = this.limits;
    if (base.action === "pause" || base.action === "stop") return { ...base, delayMs: 0 };

    if (base.action === "backoff" || base.action === "retry" || base.action === "repair") {
      if (state.retries >= L.maxRetries) return { action: "stop", delayMs: 0, reason: `${base.reason}；重试已达上限 ${L.maxRetries}`, exhausted: true };
      state.retries++;
      const delay = base.action === "backoff" ? Math.min(10000, L.baseDelayMs * 2 ** (state.retries - 1)) : 0;
      return { ...base, delayMs: delay };
    }
    if (base.action === "alternate" || base.action === "replan") {
      if (state.replans >= L.maxReplans) return { action: "stop", delayMs: 0, reason: `${base.reason}；重规划已达上限 ${L.maxReplans}`, exhausted: true };
      state.replans++;
      return { action: "replan", delayMs: 0, reason: base.reason };
    }
    // reexecute（验收失败）
    if (state.reexecutes >= L.maxReexecutes) return { action: "pause", delayMs: 0, reason: `${base.reason}；重新执行已达上限 ${L.maxReexecutes}，请求用户决策`, exhausted: true };
    state.reexecutes++;
    return { ...base, delayMs: 0 };
  }
}