// 思考强度策略：本环境（学生 QQ/微信信息爬取 + 网页获取）的复杂度在"检索广度"（工具/来源），
// 不在"推理深度"。提取/分类/去重/路由/总结/检索 用 low 即足够且最省 token；
// 仅多源核验/冲突仲裁升级 medium。不按"最复杂任务=high"固定全局强度（那会让占多数的简单任务白烧 token）。
// 按模型映射为各厂商 OpenAI-compatible 端点实际接受的参数，避免下发非法参数导致 400。
export type ReasoningTier = "low" | "medium" | "high";
export const DEFAULT_REASONING: ReasoningTier = "low";

// 原生 thinking 预算上限（token），供原生适配器/文档使用；OpenAI-compat 仅下发安全参数。
export const THINKING_BUDGET: Record<ReasoningTier, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

export type AgentTask =
  | "extract" | "classify" | "route" | "summarize" | "dedupe" | "retrieve"
  | "verify" | "conflict";

export function tierForTask(task: AgentTask): ReasoningTier {
  return task === "verify" || task === "conflict" ? "medium" : DEFAULT_REASONING;
}

// 返回可安全合并进 OpenAI-compatible /chat/completions 请求体的思考参数。
export function reasoningParams(model: string | undefined, tier: ReasoningTier): Record<string, unknown> {
  const m = (model ?? "").toLowerCase();
  // OpenAI 推理系列：reasoning_effort 低/中/高
  if (/^(o1|o3|o4|gpt-5)/.test(m)) return { reasoning_effort: tier };
  // Qwen（dashscope compatible-mode）：enable_thinking 开关
  if (/qwen|qwq/.test(m)) return { enable_thinking: tier !== "low" };
  // DeepSeek：思考由模型选择决定（chat=非思考 / reasoner=思考），不下发非法 thinking 参数；
  // 默认配 deepseek-chat 即 low。Claude 原生 thinking 走原生适配器，OpenAI-compat 不下发。
  return {};
}