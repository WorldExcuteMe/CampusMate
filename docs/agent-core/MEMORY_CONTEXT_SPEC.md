# MEMORY_CONTEXT_SPEC · 记忆分层 / 上下文构建

> 提案规范，未实现。现状：`memory.ts`（localStorage plan+滚动摘要）、`context.ts`（模型感知上限+压缩+裁剪）。
> 原则：**压缩摘要不取代任务状态与原始证据**；五类记忆隔离；Event Log/Memory/Task State/Checkpoint 不混为一谈。

## 1. 五类记忆（隔离 + 存储）

| 类别 | 内容 | 存储 | 隔离键 | 现状 |
|---|---|---|---|---|
| User Memory | 画像/偏好/长期目标 | `profiles`/`user_preferences`（复用） | user_id | 已有 |
| Session Context | 单会话对话历史/会话级偏好 | `agent_sessions` + `agent_messages`（新增） | session_id + user_id | 现 localStorage sessions |
| Task State | 任务结构化进度（事实来源） | `agent_tasks`/`agent_steps` | task_id + user_id | 无（新增） |
| Episodic Memory | 任务执行经历（事件/结果） | `agent_events`（只读回放） | task_id + user_id | 无（新增） |
| Procedural Memory | 已验证可复用技能/流程 | `agent_skills`（新增，需效果验证） | user_id（可选全局） | 无（第一阶段不做自学习） |

```ts
interface UserMemory { userId: string; profile: Profile; preferences: Record<string,unknown>; }
interface SessionContext { sessionId: string; userId: string; messages: ChatMessage[]; summary?: string; }
interface EpisodicEntry { taskId: string; eventSeq: number; type: string; payload: unknown; }
interface ProceduralSkill { id: string; userId: string; name: string; steps: unknown; verifiedBy: "evaluator"; successRate: number; }
```
**隔离强制**：所有读写带 user_id；Session/Task/Episodic 再带 session_id/task_id。跨用户/跨任务检索默认禁止。Procedural 第一阶段只读人工预置，不做 Dreaming/自学习（遵守"第一阶段不引入"）。

## 2. Context Builder（分层组装）

```ts
interface ContextLayers {
  stableInstructions: string;     // SYSTEM + scope.contract（稳定，可缓存）
  taskContext: string;            // 当前 Task/Step 结构化状态摘要（事实来源）
  userProfile: string;            // User Memory 精简
  relevantMemory: string;         // 检索到的相关 Episodic/Procedural（按 task 隔离）
  recentObservations: ChatMessage[]; // 近期工具结果/对话（保配对完整）
  toolSchemas: ToolDef[];         // Manifest 过滤后的工具
}
function buildContext(layers: ContextLayers, cap: number): ComposedContext;
```
顺序：stable → task → profile → memory → recent → user。预算分配接 `context.ts`（reserveOutput/工具 token/历史预算）。**Task State 摘要独立于压缩摘要**：即使历史被压缩，当前任务进度/验收/已得证据始终完整注入（不被压缩丢弃）。

## 3. Context Compression（修复交互完整性）

现状缺陷（代码证据）：`trimToBudget`（context.ts:167-172）超阈值时 `msgs.slice(head+1)` **逐条**丢弃最旧消息，可能拆散 `assistant(tool_calls)` 与其 `tool` 结果配对 → 上游 API 报 "tool_call_id without matching" 类错误。

修复规范：
```ts
// 按"轮次组"原子丢弃：一个 assistant(tool_calls) + 其后所有 tool 结果 = 一组
function groupTurns(msgs: ChatMessage[]): ChatMessage[][];
// 压缩时整组丢弃，绝不拆散 tool_call↔tool_result 配对
// 保留：system + 最新未完成轮次组 + 尾部 retain 预算内的完整组
```
- 工具结果裁剪（truncateTool，head+tail+取回提示）与历史压缩分离（保留现 DSH 理念）。
- 压缩只丢"已完成的旧轮次组"，被丢组的关键事实抽取进 `summarizeDropped`（保留），但**原始证据存 agent_evidence/artifacts，摘要只引用不取代**。
- 压缩后校验：无孤儿 tool 消息、无缺失 tool_call_id（单测断言）。

## 4. Artifact Reference

大对象（网页快照/文件/长工具输出）存 `agent_artifacts`（Storage/inline），上下文里只放引用 + head/tail 摘要 + 取回提示（现 truncateTool 理念扩展）。模型需完整内容时经 `rag_search`/`read_artifact` 取回。证据（agent_evidence）独立存储，Evaluator 直接读原始证据核验，不依赖压缩摘要。

## 5. Memory Isolation（强制）

1. 所有记忆表 RLS `auth.uid()=user_id`（DATABASE_SCHEMA_SPEC §4）。
2. Worker service_role 写入带 task.user_id，检索 Episodic/Procedural 限定 `task_id`/`user_id`。
3. Session Context 不跨会话泄漏；Task State 不跨任务泄漏。
4. 现 `memory.ts` 的 localStorage 全局键（`campusmate.memory.v1`）废弃 → 服务端按 user/session/task 隔离（解决多用户/多设备串记忆）。

## 6. 与现有代码衔接

- 保留 `context.ts` 的模型上限表/estimateTokens/compactionThreshold/retainTokens/truncateTool。
- 重构 `trimToBudget` 为按轮次组原子压缩（§3）。
- `memory.ts` 的 memoryPrompt 注入逻辑保留，但数据源改服务端分层；plan 改 agent_steps（TOOL_EXECUTION_SPEC create_plan）。
- `composeContext` 扩展为 ContextBuilder，新增 taskContext 层（事实来源恒注入）。