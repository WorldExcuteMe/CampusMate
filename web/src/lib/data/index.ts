import { DemoRepository } from "./demo";
import { createSupabaseClient, SupabaseRepository } from "./supabase";
import type { Repository } from "./types";

export interface DataConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  userId?: string;
}

let cached: Repository | null = null;

export function getRepository(cfg: DataConfig): Repository {
  if (cached) return cached;
  if (cfg.supabaseUrl && cfg.supabaseAnonKey && cfg.userId) {
    const client = createSupabaseClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    cached = new SupabaseRepository(client, cfg.userId);
  } else {
    cached = new DemoRepository();
  }
  return cached;
}

export function resetRepository(): void {
  cached = null;
}

export * from "./types";
export { DemoRepository, resetDemo } from "./demo";