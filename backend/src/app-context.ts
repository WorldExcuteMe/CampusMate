// 共享装配：API 与 Worker 独立进程复用同一套 Core/Contracts/Store。
// 生产守卫：NODE_ENV=production 必须有 DATABASE_URL（Postgres），否则明确失败，绝不静默降级 InMemory。
import { createApiServer } from "./api/server.ts";
import { InMemoryStore, type TaskStore } from "./runtime/store.ts";
import { PostgresStore } from "./runtime/postgres-store.ts";
import { PgPool, connectionStringFromEnv } from "./runtime/sql.ts";
import { InMemoryApprovalStore, type ApprovalStore } from "./runtime/approval.ts";
import { CompanionRegistry } from "./core/companion.ts";
import { InMemoryEvidenceStore, type EvidenceStore } from "./core/evidence.ts";
import { CapabilityRegistry, registerCloudDefaults } from "./core/capability.ts";
import { InMemoryMemoryStore, type MemoryStore } from "./core/memory.ts";
import { InMemoryPersonalContextStore, type PersonalContextStore } from "./core/personal-context.ts";

export interface AppContext {
  store: TaskStore;
  approvals: ApprovalStore;
  companion: CompanionRegistry;
  evidenceStore: EvidenceStore;
  capabilityRegistry: CapabilityRegistry;
  memoryStore: MemoryStore;
  personalContext: PersonalContextStore;
  storeKind: "postgres" | "memory";
}

export class ProductionDbRequiredError extends Error {
  constructor() { super("生产环境必须配置 DATABASE_URL（Postgres）；不允许静默降级 InMemory。"); this.name = "ProductionDbRequiredError"; }
}

export function buildContext(env: Record<string, string | undefined>): AppContext {
  const conn = connectionStringFromEnv(env);
  const isProd = env.NODE_ENV === "production";
  if (isProd && !conn) throw new ProductionDbRequiredError();
  const store: TaskStore = conn ? new PostgresStore(new PgPool(conn)) : new InMemoryStore();
  const capabilityRegistry = new CapabilityRegistry();
  registerCloudDefaults(capabilityRegistry);
  return {
    store,
    approvals: new InMemoryApprovalStore(),
    companion: new CompanionRegistry(),
    evidenceStore: new InMemoryEvidenceStore(),
    capabilityRegistry,
    memoryStore: new InMemoryMemoryStore(),
    personalContext: new InMemoryPersonalContextStore(),
    storeKind: conn ? "postgres" : "memory",
  };
}

export { createApiServer };