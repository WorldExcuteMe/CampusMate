import { getProvider, resolveConfig, type LlmProvider } from "@/lib/llm";
import { getRepository, type Repository } from "@/lib/data";
import { createSupabaseClient } from "@/lib/data/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

const env = import.meta.env as Record<string, string | undefined>;

export const appConfig = {
  supabaseUrl: env.VITE_SUPABASE_URL,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
};

export const isDemo = !appConfig.supabaseUrl || !appConfig.supabaseAnonKey;

export const supabaseClient: SupabaseClient | null = isDemo
  ? null
  : createSupabaseClient(appConfig.supabaseUrl!, appConfig.supabaseAnonKey!);

// 会话绑定：AuthProvider 登录后切换为 SupabaseRepository（按 auth.uid 隔离）。
export let repository: Repository = getRepository({});

export function setRepository(r: Repository): void {
  repository = r;
}

// 浏览器端始终使用明确标识的 Mock Provider；真实模型经服务端代理/Edge Function，
// API Key 不落前端（见 docs/AGENT_DESIGN.md / SECURITY.md）。
export const llmProvider: LlmProvider = getProvider(
  resolveConfig({ LLM_PROVIDER: "mock" }),
);