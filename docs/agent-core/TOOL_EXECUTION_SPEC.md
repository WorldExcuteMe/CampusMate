# TOOL_EXECUTION_SPEC · 工具契约 / 权限 / 幂等

> 提案规范，未实现。现状工具定义 `tools.ts`（18 个），执行 `chat.ts dispatchTool`（91-326），安全边界 `executeTool`（76-89，本轮已加）。
> 保留统一契约 `executeTool(name,args)→string(JSON)` 与错误边界；新增 Registry 元数据、运行时校验、权限、幂等、执行记录。

## 1. Tool Registry（统一契约 + 元数据）

```ts
interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;            // 现 tools.ts 的 parameters
  runtime: ("cloud"|"local-companion"|"dev")[];  // 允许的运行环境
  permission: "read"|"write_user"|"write_global"|"host_exec"|"host_fs";
  requiresApproval: boolean | ((args:unknown)=>boolean);
  idempotent: boolean;
  idempotencyKey?: (args:unknown, ctx:ToolCtx)=>string;  // 写工具必填
  timeoutMs: number;
  retry: { max: number; backoffMs: number; retryOn: ErrorClass[] };
  sideEffects: "none"|"db"|"host"|"network";
}
interface ToolCtx { taskId: string; userId: string; stepId: string; runtime: Runtime; }
```
Registry 替代现 `AGENT_TOOLS` 数组 + `dispatchTool` 的 if 链：保留 schema，补元数据。Scope 过滤（scope.ts）保留，叠加 runtime 过滤（Environment Manifest）。

## 2. Runtime Validation

执行前用 JSONSchema（zod 转换）校验 args；非法 → `tool_error(invalid_args)` 观测回传模型（不抛异常，保留现错误边界理念）。`String(args.x)` 强转保留但加类型校验前置。

## 3. Tool Permission / Human Approval（服务端强制）

权限矩阵：
- `read` / `write_user`：云端默认允许（按 RLS/uid 隔离）。
- `write_global`（opportunities/reports）：服务端 service_role + Evaluator 门控。
- `host_exec` / `host_fs`：**仅 local-companion**，云端 Manifest 不含；每次调用需人工审批。

审批流（服务端，非 Prompt）：
```ts
interface Approval {
  id: string; taskId: string; userId: string; toolName: string;
  args: unknown; risk: string;
  status: "pending"|"approved"|"rejected"; decidedAt?: string;
}
```
高危工具调用 → 写 Approval(pending) + `tool.approval_requested` 事件 + Task→needs_input；SPA 展示审批卡片；用户 `POST /approvals/:id` 后 Worker 才执行。**模型不能绕过**（执行前查 Approval.status）。

## 4. Idempotency

```ts
// 写工具幂等键 = 自然键优先，回退 canonical args hash
function idempotencyKey(tool: string, args: any, ctx: ToolCtx): string {
  switch (tool) {
    case "save_to_inbox": return `inbox:${ctx.userId}:${dedupKey(args.title, args.deadline, args.source)}`;
    case "create_opportunity": return `opp:${contentHash(args.title, args.type, args.deadline, args.sourceUrl)}`;
    case "create_daily_task": return `daily:${ctx.userId}:${args.title}:${args.dueAt ?? args.timeText}`;
    default: return `${tool}:${sha256(canonical(args))}`;
  }
}
```
执行前查 `agent_tool_invocations unique(task_id, idempotency_key)`：已 succeeded → 直接返回缓存 result（不重复副作用）；pending/running → 等待/跳过。业务表再加唯一约束（DATABASE_SCHEMA_SPEC §3）做第二道防线。替代现状 localStorage `SEEN_KEY`（qq.ts:27）与 mergeInbox 非幂等 summary 追加（dedupe.ts:108）。

## 5. Retry / Timeout / Result / Error

```ts
interface ToolResult { ok: true; data: unknown; invocationId: string; }
interface ToolError  { ok: false; error: string; class: ErrorClass; retryable: boolean; invocationId: string; }
```
- Timeout：每工具 `timeoutMs`（现 toolPost 60s 保留为默认；web_fetch 15s）。
- Retry：仅 retryOn 内的 ErrorClass，指数退避，上限 max；transport/transient 重试，permanent/permission 不重试。
- Error 序列化统一 `errorMessage`（errors.ts，永不 [object Object]）。
- 结果/错误都写 `agent_tool_invocations`（Execution Record）+ `tool.result` 事件。

