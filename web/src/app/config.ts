import { BrowserProvider } from "@/lib/llm/browser";
import { configureAiAuth } from "@/lib/llm/transport";
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

configureAiAuth(async () => {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
});

// Model credentials never enter the browser; each result reports real provenance.
export const llmProvider = new BrowserProvider();
