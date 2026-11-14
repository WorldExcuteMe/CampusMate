// Capability Registry：能力以 Provider 注册，按 runtime 分类，健康检查。
// 云端默认 Provider 启动注册；本机 Provider 仅 Companion 注册后叠加该用户授权能力。
import type { Runtime } from "./types.ts";

export type CapabilityId =
  | "llm.chat" | "web.fetch" | "web.search" | "rag.search"
  | "db.read" | "db.write_user" | "db.write_global"
  | "ingest.qq" | "ingest.wechat" | "host.terminal" | "host.fs.read" | "host.fs.write";

export interface HealthStatus { available: boolean; latencyMs?: number; reason?: string; checkedAt: number; }

export interface CapabilityProvider {
  id: CapabilityId;
  runtime: Runtime;
  tools: string[];
  permissions: string[];
  healthCheck(): Promise<HealthStatus>;
}

export interface RegisteredCapability { provider: CapabilityProvider; health: HealthStatus; }

export class CapabilityRegistry {
  private providers = new Map<CapabilityId, CapabilityProvider>();
  private health = new Map<CapabilityId, HealthStatus>();

  register(provider: CapabilityProvider): void {
    this.providers.set(provider.id, provider);
    this.health.set(provider.id, { available: true, checkedAt: Date.now() });
  }
  unregister(id: CapabilityId): void { this.providers.delete(id); this.health.delete(id); }
  resolve(id: CapabilityId): CapabilityProvider | null { return this.providers.get(id) ?? null; }
  list(): RegisteredCapability[] {
    return [...this.providers.values()].map((p) => ({ provider: p, health: this.health.get(p.id) ?? { available: false, checkedAt: 0 } }));
  }
  has(id: CapabilityId): boolean { return this.providers.has(id); }
  async healthCheck(id: CapabilityId): Promise<HealthStatus> {
    const p = this.providers.get(id);
    if (!p) { const h: HealthStatus = { available: false, reason: "能力未注册", checkedAt: Date.now() }; this.health.set(id, h); return h; }
    const h = await p.healthCheck();
    this.health.set(id, h);
    return h;
  }
  async healthCheckAll(): Promise<RegisteredCapability[]> {
    for (const id of this.providers.keys()) await this.healthCheck(id);
    return this.list();
  }
  getHealth(id: CapabilityId): HealthStatus { return this.health.get(id) ?? { available: false, reason: "能力未注册", checkedAt: 0 }; }
}

// 云端默认 Provider（无本机依赖）。healthCheck 默认 available；llm.chat 由最近成功调用推断（此处基线 available）。
export function cloudProviders(): CapabilityProvider[] {
  const ok = async (): Promise<HealthStatus> => ({ available: true, checkedAt: Date.now() });
  const mk = (id: CapabilityId, tools: string[], permissions: string[]): CapabilityProvider => ({ id, runtime: "cloud", tools, permissions, healthCheck: ok });
  return [
    mk("llm.chat", [], ["read"]),
    mk("web.fetch", ["web_fetch"], ["read"]),
    mk("web.search", ["web_search"], ["read"]),
    mk("rag.search", ["rag_search"], ["read"]),
    mk("db.read", ["search_opportunities", "match_opportunities", "list_opportunities"], ["read"]),
    mk("db.write_user", ["save_to_inbox", "create_daily_task", "set_growth_goal", "merge_inbox", "save_opportunity"], ["write_user"]),
    mk("db.write_global", ["create_opportunity", "propose_verification"], ["write_global"]),
  ];
}

export function registerCloudDefaults(reg: CapabilityRegistry): void {
  for (const p of cloudProviders()) reg.register(p);
}

// 本机能力 → Companion 能力映射（注册时用）。
export const HOST_CAPABILITY_TOOLS: Record<string, string[]> = {
  "host.terminal": ["run_terminal"],
  "host.fs.read": ["read_file"],
  "host.fs.write": ["write_file"],
  "ingest.qq": ["sync_group_notices", "list_groups"],
  "ingest.wechat": ["sync_group_notices"],
};