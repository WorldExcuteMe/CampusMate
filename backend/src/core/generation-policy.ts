export type ReasoningPreference = "auto" | "low" | "medium" | "high";
export type GenerationStage = "plan" | "verify" | "write" | "simple";
export function stageForIntent(intent: string): GenerationStage {
  if (/核验|矛盾|检查|验证|审查/.test(intent)) return "verify";
  if (/策划|规划|方案|计划书|研究报告|复杂|推导|代码/.test(intent)) return "plan";
  if (/正文|格式|排版|导出/.test(intent)) return "write";
  return "simple";
}
export function generationPolicy(caps: Record<string, unknown>, preference: string | undefined, stage: GenerationStage, outputTokens: number) {
  const requested = ["auto", "low", "medium", "high"].includes(preference ?? "") ? preference! : "auto";
  let tier = requested === "auto" ? (stage === "plan" || stage === "verify" ? "high" : "low") : requested;
  const constrained = outputTokens < 1024 && tier === "high";
  if (constrained) tier = "medium";
  const family = String(caps.reasoning ?? "unknown");
  const params: Record<string, unknown> = family === "reasoning_effort" ? { reasoning_effort: tier } : family === "enable_thinking" ? { enable_thinking: tier !== "low" } : {};
  const effective = family === "reasoning_effort" ? tier : family === "enable_thinking" ? (tier === "low" ? "off" : "on") : null;
  const reason = effective === null ? "端点未确认可调参数，未发送思考控制" : constrained ? "输出预算不足，限制思考档位" : family === "enable_thinking" ? "接口仅支持思考开关" : requested === "auto" ? `按${stage}阶段选择` : "采用用户偏好";
  return { requested, effective, family, stage, reason, params };
}
