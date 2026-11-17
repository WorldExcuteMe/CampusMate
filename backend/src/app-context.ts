// 共享装配：API 与 Worker 独立进程复用同一套 Core/Contracts/Store。
// 生产守卫：NODE_ENV=production 必须有 DATABASE_URL（Postgres），否则明确失败，绝不静默降级 InMemory。
import { createApiServer } from "./api/server.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentService } from "./core/document-service.ts";
import { InMemoryStore, type TaskStore } from "./runtime/store.ts";
import { PostgresStore } from "./runtime/postgres-store.ts";
import { PgPool, connectionStringFromEnv } from "./runtime/sql.ts";
import type { ApprovalStore } from "./runtime/approval.ts";
import { CompanionRegistry } from "./core/companion.ts";
import type { EvidenceStore } from "./core/evidence.ts";
import { CapabilityRegistry, registerCloudDefaults } from "./core/capability.ts";
import { InMemoryMemoryStore, type MemoryStore } from "./core/memory.ts";
import type { PersonalContextStore } from "./core/personal-context.ts";
import { InMemoryOpportunityStore, type OpportunityStore } from "./core/opportunity-store.ts";
import type { ArtifactStore, ProviderStore, SessionStore } from "./core/storage-contracts.ts";
import type { SqlPool } from "./runtime/sql.ts";
import { MemoryArtifactStore, MemoryProviderStore, MemorySessionStore, ValidatedMemoryApprovalStore, ValidatedMemoryEvidenceStore, ValidatedMemoryPersonalContextStore } from "./runtime/memory-storage.ts";
import { PostgresApprovalStore } from "./runtime/postgres-approval-store.ts";
import { PostgresEvidenceStore } from "./runtime/postgres-evidence-store.ts";
import { PostgresPersonalContextStore } from "./runtime/postgres-personal-context-store.ts";
import { PostgresOpportunityStore } from "./runtime/postgres-opportunity-store.ts";
import { PostgresSessionStore } from "./runtime/postgres-session-store.ts";
import { PostgresProviderStore } from "./runtime/postgres-provider-store.ts";
import { PostgresArtifactStore } from "./runtime/postgres-artifact-store.ts";
import { CampusRecords } from "./core/campus-records.ts";
import { ProviderService } from "./core/providers.ts";
import type { BusinessStore } from './core/business-tools.ts';
import { PostgresBusinessStore } from './runtime/postgres-business-store.ts';
import { SessionFeed } from './runtime/session-feed.ts';

export interface AppContext {
  store: TaskStore;
  approvals: ApprovalStore;
  companion: CompanionRegistry;
  evidenceStore: EvidenceStore;
  capabilityRegistry: CapabilityRegistry;
  memoryStore: MemoryStore;
  personalContext: PersonalContextStore;
  opportunityStore: OpportunityStore;
  campusRecords: CampusRecords;
  sessionStore: SessionStore;
  providerStore: ProviderStore;
  providers: ProviderService;
  artifactStore: ArtifactStore;
  documents: DocumentService;
  sessionFeed: SessionFeed;
  businessStore?: BusinessStore;
  storeKind: "postgres" | "memory";
  dispose: () => Promise<void>;
}

export class ProductionDbRequiredError extends Error {
  constructor() { super("生产环境必须配置 DATABASE_URL（Postgres）；不允许静默降级 InMemory。"); this.name = "ProductionDbRequiredError"; }
}

export function buildContext(env: Record<string, string | undefined>, options: { pool?: SqlPool; providerFetch?: typeof fetch } = {}): AppContext {
  const conn = connectionStringFromEnv(env);
  const isProd = env.NODE_ENV === "production";
  if (isProd && !conn && !options.pool) throw new ProductionDbRequiredError();
  const pool = options.pool ?? (conn ? new PgPool(conn, {
    proxyUrl: env.DATABASE_PROXY_URL,
    ...(env.DATABASE_CONNECTION_TIMEOUT_MS ? { connectionTimeoutMillis: Number(env.DATABASE_CONNECTION_TIMEOUT_MS) } : {}),
    ...(env.DATABASE_SSL_CA_FILE ? { ssl: { rejectUnauthorized: true, ca: readFileSync(path.resolve(fileURLToPath(new URL("../", import.meta.url)), env.DATABASE_SSL_CA_FILE), "utf8") } } : {}),
  }) : undefined);
  const store: TaskStore = pool ? new PostgresStore(pool) : new InMemoryStore();
  const artifactStore: ArtifactStore = pool ? new PostgresArtifactStore(pool) : new MemoryArtifactStore(store);
  const providerStore: ProviderStore = pool ? new PostgresProviderStore(pool) : new MemoryProviderStore();
  const capabilityRegistry = new CapabilityRegistry();
  const sessionStore = pool ? new PostgresSessionStore(pool) : new MemorySessionStore(store);
  registerCloudDefaults(capabilityRegistry);
  return {
    store,
    approvals: pool ? new PostgresApprovalStore(pool) : new ValidatedMemoryApprovalStore(store),
    companion: new CompanionRegistry(),
    evidenceStore: pool ? new PostgresEvidenceStore(pool) : new ValidatedMemoryEvidenceStore(store, artifactStore),
    capabilityRegistry,
    memoryStore: new InMemoryMemoryStore(),
    personalContext: pool ? new PostgresPersonalContextStore(pool) : new ValidatedMemoryPersonalContextStore(),
    opportunityStore: pool ? new PostgresOpportunityStore(pool) : new InMemoryOpportunityStore(),
    campusRecords: new CampusRecords(pool),
    sessionStore,
    sessionFeed: new SessionFeed(sessionStore, store, pool),
    providerStore,
    providers: new ProviderService(providerStore, env, options.providerFetch),
    artifactStore,
    documents: new DocumentService(artifactStore, { pdfEnabled: env.DOCUMENT_PDF_ENABLED !== "0" }),
    businessStore: pool ? new PostgresBusinessStore(pool) : undefined,
    storeKind: pool ? "postgres" : "memory",
    dispose: async () => { if (pool && !options.pool) await pool.end(); },
  };
}

export { createApiServer };
