import { MockProvider } from "./mock";
import { OpenAICompatibleProvider } from "./openai";
import type { LlmConfig, LlmProvider } from "./types";

export function resolveConfig(env: Record<string, string | undefined>): LlmConfig {
  return {
    provider: env.LLM_PROVIDER ?? "mock",
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  };
}

export function getProvider(cfg: LlmConfig): LlmProvider {
  if (cfg.provider === "mock" || !cfg.apiKey) return new MockProvider();
  return new OpenAICompatibleProvider(cfg);
}

export * from "./types";
export { MockProvider, ruleExtract, RISK_KEYWORDS } from "./mock";