## 6. Execution Record

每次调用写 agent_tool_invocations：tool_name/idempotency_key/args_hash/runtime/status/approval_id/result/error/attempt/started_at/finished_at。用于审计、重放检测、幂等、恢复对齐。

## 7. 现有 18 工具逐项评估（真实能力 → 决策）

| 工具 | 现状能力（代码） | runtime | 决策 |
|---|---|---|---|
| extract_notice | ruleExtract+classify+createInbox（chat.ts:103） | cloud | **保留**，加幂等键 |
| create_daily_task | extractDailyTime+createTask（181） | cloud | **保留**，加幂等键 |
| search_opportunities | repo.listOpportunities 过滤（200） | cloud | **保留**（只读） |
| match_opportunities | 画像打分（211） | cloud | **保留**（只读） |
| sync_group_notices | fetchGroups+fetchGroupNotices+syncGroupRecords（115） | **local-companion** | **重构**：移入 Companion，云端默认禁用；幂等服务端化 |
| list_groups | /api/ingest/qq/groups（134） | **local-companion** | **重构**：同上 |
| run_terminal | exec 任意命令（143, llm-proxy:300） | **local-companion** | **限权**：云端废弃；Companion 内每命令人工审批 + 命令白名单/沙箱 |
| read_file | fs.readFileSync 任意路径（151, llm-proxy:309） | **local-companion** | **限权**：云端废弃；路径 allowlist + 审批 |
| write_file | fs.writeFileSync 任意路径（157, llm-proxy:315） | **local-companion** | **限权**：云端废弃；路径 allowlist + 审批 |
| web_fetch | guardUrl+fetch（164, llm-proxy:321） | cloud | **重构**：服务端 SSRF 加固（DNS 解析后私网拦截/禁重定向私网/字节超时上限） |
| rag_search | 读本地 QQ 导出文件（173, llm-proxy:331） | cloud + local | **重构**：云端 RAG  over DB/Storage 已摄取数据；本地文件 RAG 走 Companion |
| merge_inbox | clusterNotices+updateInbox（253, dedupe.ts） | cloud | **保留**，修幂等（summary 追加改为幂等标记）+ merged_from 落库 |
| save_to_inbox | ruleExtract+createInbox（228） | cloud | **保留**，加 dedup_key 幂等 |
| create_opportunity | createOpportunity（258） | cloud(write_global) | **重构**：service_role 写 + content_hash 幂等 + 来源须证据 |
| verify_opportunity | 模型自填 status 直接 createReport（277） | cloud | **重构+改名 `propose_verification`**：只产提案，Evaluator 核验证据后才落 VERIFIED（见 EVALUATION_SPEC） |
| set_growth_goal | updateProfile+createTask（300） | cloud | **保留**，加幂等键 |
| web_search | DuckDuckGo html（314, llm-proxy:348） | cloud | **保留**，服务端化 + 结果去噪 |
| create_plan | setPlan→localStorage（319） | cloud | **重构**：改为 Planner 生成 agent_steps（DAG），不再 localStorage |

## 8. 安全要求落实（对应任务 §五）

1. run_terminal：云端废弃；Companion 内命令白名单 + 每命令审批 + 工作目录限制。
2. read_file/write_file：路径 allowlist（用户授权工作区内），越界拒绝 + 审批。
3. web_fetch：服务端复检 + DNS rebinding 防护 + 重定向私网拦截 + MAX_FETCH_BYTES/FETCH_TIMEOUT 强制（现 urlGuard.ts:45-46 定义但未在服务端 enforce）。
4. QQ/微信：仅 Companion + 用户明确授权；云端 Manifest 默认不含。
5. 用户隔离：工具 ctx.userId 取自 task，不接受 args.user_id。
6. Prompt Injection：工具/网页内容仅为数据；scope 掩码 + Evaluator 证据校验。
7. Tool Call 重放：幂等键 + 唯一约束。
8. DB 副作用重复：幂等键 + 业务唯一约束 + 事务。