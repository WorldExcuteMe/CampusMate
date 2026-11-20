// Deployment entry point for the Sites Function.
// The Sites Worker injects `_qoder/backend.mjs` before deployment; it is never
// committed or stubbed here. Local development keeps using ./runtime.ts through
// dev/function-local.ts.
import { createDatabaseClient, createSiteContext, requireUser, errorResponse } from "./_qoder/backend.mjs";
import { CAMPUSMATE_SITES } from "./sites-config.ts";
import { createProductionSites } from "./sites-production.ts";
import { createCloudAgentsClient } from "./cloud-agents.ts";
import { createSitesV1, type SitesV1Cloud } from "./sites-v1.ts";
import { createServerModelExecutor, createUserKeyVault, SERVER_PROVIDERS } from "./sites-exec.ts";

const db = createDatabaseClient();
const getToken = () => Deno.env.get("QODER_PAT");
const env = Deno.env.toObject();

const platform = createProductionSites({
  db,
  requireUser,
  config: CAMPUSMATE_SITES,
  // QODER_PAT is a platform-managed Secret read per request inside the handler.
  getToken,
});

// Qoder 托管模型（Cloud Agents 沙箱）与服务端模型（Edge 分步执行器）统一成
// 只读 Provider 列表；这里只含公开元数据，任何密钥都不下发给浏览器。
const managedProviders = [
  {
    id: "qoder-cloud", displayName: "Qoder Cloud Agents", modelId: CAMPUSMATE_SITES.model,
    protocol: "qoder-cloud", managed: true, readonly: true, builtin: true, isDefault: true,
    hasKey: true,
    capabilities: { vision: true, tools: "native", streaming: true },
  },
  ...SERVER_PROVIDERS.map(provider => ({
    id: provider.id, displayName: provider.name, modelId: provider.model,
    protocol: "openai", baseUrl: provider.baseUrl, contextLimit: provider.contextLimit,
    managed: true, readonly: true, builtin: true,
    hasKey: true,
    capabilities: {
      vision: true,
      tools: "native", streaming: false,
      reasoningTiers: provider.tiers, defaultReasoning: provider.defaultTier,
    },
  })),
];

// 每次请求读取平台托管 PAT 再构造客户端；绑定在首个 Cloud 会话前由平台初始化流程解析。
function runtimeCloud(): SitesV1Cloud {
  const client = () => createCloudAgentsClient({
    accessToken: getToken() ?? "",
    baseUrl: CAMPUSMATE_SITES.cloudAgentsApiOrigin,
    fetch,
  });
  return {
    createSession: async () => {
      const binding = await platform.resolveBinding();
      return await client().createSession(binding.agent, binding.environmentId);
    },
    sendMessage: (sessionId, text) => client().sendMessage(sessionId, text),
    listEvents: (sessionId, nextPage) => client().listEvents(sessionId, nextPage),
    streamEvents: (sessionId, lastEventId, signal) => client().streamEvents(sessionId, lastEventId, signal),
    cancelSession: sessionId => client().cancelSession(sessionId),
    getDownloadLink: fileId => client().getDownloadLink(fileId),
    fetch,
  };
}

const v1 = createSitesV1({
  db,
  cloud: runtimeCloud(),
  config: {
    // 静态占位；真实 Agent/Environment 由 binding() 在首个 Cloud 会话前解析。
    agent: { id: "agent_pending", version: 1 },
    environmentId: "env_pending",
    providers: managedProviders,
    capabilities: { providersMutable: true, serverModels: true, attachments: true },
    model: CAMPUSMATE_SITES.model,
  },
  binding: () => platform.resolveBinding(),
  exec: createServerModelExecutor({ db, env, fetch }),
  vault: createUserKeyVault(db, { env }),
  ownerOf: ctx => {
    const user = requireUser(ctx);
    return user && typeof user.id === "string" ? user.id : null;
  },
});

// 网关会改写物理函数名；路由只认路径：/v1/* 走数据面，其余保留 P0 /runs 应用。
Deno.serve(async request => {
  let context;
  try {
    context = createSiteContext(request);
    const pathname = new URL(request.url).pathname;
    if (/(?:^|\/)v1(?:\/|$)/.test(pathname)) return await v1(context);
    return await platform(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
