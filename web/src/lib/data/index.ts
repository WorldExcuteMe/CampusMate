import { DemoRepository } from "./demo";
import { createSupabaseClient, SupabaseRepository } from "./supabase";
import type { Repository } from "./types";

export interface DataConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  userId?: string;
}

export function getRepository(cfg: DataConfig): Repository {
  if (cfg.supabaseUrl && cfg.supabaseAnonKey && cfg.userId) {
    const client = createSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    return new SupabaseRepository(client, cfg.userId);
  }
  return new DemoRepository();
}

export * from "./types";
export { DemoRepository, resetDemo } from "./demo";
