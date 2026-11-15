// Environment Manifest：任务开始前生成，决定本任务可用工具集。
// 能力缺失必须被发现并替代/调整/请求补充/明确报告，禁止假装具备。
import type { Budget, Runtime } from "./types.ts";
import type { CapabilityRegistry, CapabilityId, HealthStatus } from "./capability.ts";
import { HOST_CAPABILITY_TOOLS } from "./capability.ts";
import type { CompanionRegistry } from "./companion.ts";

export interface ManifestCapability { id: CapabilityId; available: boolean; health: HealthStatus; runtime: Runtime; tools: string[]; scope?: Record<string, unknown>; }

export interface EnvironmentManifest {
  userId: string;
  taskId: string;
  locale: string;
  timezone: string;
  institution?: string;
  runtime: Runtime;
  capabilities: ManifestCapability[];
  permissions: { approvalRequired: string[]; grantedScopes: string[] };
  quotas: Budget;
  generatedAt: number;
}

export interface BuildManifestOpts {
  registry: CapabilityRegistry;
  companion?: CompanionRegistry;
  userId: string;
  taskId: string;
  budget: Budget;
  institution?: string;
  locale?: string;
  timezone?: string;
}

// 生成 Manifest：云端默认能力 + Companion 注册后叠加该用户授权的本机能力。
export function buildManifest(opts: BuildManifestOpts): EnvironmentManifest {
  const caps: ManifestCapability[] = [];
  for (const { provider, health } of opts.registry.list()) {
    caps.push({ id: provider.id, available: health.available, health, runtime: provider.runtime, tools: provider.tools });
  }
  // Companion 叠加（仅该用户）。
  const reg = opts.companion?.resolve(opts.userId);
  if (reg) {
    for (const cap of reg.capabilities) {
      const id = cap as CapabilityId;
      if (!caps.some((c) => c.id === id)) {
        caps.push({ id, available: true, health: { available: true, checkedAt: Date.now() }, runtime: "local-companion", tools: HOST_CAPABILITY_TOOLS[cap] ?? [], scope: { grantedScopes: reg.grantedScopes } });
      }
    }
  }
  const approvalRequired = caps.filter((c) => c.runtime === "local-companion" || c.id === "db.write_global").flatMap((c) => c.tools);
  return {
    userId: opts.userId,
    taskId: opts.taskId,
    locale: opts.locale ?? "zh-CN",
    timezone: opts.timezone ?? "Asia/Shanghai",
    institution: opts.institution,
    runtime: reg ? "local-companion" : "cloud",
    capabilities: caps,
    permissions: { approvalRequired, grantedScopes: reg ? Object.keys(reg.grantedScopes) : [] },
    quotas: opts.budget,
    generatedAt: Date.now(),
  };
}

// 能力缺失替代表（缺失→可用替代）。
export const ALTERNATIVES: Partial<Record<CapabilityId, CapabilityId>> = {
  "ingest.qq": "web.search",
  "ingest.wechat": "web.search",
  "rag.search": "web.search",
  "host.fs.read": "web.fetch",
};

export type Resolution =
  | { use: CapabilityId; note?: string }
  | { unavailable: true; reason: string; action: "request_user_or_report" };

export function manifestHas(manifest: EnvironmentManifest, id: CapabilityId): boolean {
  return manifest.capabilities.some((c) => c.id === id && c.available);
}

// 能力解析：可用→用；缺失→替代；无替代→明确报告不可用（禁止假装）。
export function resolveCapability(manifest: EnvironmentManifest, needed: CapabilityId): Resolution {
  if (manifestHas(manifest, needed)) return { use: needed };
  const alt = ALTERNATIVES[needed];
  if (alt && manifestHas(manifest, alt)) return { use: alt, note: `${needed} 不可用，替代为 ${alt}` };
  const c = manifest.capabilities.find((x) => x.id === needed);
  return { unavailable: true, reason: c?.health.reason ?? "能力未注册", action: "request_user_or_report" };
}

// Manifest 可用工具名集合（确定性门控用）。
export function manifestToolNames(manifest: EnvironmentManifest): Set<string> {
  const set = new Set<string>();
  for (const c of manifest.capabilities) if (c.available) for (const t of c.tools) set.add(t);
  return set;
}