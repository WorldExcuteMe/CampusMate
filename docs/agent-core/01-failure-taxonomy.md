# 01 · 失败分类学（Failure Taxonomy）

> 基于真实代码与本次修复。重点：用户报告的「真实模型调用中断（[object Object]）」根因已定位并修复，附回归测试证据。

## F0 · 真实模型调用中断（[object Object]）—— 已修复（最高优先级）

### 现象
Agent 回答任意问题时返回：`真实模型调用中断（[object Object]）。以下为规则提取（Mock，非真实模型）…`，整轮降级为假 Mock。

### 根因链（三处叠加缺陷）
1. **工具执行不兜底 DB 异常**：`save_to_inbox`/`create_opportunity`/`create_daily_task` 等工具调 `repo.createInbox` 等；`SupabaseRepository` 在失败时 `throw error`，而 `error` 是 **PostgrestError 普通对象** `{message,details,hint,code}`，**不是 Error 实例**（lib/data/supabase.ts:27,52,84,123,168,195…）。旧 `executeTool` 无外层 try/catch，异常冒泡到 `runChat`。
2. **catch 误判 + 误序列化**：旧 `runChat` catch 把**任何**异常都当作「真实模型调用中断」，并 `String(err)`。对普通对象 `String({…}) === "[object Object]"`（旧 chat.ts:466）。于是一次**模型其实已成功**的回合，因工具写库失败被误报为模型中断并整体降级。
3. **记忆写入可抛错**：`appendMemory`/`setPlan` 直接 `localStorage.setItem`，配额满/隐私模式抛错（旧 memory.ts:21,45），在成功返回前一刻把成功答复误降级。

### 修复（根因级，非补丁）
- 新增 `lib/llm/errors.ts`：`errorMessage(err)` 对 Error/字符串/PostgrestError 对象/嵌套对象/循环引用/null 全部产出可读消息，**永不 [object Object]**；`LlmTransportError` 标记真实传输失败。
- `executeTool` 加安全边界（chat.ts:72-89）：任何工具/DB/网络异常 → `{error: errorMessage(e)}` 作为**观测回传模型**，模型循环不中断，可重试/如实说明。
- `runChat` catch 精确分类（chat.ts:463-477）：仅 `LlmTransportError` 报「模型连接失败」；其余如实报告且 `mock:false`，不再伪造规则提取数据。
- `proxy.ts` 错误统一 `errorMessage` 并抛 `LlmTransportError`（proxy.ts:70,112,130）。
- `memory.ts` 写入 best-effort（memory.ts:20-27,42-50）；`AgentChatPage.send()` try/catch/finally 兜底（AgentChatPage.tsx:88-114）；`orchestrator.ts` 同步用 `errorMessage`。

### 证据
- 单测 `errors.test.ts`（10）+ 集成 `chatResilience.test.ts`（3）：工具写库抛 PostgrestError 对象 → `mock:false`、错误可读回传、无 [object Object]；真实传输失败 → 可读、`mock:true`；localStorage 配额抛错 → 成功答复不降级。
- 全量 **82 测试通过 / 16 文件**，`tsc --noEmit` exit 0。
- 真实模型冒烟：`POST https://api.deepseek.com/chat/completions` → HTTP 200，model `deepseek-flash`，reply「在线」，948ms（密钥服务端读取）。

## 其余失败类（现状与恢复策略）

| 编号 | 失败类 | 现状 | 恢复策略 | 缺口 |
|---|---|---|---|---|
| F1 | 网络瞬断 / 502/503/504 | 客户端 3 次 + 服务端 4 次退避 + edge 回退 | 自动重试 | 无跨进程续跑 |
| F2 | 上游 4xx（密钥/上下文超限） | `errorMessage` 透传真实原因 | 不重试，可读报错 | 无自动换 provider |
| F3 | 模型输出非 JSON / 无效工具指令 | `parseChat`/`parseJsonTool` 兜底 | 可读报错 / 跳过 | 无结构化重试约束 |
| F4 | 工具失败（终端/文件/网络/RAG） | `toolPost` + `executeTool` 边界 → error 观测 | 模型据此重试/换源 | 无错误分类驱动的策略选择 |
| F5 | DB 写入失败 | **本次修复**：error 观测，不中断 | 模型如实说明 | 无幂等键，重试可能重复写 |
| F6 | 重复工具死循环 | `noteRepeat` 3/5/8 提醒 + 20 轮上限 | 强制最终总结 | 无预算（token/time/cost）硬停 |
| F7 | 上下文超窗 | `composeContext`/`trimToBudget` 压缩+裁剪 | 自动 | 压缩摘要未与原始证据分离存储 |
| F8 | 幻觉工具结果 | `<tool_result>` 拦截（chat.ts:432） | 拦截并提示 | 无独立 Evaluator 验收 |
| F9 | 进程崩溃 / 用户中断 | 循环进度仅在内存 | **无** | 无 Checkpoint/Resume（Test 3/6） |
| F10 | 来源冲突 | 提示词要求标注，无机制 | 依赖模型自觉 | 无冲突检测与裁决 |
| F11 | Prompt Injection | scope 硬锁定 + 动作掩码 + 工具内容仅为数据 | 确定性门控 | 已较稳健 |

## 优先级结论
F0 已闭环。下一步最高价值不是堆叠工具/技能，而是 **F9（持久化任务状态+Checkpoint+恢复）** 与 **F8（独立 Evaluator）**——把 Agent 从「会调工具的 LLM」升级为「能独立管理目标/状态/异常/结果的系统」。详见 `02-execution-trace-analysis.md` 与后续目标架构。