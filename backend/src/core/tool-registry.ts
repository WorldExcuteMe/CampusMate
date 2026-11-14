// ToolSpec 元数据 + Manifest 工具门控。工具按 runtime 分类，Manifest 决定本任务可见工具集。
// 确定性门控：越界/不可用能力的工具模型根本看不到（叠加 scope 信息源锁定）。
import type { Runtime, ToolDef } from "./types.ts";
import type { CapabilityId } from "./capability.ts";
import { manifestToolNames, type EnvironmentManifest } from "./manifest.ts";

export interface ToolSpec {
  name: string;
  capability: CapabilityId;
  runtime: Runtime[];
  permission: "read" | "write_user" | "write_global" | "host_exec" | "host_fs";
  requiresApproval: boolean;
  idempotent: boolean;
  timeoutMs: number;
  sideEffects: "none" | "db" | "host" | "network";
}

// 现有工具的元数据绑定（与 TOOL_EXECUTION_SPEC 评估一致）。
export const TOOL_SPECS: Record<string, ToolSpec> = {
  web_search: { name: "web_search", capability: "web.search", runtime: ["cloud"], permission: "read", requiresApproval: false, idempotent: true, timeoutMs: 15000, sideEffects: "network" },
  web_fetch: { name: "web_fetch", capability: "web.fetch", runtime: ["cloud"], permission: "read", requiresApproval: false, idempotent: true, timeoutMs: 15000, sideEffects: "network" },
  rag_search: { name: "rag_search", capability: "rag.search", runtime: ["cloud", "local-companion"], permission: "read", requiresApproval: false, idempotent: true, timeoutMs: 15000, sideEffects: "none" },
  search_opportunities: { name: "search_opportunities", capability: "db.read", runtime: ["cloud"], permission: "read", requiresApproval: false, idempotent: true, timeoutMs: 10000, sideEffects: "none" },
  list_opportunities: { name: "list_opportunities", capability: "db.read", runtime: ["cloud"], permission: "read", requiresApproval: false, idempotent: true, timeoutMs: 10000, sideEffects: "none" },
  save_opportunity: { name: "save_opportunity", capability: "db.write_user", runtime: ["cloud"], permission: "write_user", requiresApproval: false, idempotent: false, timeoutMs: 10000, sideEffects: "db" },
  match_opportunities: { name: "match_opportunities", capability: "db.read", runtime: ["cloud"], permission: "read", requiresApproval: false, idempotent: true, timeoutMs: 10000, sideEffects: "none" },
  save_to_inbox: { name: "save_to_inbox", capability: "db.write_user", runtime: ["cloud"], permission: "write_user", requiresApproval: false, idempotent: true, timeoutMs: 10000, sideEffects: "db" },
  create_daily_task: { name: "create_daily_task", capability: "db.write_user", runtime: ["cloud"], permission: "write_user", requiresApproval: false, idempotent: true, timeoutMs: 10000, sideEffects: "db" },
  set_growth_goal: { name: "set_growth_goal", capability: "db.write_user", runtime: ["cloud"], permission: "write_user", requiresApproval: false, idempotent: true, timeoutMs: 10000, sideEffects: "db" },
  merge_inbox: { name: "merge_inbox", capability: "db.write_user", runtime: ["cloud"], permission: "write_user", requiresApproval: false, idempotent: true, timeoutMs: 10000, sideEffects: "db" },
  create_opportunity: { name: "create_opportunity", capability: "db.write_global", runtime: ["cloud"], permission: "write_global", requiresApproval: true, idempotent: true, timeoutMs: 10000, sideEffects: "db" },
  propose_verification: { name: "propose_verification", capability: "db.write_global", runtime: ["cloud"], permission: "write_global", requiresApproval: true, idempotent: true, timeoutMs: 10000, sideEffects: "db" },
  run_terminal: { name: "run_terminal", capability: "host.terminal", runtime: ["local-companion", "dev"], permission: "host_exec", requiresApproval: true, idempotent: false, timeoutMs: 60000, sideEffects: "host" },
  read_file: { name: "read_file", capability: "host.fs.read", runtime: ["local-companion", "dev"], permission: "host_fs", requiresApproval: true, idempotent: true, timeoutMs: 10000, sideEffects: "host" },
  write_file: { name: "write_file", capability: "host.fs.write", runtime: ["local-companion", "dev"], permission: "host_fs", requiresApproval: true, idempotent: false, timeoutMs: 10000, sideEffects: "host" },
  sync_group_notices: { name: "sync_group_notices", capability: "ingest.qq", runtime: ["local-companion", "dev"], permission: "host_fs", requiresApproval: true, idempotent: true, timeoutMs: 180000, sideEffects: "host" },
  list_groups: { name: "list_groups", capability: "ingest.qq", runtime: ["local-companion", "dev"], permission: "host_fs", requiresApproval: true, idempotent: true, timeoutMs: 180000, sideEffects: "host" },
};

// Manifest 门控：只保留 Manifest 可用能力支撑的工具。云端默认无本机工具。
export function manifestTools(manifest: EnvironmentManifest, allTools: ToolDef[]): ToolDef[] {
  const allowed = manifestToolNames(manifest);
  return allTools.filter((t) => allowed.has(t.function.name));
}

// 工具是否需审批（元数据驱动，与 approval.requiresApproval 一致）。
export function toolRequiresApproval(name: string): boolean {
  return TOOL_SPECS[name]?.requiresApproval ?? false;
}