# CAPABILITY_SYSTEM_SPEC · 能力注册 / 环境适配

> 提案规范，未实现。现状雏形：`scope.ts`（动作掩码+执行期门控）、`tools.ts`（工具定义）、`dev/llm-proxy.mjs`（本机能力端点）、`/api/env/check`（环境检测）。
> 核心原则：**本机能力不得未经明确授权暴露给云端 Agent**；能力缺失必须被发现并替代/调整/报告，禁止假装具备。

## 1. Capability Registry

```ts
type CapabilityId =
  | "llm.chat" | "web.fetch" | "web.search" | "rag.search"
  | "db.read" | "db.write_user" | "db.write_global"
  | "ingest.qq" | "ingest.wechat" | "host.terminal" | "host.fs";

interface CapabilityProvider {
  id: CapabilityId;
  runtime: Runtime;                       // cloud | local-companion | dev
  tools: string[];                        // 该能力支撑的工具名
  permissions: ToolSpec["permission"][];
  healthCheck(): Promise<HealthStatus>;
  invoke(tool: string, args: unknown, ctx: ToolCtx): Promise<ToolResult|ToolError>;
}

interface HealthStatus {
  available: boolean;
  latencyMs?: number;
  reason?: string;                        // 不可用原因（可读）
  checkedAt: string;
}
```
Registry 启动时注册云端 Provider；Companion 连接时动态注册其本机 Provider（带用户授权范围）。Executor 经 Registry 分派，不直接 fetch 端点。

## 2. Environment Manifest（任务开始前生成）

```ts
interface EnvironmentManifest {
  userId: string; taskId: string;
  locale: string; timezone: string;       // 默认 zh-CN / Asia/Shanghai（现 nowBeijingText）
  institution?: string;                   // 用户画像/学校（可空）
  runtime: Runtime;                       // 本任务主运行环境
  capabilities: {
    id: CapabilityId; available: boolean; health: HealthStatus;
    scope?: Record<string, unknown>;      // 如 ingest.qq 限定的群 uin
  }[];
  permissions: { approvalRequired: string[]; grantedScopes: string[] };
  quotas: Budget;                         // 接 task.budget
  generatedAt: string;
}
```
生成时机：Worker claim 后、Planner 前。来源：用户画像（profiles）、Companion 注册状态、云端 Provider healthCheck、用户授权记录。**Manifest 决定本任务可用工具集**（叠加 scope.ts 掩码）。

## 3. Health Check

- 云端 `llm.chat`：轻量 models 探测或缓存最近成功调用（避免每次真调）。
- `web.fetch/search`：依赖出站网络，标记 available 由最近失败率推断。
- `ingest.qq/wechat`：Companion 上报（现 `/api/env/check` 的 qqKey/qqRunning/wechatKey 演进）。
- `host.terminal/fs`：Companion 心跳 + 授权范围。
- 不可用能力：Manifest 标 `available:false + reason`；Planner 据此选替代或报告。

## 4. Cloud Runtime

云端 Worker 默认能力：`llm.chat`、`web.fetch`（SSRF 加固）、`web.search`、`rag.search`（over DB/Storage）、`db.read/write_user/write_global`（service_role 隔离）。**默认不含任何 host.*/ingest.***。这是普通用户的生产运行环境。

## 5. Local Companion

opt-in 桌面伴侣（`dev/llm-proxy.mjs` 演进）：
```ts
interface CompanionRegistration {
  userId: string; deviceId: string;
  capabilities: CapabilityId[];           // 用户授权开放的能力
  grantedScopes: { fsPaths?: string[]; qqGroups?: string[]; terminalAllowlist?: string[] };
  authToken: string;                      // 出站认证（设备绑定）
  lastHeartbeat: string;
}
```
- 出站连接（WebSocket/gRPC），NAT 友好，无需用户开端口。
- 仅注册到**该用户**的 Manifest；其他用户/云端默认不可见。
- 高危调用（terminal/fs write）经服务端审批流（TOOL_EXECUTION_SPEC §3）。
- 授权范围（fsPaths/qqGroups/terminalAllowlist）服务端强制，越界拒绝。

## 6. Development Runtime

`dev` runtime = 开发者本机 Companion（现 serve.mjs + llm-proxy.mjs）。与生产云端**严格区分**：dev 可用全部本机能力（开发便利），但生产云端 Manifest 永不自动包含 dev 能力。Environment Manifest 显式标 `runtime:"dev"`，评测/部署不得把 dev 能力当云端能力（对应 GPT 文档"不能只在开发者本机测试"）。

## 7. 能力缺失处理（禁止假装）

```ts
function resolveCapability(manifest, needed: CapabilityId): Resolution {
  const c = manifest.capabilities.find(x=>x.id===needed);
  if (c?.available) return { use: needed };
  const alt = ALTERNATIVES[needed];        // 如 ingest.qq 缺失 → web.search 官方源
  if (alt && manifest.capabilities.find(x=>x.id===alt&&x.available)) return { use: alt, note: "替代" };
  return { unavailable: true, reason: c?.reason ?? "能力未注册", action: "request_user_or_report" };
}
```
Planner 收到 unavailable → 调整计划/请求用户补充/明确报告不可执行。Executor 绝不调用 Manifest 外能力（确定性门控，接 scope.checkToolScope）。

## 8. 与现有代码衔接

- `scope.ts` 的 source 锁定/动作掩码保留，作为 Manifest 之上的"信息源硬约束"层。
- `/api/env/check`（llm-proxy:274）演进为 Companion healthCheck 上报。
- `tools.ts` 每工具补 `runtime` 元数据（TOOL_EXECUTION_SPEC §1），Registry 据此过滤。
- 现 `detectIngestIntent`（chat.ts:31）保留为意图提示，但能力可用性以 Manifest 为准（不靠意图假设能力存在）。