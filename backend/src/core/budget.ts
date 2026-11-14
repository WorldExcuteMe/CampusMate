// Budget Controller：Tokens / Tool Calls / Wall Clock / Cost USD 四维硬停。
// 任一维度超限 → Runtime 强制停止，形成部分结果 + 剩余工作说明。
import type { Budget, Usage } from "./types.ts";

export type BudgetDimension = "tokens" | "toolCalls" | "wallMs" | "costUsd";

export interface BudgetCheck { exceeded: boolean; dimension?: BudgetDimension; remaining: Partial<Budget>; }

export function checkBudget(usage: Usage, budget: Budget): BudgetCheck {
  const remaining: Partial<Budget> = {
    tokens: Math.max(0, budget.tokens - usage.tokens),
    toolCalls: Math.max(0, budget.toolCalls - usage.toolCalls),
    wallMs: Math.max(0, budget.wallMs - usage.wallMs),
    costUsd: Math.max(0, budget.costUsd - usage.costUsd),
  };
  if (usage.tokens >= budget.tokens) return { exceeded: true, dimension: "tokens", remaining };
  if (usage.toolCalls >= budget.toolCalls) return { exceeded: true, dimension: "toolCalls", remaining };
  if (usage.wallMs >= budget.wallMs) return { exceeded: true, dimension: "wallMs", remaining };
  if (usage.costUsd >= budget.costUsd) return { exceeded: true, dimension: "costUsd", remaining };
  return { exceeded: false, remaining };
}

// 预算停止后的剩余工作说明（部分交付）。
export function budgetStopSummary(check: BudgetCheck, actionsDone: string[]): string {
  const dim = check.dimension ?? "budget";
  const done = actionsDone.length ? `已完成 ${actionsDone.length} 步：${actionsDone.join("；")}。` : "尚未完成有效步骤。";
  return `${done}因 ${dim} 预算超限停止。剩余预算：tokens=${check.remaining.tokens ?? 0} toolCalls=${check.remaining.toolCalls ?? 0} costUsd=${(check.remaining.costUsd ?? 0).toFixed(4)}。需提高预算或缩小任务后继续。`;
}