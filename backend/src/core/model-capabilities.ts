// Endpoint contracts, not model-name guesses. Runtime observations/probing are
// separate work; unknown stays unknown unless a matching contract supplies it.
export function normalizeCapabilities(input: unknown): Record<string, unknown> {
  const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  const enums: Record<string, unknown[]> = { tools: ["native", "json", "none", "unknown"], vision: [true, false, "unknown"], streaming: [true, false, "unknown"], temperature: [true, false, "unknown"], reasoning: ["reasoning_effort", "enable_thinking", "chat_template_kwargs", "thinking_budget", "none", "unknown"], outputParameter: ["max_tokens", "max_completion_tokens", "unknown"] };
  for (const [key, values] of Object.entries(enums)) result[key] = values.includes(data[key]) ? data[key] : "unknown";
  if (typeof data.streamUsage === "boolean") result.streamUsage = data.streamUsage;
  if (typeof data.singleSystem === "boolean") result.singleSystem = data.singleSystem;
  if (Number.isSafeInteger(data.maxOutputTokens) && Number(data.maxOutputTokens) >= 256) result.maxOutputTokens = Number(data.maxOutputTokens);
  return result;
}
export function resolveModelCapabilities(baseUrl: string, modelId: string, input: unknown, contextLimit?: number | null) {
  const capabilities = normalizeCapabilities(input);
  let profile: string | undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "https:" && url.hostname === "developer.amd.com.cn" && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/+$/, "") === "/radeon/api/v1" && modelId.toLowerCase() === "gemma-4-31b-it") {
      // Radeon Cloud docs checked 2026-11-15. 8192 is our working output cap,
      // not a claim about the provider's maximum completion length.
      profile = "radeon-gemma4-v1";
      const defaults = { tools: "native", vision: true, streaming: true, temperature: true, reasoning: "chat_template_kwargs", outputParameter: "max_tokens", maxOutputTokens: 8192, singleSystem: true };
      for (const [key, value] of Object.entries(defaults)) if (capabilities[key] === undefined || capabilities[key] === "unknown") capabilities[key] = value;
      contextLimit ??= 262144;
    }
  } catch { /* Address validation remains at the existing provider boundary. */ }
  return { capabilities, contextLimit, profile };
}
