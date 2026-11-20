import type { LlmProvider } from "@/lib/llm/types";
import { configureAiAuth } from "@/lib/llm/transport";
import { createSupabaseClient } from "@/lib/data/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { localWorkspaceIdentity } from "@/lib/agent/local-workspace";

const env = import.meta.env as Record<string, string | undefined>;

export const runtime = env.VITE_RUNTIME ?? "local";
export const isCloudRuntime = runtime === "cloud";

export const appConfig = {
  supabaseUrl: env.VITE_SUPABASE_URL,
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY,
};

export const isDemo = !appConfig.supabaseUrl || !appConfig.supabaseAnonKey;

export const supabaseClient: SupabaseClient | null = isCloudRuntime || isDemo || localWorkspaceIdentity()
  ? null
  : createSupabaseClient(appConfig.supabaseUrl!, appConfig.supabaseAnonKey!);

configureAiAuth(async () => {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
});

// Model credentials never enter the browser; each result reports real provenance.
// Lazy import breaks the config -> provider -> Task API -> config initialization cycle.
export const llmProvider: LlmProvider = { name: "auto", mock: false, async extractNotice(req) { const { BrowserProvider } = await import("@/lib/llm/browser"); return new BrowserProvider().extractNotice(req); } };
