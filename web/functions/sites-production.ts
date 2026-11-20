// Production Sites wiring: a durable Agent/Environment binding initialized once
// through the official QCA helper, then reused read-only by run routes.
// This module never imports `_qoder/backend.mjs`; the deployment entry injects
// the platform SDK and calls this factory, which keeps the logic testable locally.
import { createCloudAgentsClient as createRuntimeClient } from "./cloud-agents.ts";
import { createCloudAgentsClient, ensureCloudResources, CloudAgentsError } from "./qca-managed.mjs";
import { CloudAgentError } from "./cloud-agents.ts";
import { createSitesApp, type SitesBinding } from "./sites-app.ts";
import { createSitesDatabaseStore, type SitesDatabase, type SitesLimits, type SitesLockOptions } from "./sites-database.ts";

export interface ProductionSiteConfig {
  siteOrigin: string;
  cloudAgentsApiOrigin: string;
  applicationScope: string;
  model: string;
  agentName: string;
  environmentName: string;
  system: string;
  tools: readonly { type: string; enabled_tools: readonly string[] }[];
}
export interface ProductionDependencies<Context> {
  db: SitesDatabase;
  requireUser: (context: Context) => { id?: unknown } | null | undefined;
  config: ProductionSiteConfig;
  // Read the platform Secret at request time, never at module load or cold start.
  getToken: () => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  limits?: Partial<SitesLimits>;
  lock?: SitesLockOptions;
  diagnostics?: (event: Record<string, unknown>) => void;
}

interface BindingRecord {
  state: "ready";
  scope: string;
  model: string;
  agent: { id: string; version: number };
  environmentId: string;
}

const SAFE_CODES = new Set([
  "ai_configuration_invalid", "ai_request_invalid", "ai_request_too_large", "ai_not_configured",
  "ai_access_denied", "ai_resource_not_found", "ai_conflict", "ai_rate_limited", "ai_request_rejected",
  "ai_service_unavailable", "ai_response_invalid", "ai_request_unknown", "ai_initialization_pending",
  "ai_initialization_conflict", "ai_resource_repair_required", "ai_initialization_rejected",
  "ai_model_not_enabled",
]);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
});
const bindingKey = (scope: string) => `sites:binding:${scope}`;

function parseBinding(value: unknown, scope: string): BindingRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.state !== "ready" || record.scope !== scope || typeof record.model !== "string" || !record.model) return null;
  const agent = record.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return null;
  const { id, version } = agent as Record<string, unknown>;
  if (typeof id !== "string" || !/^agent_[A-Za-z0-9_-]{1,160}$/.test(id)) return null;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (typeof record.environmentId !== "string" || !/^env_[A-Za-z0-9_-]{1,160}$/.test(record.environmentId)) return null;
  return {
    state: "ready", scope, model: record.model,
    agent: { id, version }, environmentId: record.environmentId,
  };
}
function sameBinding(a: BindingRecord, b: BindingRecord) {
  return a.scope === b.scope && a.model === b.model && a.environmentId === b.environmentId &&
    a.agent.id === b.agent.id && a.agent.version === b.agent.version;
}
function authFailure(error: unknown): Response | null {
  if (!error || typeof error !== "object") return null;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (status === 401 && code === "login_required") return json(401, { error: "login_required" });
  if (status === 403 && code === "invalid_user_context") return json(403, { error: "invalid_user_context" });
  return null;
}
function cloudFailure(error: CloudAgentsError): Response {
  const status = error.code === "ai_access_denied" ? 503
    : error.code === "ai_initialization_pending" ? 202
    : [400, 404, 409, 413, 429].includes(error.status) ? error.status : 503;
  const code = SAFE_CODES.has(error.code) ? error.code : "sites_initialization_failed";
  return json(status, { error: code }, status === 429 ? { "Retry-After": "60" } : {});
}

