# 00 · CampusMate Agent 当前架构（真实代码取证）

> 取证基线：分支 `fix/agent-real-tool-calling`，提交 `4b396db`。本文所有结论来自真实源码（附 `文件:行`），不依据历史设计文档推断。审计日期 2026-11-13。

## 1. 真实执行链路（浏览器内单进程 Agent Loop）

```
用户输入
  └─ AgentChatPage.send()                         web/src/features/agent/AgentChatPage.tsx:73
       └─ runChat(opts)                           web/src/lib/agent/chat.ts:352
            ├─ detectIngestIntent / env/check     chat.ts:30, 366  （QQ/微信意图才走环境引导）
            ├─ detectScope(message)               web/src/lib/agent/scope.ts:30  （信息源硬锁定）
            ├─ allowedTools(scope, baseTools)     scope.ts:60  （动作空间掩码）
            ├─ composeContext(system+history+user+tools, cap)   web/src/lib/agent/context.ts:101
            ├─ for i in 0..MAX_TOOL_ROUNDS(20):   chat.ts:350, 413
            │    ├─ llmChat({messages,tools,reasoning})           web/src/lib/llm/proxy.ts:81
            │    │    └─ POST /api/llm  →  dev/llm-proxy.mjs:149  →  上游 /chat/completions
            │    ├─ 原生 tool_calls → executeTool()               chat.ts:417, 72
            │    │    └─ dispatchTool() → repo.* / toolPost(/api/*)  chat.ts:90
            │    ├─ 或 JSON 工具指令 parseJsonTool()              chat.ts:310, 438
            │    ├─ trimToBudget(messages,cap)                    context.ts:148
            │    └─ noteRepeat() 重复调用提醒(3/5/8)              chat.ts:340
            └─ 无工具调用 → appendMemory() → 返回 reply           chat.ts:450
```

LLM 传输三级退避：
- 客户端 `llmChat`：502/503/504 与网络错误退避重试 3 次，再回退 `VITE_LLM_EDGE_URL`（proxy.ts:101-130）。
- 服务端 `llm-proxy.mjs`：429/500/502/503/504 退避重试 4 次（llm-proxy.mjs:160-197）。
- 密钥仅服务端解析（`.env.local` / `.providers.local.json`），前端 bundle 与 localStorage 不含密钥。

## 2. 模块清单（真实职责）

| 关注点 | 真实实现 | 位置 |
|---|---|---|
| 用户入口 | `AgentChatPage.send()` | features/agent/AgentChatPage.tsx:73 |
| Agent Loop | `runChat`，有界 20 轮工具循环 | lib/agent/chat.ts:352 |
| Prompt Builder | `SYSTEM(profile,mode)` + scope.contract + memoryPrompt | chat.ts:34, 399 |
| LLM Provider | `llmChat`（同源 /api/llm）+ `ProxyProvider`/`OpenAICompatibleProvider`/`MockProvider` | llm/proxy.ts:81, llm/openai.ts, llm/mock.ts |
| Tool Registry | `AGENT_TOOLS`（18 个工具定义） | lib/agent/tools.ts |
| Tool Executor | `executeTool`→`dispatchTool`（安全边界+分派） | chat.ts:72, 90 |
| Capability 门控 | `detectScope`/`allowedTools`/`checkToolScope` | lib/agent/scope.ts |
| Context Engine | `composeContext`/`trimToBudget`/`resolveContextCap`（模型感知上限+压缩+裁剪） | lib/agent/context.ts |
| Memory/Plan | `setPlan`/`appendMemory`/`memoryPrompt`（localStorage） | lib/agent/memory.ts |
| 业务持久化 | `SupabaseRepository` / `DemoRepository` | lib/data/supabase.ts, demo.ts |
| 错误序列化 | `errorMessage` / `LlmTransportError`（本次新增） | lib/llm/errors.ts |
| 抽取流水线 | `runInboxPipeline`（独立于 chat 的提取闭环） | lib/agent/orchestrator.ts:33 |
| 可观察性 | `AgentRun`（仅 inbox 流水线）+ `agent_runs` 表 | orchestrator.ts:10, supabase.ts:234 |

## 3. 工具契约（18 个，统一 `executeTool(name,args)→string`）

`extract_notice, sync_group_notices, list_groups, run_terminal, read_file, write_file, web_fetch, rag_search, create_daily_task, search_opportunities, match_opportunities, save_to_inbox, merge_inbox, create_opportunity, verify_opportunity, set_growth_goal, web_search, create_plan`（chat.ts:84-306）。

- 统一返回 JSON 字符串；失败返回 `{error: "..."}` 观测（本次修复后由 `executeTool` 安全边界保证，chat.ts:72-89）。
- 主机能力（终端/文件/网络/RAG/搜索）经 `toolPost(/api/*)` 调本地代理（chat.ts:50）。
- 业务能力（inbox/任务/机会/核验）经 `Repository` 写 Supabase 或 Demo。

## 4. 状态与持久化：哪些是真持久化，哪些只是进程内

| 状态 | 存储 | 跨进程恢复 |
|---|---|---|
| 业务数据（inbox/tasks/opportunities/reports） | Supabase 表（真持久化） | 是（数据层） |
| 长任务 Plan / 滚动 Memory | 浏览器 localStorage（memory.ts:10-11） | 否（仅本浏览器） |
| 会话历史 | localStorage（sessions） | 否（仅本浏览器） |
| Agent Loop 进度 / 工具调用链 | **进程内内存**（runChat 局部变量 messages） | **否** |
| 事件日志 / Checkpoint / Task 快照 | **不存在** | **否** |
| AgentRun 轨迹 | 仅 `runInboxPipeline` 写 `agent_runs`；**chat 主循环不写** | 部分 |

## 5. 与成熟 Agent Runtime 的结构性差距（取证结论）

1. **单轮会话式 Loop，无独立 Task Lifecycle**：任务状态寄生于 `runChat` 局部 `messages` 与聊天历史，无 GoalSpec/Task/Step 状态机。
2. **无持久化事件日志 / Checkpoint**：进程崩溃即丢失循环进度，无法跨进程恢复（GPT 文档 Test 3 不满足）。
3. **无独立 Evaluator**：执行 Agent 自行判定完成，无验收证据校验（Test 8 不满足）。
4. **无 Durable Queue / Worker**：长任务依赖一次 HTTP 请求存活（第 7 阶段不满足）。
5. **错误分类薄弱（本次已修关键项）**：详见 `01-failure-taxonomy.md`。
6. **可观察性不完整**：chat 主循环无 Goal/Task/Step/ToolCall ID 与 Token/Time 轨迹落库。

> 已具备的成熟要素：有界执行循环、模型感知上下文压缩与工具结果裁剪分离、确定性动作空间掩码与执行期门控（抗注入/抗漂移）、重复调用提醒、三级退避重试、密钥服务端隔离。这些是 2.0 的可靠地基，不应推倒重写。