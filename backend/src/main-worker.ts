// 独立 Worker 进程入口（生产角色：任务认领/Lease/执行/Checkpoint/Evaluator/Recovery）。
// 生产必须 Postgres（buildContext 守卫）。启动：node src/main-worker.ts
import { buildContext } from "./app-context.ts";
import { Worker } from "./runtime/worker.ts";
import { transportFromEnv } from "./core/llm.ts";
import { CLOUD_TOOLS, executeCloudTool } from "./core/cloud-tools.ts";

const env = process.env;
let ctx;
try { ctx = buildContext(env); }
catch (e) { console.error(`[worker] 启动失败：${e instanceof Error ? e.message : String(e)}`); process.exit(1); }

if (!env.LLM_API_KEY) { console.error("[worker] LLM_API_KEY 未配置，Worker 无法执行任务。"); process.exit(1); }

const transport = transportFromEnv(env);
const worker = new Worker({
  store: ctx.store,
  transport,
  tools: CLOUD_TOOLS,
  approvals: ctx.approvals,
  companion: ctx.companion,
  evidenceStore: ctx.evidenceStore,
  capabilityRegistry: ctx.capabilityRegistry,
  memoryStore: ctx.memoryStore,
  buildSystem: (t) => `你是 CampusMate 校园机会管家，面向大学生。当前任务：${t.title}。回答简洁中文、重点突出、给来源、不编造；需要公开信息时用 web_search/web_fetch；核验机会用 propose_verification 提交证据（VERIFIED 由独立核验决定，不自判）。`,
  executeTool: async (task, name, args) => executeCloudTool(name, args, { taskId: task.id, userId: task.userId, evidenceStore: ctx.evidenceStore }),
  concurrency: Number(env.WORKER_CONCURRENCY ?? 2),
  leaseTtlMs: Number(env.LEASE_TTL_MS ?? 60000),
  heartbeatMs: Number(env.HEARTBEAT_MS ?? 15000),
});
const ctrl = new AbortController();
process.on("SIGINT", () => ctrl.abort());
process.on("SIGTERM", () => ctrl.abort());
void worker.run({ signal: ctrl.signal, pollMs: 1000 });
console.log(`[worker] started (store=${ctx.storeKind}, role=worker, concurrency=${env.WORKER_CONCURRENCY ?? 2})`);