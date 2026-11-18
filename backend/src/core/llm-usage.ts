import type { NormalizedLlmUsage } from "./types.ts";
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeUsage(raw: any): NormalizedLlmUsage {
  const inputTotal = number(raw?.prompt_tokens);
  const output = number(raw?.completion_tokens);
  const reasoning = number(raw?.completion_tokens_details?.reasoning_tokens);
  const rawCounts: Record<string, unknown> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens", "cost", "total_cost"]) if (number(raw?.[key]) !== null) rawCounts[key] = raw[key];
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
    if (!raw?.[key] || typeof raw[key] !== "object") continue;
    rawCounts[key] = Object.fromEntries(Object.entries(raw[key]).filter(([, value]) => number(value) !== null));
  }
  // 供应商若在响应用量里直接给出 USD 金额（如 AMD Radeon Cloud 的 usage.cost），按原值记录，
  // 让 costUsd 预算维度可用；未提供时保持 null（未知），不按猜测价格折算。
  const reportedCost = number(raw?.cost) ?? number(raw?.total_cost);
  return { inputTotal, output, reasoning, cacheRead: number(raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens), cacheWrite: number(raw?.prompt_tokens_details?.cache_write_tokens), reasoningIncludedInOutput: reasoning !== null && output !== null ? true : null, costUsd: reportedCost, source: inputTotal !== null && output !== null ? "reported" : "unknown", raw: Object.keys(rawCounts).length ? rawCounts : null };
}
