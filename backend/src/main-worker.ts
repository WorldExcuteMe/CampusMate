// 独立 Worker 进程入口（生产角色：任务认领/Lease/执行/Checkpoint/Evaluator/Recovery）。
// 生产必须 Postgres（buildContext 守卫）。启动：node src/main-worker.ts
import "./load-env.ts";
import { buildContext } from "./app-context.ts";
import { Worker } from "./runtime/worker.ts";
import { CLOUD_TOOLS, executeCloudTool } from "./core/cloud-tools.ts";
import { CAMPUS_SYSTEM } from "./core/system-prompt.ts";

const env = process.env;
let ctx;
try { ctx = buildContext(env); }
catch (e) { console.error(`[worker] 启动失败：${e instanceof Error ? e.message : String(e)}`); process.exit(1); }

const worker = new Worker({
  store: ctx.store,
  resolveTransport: (task) => ctx.providers.transport(task),
  tools: CLOUD_TOOLS,
  approvals: ctx.approvals,
  companion: ctx.companion,
  evidenceStore: ctx.evidenceStore,
  capabilityRegistry: ctx.capabilityRegistry,
  memoryStore: ctx.memoryStore,
  sessionStore: ctx.sessionStore,
  personalContext: ctx.personalContext,
    artifactStore: ctx.artifactStore,
  buildSystem: () => CAMPUS_SYSTEM,
  executeTool: async (task, name, args) => executeCloudTool(name, args, { taskId: task.id, userId: task.userId, intent: task.intent, campusRecords: ctx.campusRecords, evidenceStore: ctx.evidenceStore, opportunityStore: ctx.opportunityStore, artifactStore: ctx.artifactStore, documents: ctx.documents, businessStore: ctx.businessStore }),
  concurrency: Number(env.WORKER_CONCURRENCY ?? 2),
  leaseTtlMs: Number(env.LEASE_TTL_MS ?? 60000),
  heartbeatMs: Number(env.HEARTBEAT_MS ?? 15000),
});
const ctrl = new AbortController();
process.on("SIGINT", () => ctrl.abort());
process.on("SIGTERM", () => ctrl.abort());
void worker.run({ signal: ctrl.signal, pollMs: 1000 });
console.log(`[worker] started (store=${ctx.storeKind}, role=worker, concurrency=${env.WORKER_CONCURRENCY ?? 2})`);
