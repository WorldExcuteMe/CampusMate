// 独立 API Server 入口（生产角色：仅 HTTP API + Companion WSS，不跑 Worker）。
// 生产必须 Postgres（buildContext 守卫）。启动：node src/main-api.ts
import "./load-env.ts";
import { buildContext, createApiServer } from "./app-context.ts";
import { CompanionServer } from "./core/companion-server.ts";

const env = process.env;
let ctx;
try { ctx = buildContext(env); }
catch (e) { console.error(`[api] 启动失败：${e instanceof Error ? e.message : String(e)}`); process.exit(1); }

const port = Number(env.PORT ?? 8788);
const server = createApiServer({ store: ctx.store, jwtSecret: env.SUPABASE_JWT_SECRET ?? "", storeKind: ctx.storeKind, approvals: ctx.approvals, capabilityRegistry: ctx.capabilityRegistry, companion: ctx.companion, personalContext: ctx.personalContext, opportunityStore: ctx.opportunityStore });

const companionTokens: Record<string, { userId: string; capabilities: string[]; grantedScopes: Record<string, unknown> }> = (() => { try { return JSON.parse(env.COMPANION_TOKENS ?? "{}"); } catch { return {}; } })();
new CompanionServer(server, {
  registry: ctx.companion,
  authenticate: async (token) => { const t = companionTokens[token]; return t ? { userId: t.userId, capabilities: t.capabilities as never, grantedScopes: t.grantedScopes as never } : null; },
});

server.listen(port, "0.0.0.0", () => console.log(`[api] http://0.0.0.0:${port} (store=${ctx.storeKind}, role=api)`));