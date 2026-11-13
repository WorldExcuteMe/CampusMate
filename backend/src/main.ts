// 一体化开发入口：API + Worker 同进程共享 InMemoryStore（可立即运行/演示）。
// 生产拆分：api/worker 独立进程 + PostgresStore（migrations/0002，Phase 2）。
import { createApiServer } from "./api/server.ts";
import { InMemoryStore } from "./runtime/store.ts";
import type { TaskStore } from "./runtime/store.ts";
import { PostgresStore } from "./runtime/postgres-store.ts";
import { PgPool, connectionStringFromEnv } from "./runtime/sql.ts";
import { InMemoryApprovalStore } from "./runtime/approval.ts";
import { CompanionRegistry } from "./core/companion.ts";
import { InMemoryEvidenceStore } from "./core/evidence.ts";
import { CapabilityRegistry, registerCloudDefaults } from "./core/capability.ts";
import { InMemoryMemoryStore } from "./core/memory.ts";
import { InMemoryPersonalContextStore } from "./core/personal-context.ts";
import { CompanionServer } from "./core/companion-server.ts";
import { Worker } from "./runtime/worker.ts";
import { transportFromEnv } from "./core/llm.ts";
import { CLOUD_TOOLS, executeCloudTool } from "./core/cloud-tools.ts";

const env = process.env;
const conn = connectionStringFromEnv(env);
const store: TaskStore = conn ? new PostgresStore(new PgPool(conn)) : new InMemoryStore();
const approvals = new InMemoryApprovalStore();
const companion = new CompanionRegistry();
const evidenceStore = new InMemoryEvidenceStore();
const capabilityRegistry = new CapabilityRegistry();
registerCloudDefaults(capabilityRegistry);
const memoryStore = new InMemoryMemoryStore();
const ctxPersonal = new InMemoryPersonalContextStore();
const storeKind = conn ? "postgres" : "memory";
const port = Number(env.PORT ?? 8788);

const server = createApiServer({ store, jwtSecret: env.SUPABASE_JWT_SECRET ?? "", storeKind, approvals, capabilityRegistry, companion, personalContext: ctxPersonal });
// Companion 出站 WSS：设备令牌经 COMPANION_TOKENS（JSON: {token:{userId,capabilities,grantedScopes}}）授权。
const companionTokens: Record<string, { userId: string; capabilities: string[]; grantedScopes: Record<string, unknown> }> = (() => { try { return JSON.parse(env.COMPANION_TOKENS ?? "{}"); } catch { return {}; } })();
const companionServer = new CompanionServer(server, {
  registry: companion,
  authenticate: async (token) => {
    const t = companionTokens[token];
    return t ? { userId: t.userId, capabilities: t.capabilities as never, grantedScopes: t.grantedScopes as never } : null;
  },
});
server.listen(port, "0.0.0.0", () => console.log(`[api] http://0.0.0.0:${port} (store=${storeKind}, companion wss=/companion)`));

if (env.LLM_API_KEY) {
  const transport = transportFromEnv(env);
  const worker = new Worker({
    store,
    transport,
    tools: CLOUD_TOOLS,
    approvals,
    companion,
    companionServer,
    evidenceStore,
    capabilityRegistry,
    memoryStore,
    buildSystem: (t) => `你是 CampusMate 校园机会管家，面向大学生。当前任务：${t.title}。回答简洁中文、重点突出、给来源、不编造；需要公开信息时用 web_search/web_fetch；核验机会用 propose_verification 提交证据（VERIFIED 由独立核验决定，不自判）。`,
    executeTool: async (task, name, args) => executeCloudTool(name, args, { taskId: task.id, userId: task.userId, evidenceStore }),
    concurrency: Number(env.WORKER_CONCURRENCY ?? 2),
    leaseTtlMs: Number(env.LEASE_TTL_MS ?? 60000),
    heartbeatMs: Number(env.HEARTBEAT_MS ?? 15000),
  });
  const ctrl = new AbortController();
  process.on("SIGINT", () => ctrl.abort());
  process.on("SIGTERM", () => ctrl.abort());
  void worker.run({ signal: ctrl.signal, pollMs: 1000 });
  console.log("[worker] started (cloud tools: web_search)");
} else {
  console.warn("[worker] LLM_API_KEY 未配置，Worker 未启动；API 仍可提交/查询任务。");
}