export function createProductionSites<Context = unknown>(deps: ProductionDependencies<Context>) {
  const { config, getToken } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const store = createSitesDatabaseStore(deps.db, { limits: deps.limits, now: deps.now, lock: deps.lock });
  const key = bindingKey(config.applicationScope);

  async function readBindingRecord(): Promise<BindingRecord | null> {
    return parseBinding(await store.binding.read(key), config.applicationScope);
  }
  async function readBinding(): Promise<SitesBinding | null> {
    const record = await readBindingRecord();
    return record ? { agent: { id: record.agent.id, version: record.agent.version }, environmentId: record.environmentId } : null;
  }
  async function checkModel(client: ReturnType<typeof createCloudAgentsClient>): Promise<string> {
    // The official model list endpoint takes no query parameters and is not paginated.
    const result = await client.request("/api/v1/cloud/models") as { data?: unknown; has_more?: unknown };
    if (!result || !Array.isArray(result.data) || result.has_more !== false) {
      throw new CloudAgentsError("ai_response_invalid", 503, "rejected");
    }
    for (const item of result.data) {
      if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") {
        throw new CloudAgentsError("ai_response_invalid", 503, "rejected");
      }
      if ((item as { id: string }).id === config.model) {
        // 平台旧响应可能没有 is_enabled 字段；只有显式 false 才判定为未启用。
        if ((item as { is_enabled?: unknown }).is_enabled === false) throw new CloudAgentsError("ai_model_not_enabled", 503, "not_sent");
        return config.model;
      }
    }
    throw new CloudAgentsError("ai_model_not_enabled", 503, "not_sent");
  }
  async function initialize(): Promise<Response | void> {
    try {
      const existing = await readBindingRecord();
      if (existing && existing.model === config.model) return;
      const cloud = createCloudAgentsClient({
        origin: config.cloudAgentsApiOrigin,
        getToken,
        fetchImpl,
        ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
      });
      const model = await checkModel(cloud);
      const resources = await ensureCloudResources({
        // Cap resource lookup at two pages so a single Edge invocation stays short.
        client: {
          request: cloud.request,
          findResources: (kind: 'agents' | 'environments', metadata: Record<string, string>) => cloud.findResources(kind, metadata, 2),
          openStream: cloud.openStream,
        },
        coordinator: store.coordinator,
        applicationScope: config.applicationScope,
        agent: {
          name: config.agentName, model, system: config.system, tools: config.tools,
          metadata: { app: "campusmate", purpose: "notice" },
        },
        environment: {
          name: config.environmentName, config: { type: "cloud" },
          metadata: { app: "campusmate", purpose: "notice" },
        },
      });
      const binding: BindingRecord = {
        state: "ready", scope: config.applicationScope, model,
        agent: { id: resources.agent.id, version: resources.agent.version },
        environmentId: resources.environment_id,
      };
      await store.coordinator.withLock(key, async lease => {
        const current = parseBinding(await lease.read(), config.applicationScope);
        if (current && sameBinding(current, binding)) return;
        await lease.write({ ...binding });
      });
    } catch (error) {
      if (error instanceof CloudAgentsError) return cloudFailure(error);
      return json(503, { error: "sites_initialization_failed" });
    }
  }

  // v1 数据面在首个 Cloud 会话前需要同一 Agent/Environment 绑定：缺失时按 P0 流程初始化一次。
  async function resolveBinding(): Promise<{ agent: { id: string; version: number }; environmentId: string }> {
    const current = await readBinding();
    if (current) return current;
    const failure = await initialize();
    if (failure) {
      // 把 initialize 的安全错误码透出，避免一律 503 sites_dependency_unavailable。
      let code = "ai_initialization_pending";
      let status = failure.status || 503;
      try {
        const body = await failure.clone().json() as { error?: unknown };
        if (typeof body.error === "string" && /^[a-z_]{3,64}$/.test(body.error)) code = body.error;
      } catch { /* 保留默认码 */ }
      console.error("[campusmate] cloud binding init failed", { code, status });
      throw new CloudAgentError(code, status);
    }
    const ready = await readBinding();
    if (!ready) throw new CloudAgentsError("ai_initialization_pending", 503, "not_sent");
    return ready;
  }

  const handle = async (context: Context & { request: Request }): Promise<Response> => {
    let user: { id?: unknown } | null | undefined;
    try { user = deps.requireUser(context); }
    catch (error) {
      const mapped = authFailure(error);
      if (mapped) return mapped;
      throw error;
    }
    if (!user || typeof user.id !== "string" || !user.id.trim() || user.id.length > 200) {
      return json(401, { error: "login_required" });
    }
    const owner = user.id;
    const app = createSitesApp({
      authorize: async () => ({ id: owner }),
      runs: store.runs,
      allowRequest: store.allowRequest,
      client: () => createRuntimeClient({ accessToken: getToken() ?? "", baseUrl: config.cloudAgentsApiOrigin, fetch: fetchImpl }),
      binding: readBinding,
      initialize,
      origin: config.siteOrigin,
    });
    return app(context.request);
  };
  return Object.assign(handle, { resolveBinding });
}
