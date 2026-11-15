import type { NormalizedLlmUsage } from "./types.ts";
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeUsage(raw: any): NormalizedLlmUsage {
  const inputTotal = number(raw?.prompt_tokens);
  const output = number(raw?.completion_tokens);
  const reasoning = number(raw?.completion_tokens_details?.reasoning_tokens);
  const rawCounts: Record<string, unknown> = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"]) if (number(raw?.[key]) !== null) rawCounts[key] = raw[key];
  for (const key of ["prompt_tokens_details", "completion_tokens_details"]) {
    if (!raw?.[key] || typeof raw[key] !== "object") continue;
    rawCounts[key] = Object.fromEntries(Object.entries(raw[key]).filter(([, value]) => number(value) !== null));
  }
  return { inputTotal, output, reasoning, cacheRead: number(raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens), cacheWrite: number(raw?.prompt_tokens_details?.cache_write_tokens), reasoningIncludedInOutput: reasoning !== null && output !== null ? true : null, costUsd: null, source: inputTotal !== null && output !== null ? "reported" : "unknown", raw: Object.keys(rawCounts).length ? rawCounts : null };
}
