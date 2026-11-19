// Budget Controller：Tokens / Tool Calls / Wall Clock / Cost USD 四维硬停。
// 任一维度超限 → Runtime 强制停止，形成部分结果 + 剩余工作说明。
import type { Budget, Usage } from "./types.ts";
import { DEFAULT_BUDGET } from "./types.ts";
export function parseBudget(value: unknown, base: Budget): Budget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("任务预算必须为对象");
  const limits: Budget = { tokens: 4_000_000, toolCalls: 200, wallMs: 3_600_000, costUsd: 100 };
  const result = { ...base };
  for (const key of Object.keys(limits) as (keyof Budget)[]) {
    const v = (value as Record<string, unknown>)[key]; if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > limits[key]) throw new Error(`预算${key}超出允许范围`);
    result[key] = v;
  }
  return result;
}

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
  return `${done}因 ${dim} 预算超限停止。剩余预算：tokens=${check.remaining.tokens ?? 0} toolCalls=${check.remaining.toolCalls ?? 0} 时间=${check.remaining.wallMs ?? 0}ms。需提高预算或缩小任务后继续；未知价格时USD费用无法准确估计。`;
}
// 产品默认预算按任务类型自适应：编程/工具/研究/文档类重任务给足 token、工具次数与墙钟，
// 轻量问答用小预算，避免把 150k/35/20 这类固定值套到需要 35-60 次 API 调用的任务上
// （AppWorld/OfficeBench/Terminal-Bench 实测的主要限制因素之一）。
export function recommendedBudget(intent: string | undefined): Budget {
  const text = String(intent ?? "").trim();
  const heavy = /(?:编程|写代码|脚本|程序|终端|命令|仓库|测试|部署|编译|构建|重构|调试|研究|调研|报告|文档|导出|制作|整理|导入|批量|多步|分步骤|长任务|数据分析|实现|开发|代码|code|script|repo|build|deploy|debug|research|report|document|export|analy[sz]e|implement|develop|refactor|pipeline)/i.test(text);
  const light = text.length <= 40 && !heavy && /(?:你好|谢谢|是什么|怎么|多少|查询|查看|告诉我|解释|介绍|hi|hello|what|how|thanks)/i.test(text);
  if (heavy) return { tokens: 1_000_000, toolCalls: 120, wallMs: 1_800_000, costUsd: 2 };
  if (light) return { tokens: 120_000, toolCalls: 20, wallMs: 300_000, costUsd: 0.5 };
  return { ...DEFAULT_BUDGET };
}
