# TASK_RUNTIME_SPEC · Goal / Task / Step 生命周期

> 提案规范，未实现。结构化状态（agent_tasks/steps）= 事实来源；agent_events = 追踪；agent_checkpoints = 恢复。三者分离。
> 现状对照：`runChat`（chat.ts:371）只有进程内 20 轮循环，无独立 Task 生命周期、无持久状态、无 checkpoint。

## 1. 核心对象（TypeScript Interface）

```ts
type TaskStatus = "queued"|"running"|"needs_input"|"paused"|"succeeded"|"failed"|"cancelled";
type StepStatus = "pending"|"ready"|"running"|"succeeded"|"failed"|"skipped";
type Runtime = "cloud"|"local-companion"|"dev";

interface GoalSpec {
  id: string; userId: string;
  rawText: string;
  normalized: {
    objective: string;
    constraints: string[];        // 来源/时间/范围硬约束（接 scope.ts）
    acceptance: AcceptanceCriterion[];
    sourcePreference?: ("qq"|"wechat"|"web"|"any")[];
  };
  status: "active"|"done"|"abandoned";
  createdAt: string;
}

interface AcceptanceCriterion {
  id: string;
  kind: "artifact_exists"|"evidence_verified"|"field_present"|"count_min"|"no_expired"|"source_cited";
  params: Record<string, unknown>;
  required: boolean;
}

interface Budget { tokens: number; toolCalls: number; wallMs: number; costUsd: number; }
interface Usage  { tokens: number; toolCalls: number; wallMs: number; costUsd: number; }

interface Task {
  id: string; userId: string; goalId?: string; sessionId?: string;
  title: string; intent: string;
  status: TaskStatus; priority: number;
  lease: { owner: string|null; expiresAt: string|null; heartbeatAt: string|null };
  attempt: number; maxAttempts: number;
  budget: Budget; usage: Usage;
  lastCheckpointId?: string;
  cancelRequested: boolean;
  result?: TaskResult; error?: string;
  createdAt: string; updatedAt: string;
}

interface Step {
  id: string; taskId: string; userId: string; seq: number;
  kind: "plan"|"act"|"verify"|"summarize";
  title: string; dependsOn: string[];
  acceptance: AcceptanceCriterion[];
  status: StepStatus; attempt: number;
  outputRef?: string;             // artifact id
}

interface TaskResult {
  summary: string;
  certificate: CompletionCertificate;   // Evaluator 签发
  artifactIds: string[];
}

interface CompletionCertificate {
  taskId: string; evaluatedBy: "evaluator";
  passed: boolean;
  criteria: { id: string; passed: boolean; evidenceIds: string[]; note: string }[];
  evaluatedAt: string;
}
```

## 2. DAG

Step 以 `dependsOn` 构成 DAG。Planner 生成后做拓扑校验（无环、依赖存在）。`ready` = 所有依赖 `succeeded`。简单任务退化为单 Step（不强制多步规划，遵守"不让所有任务依赖模型自由规划"）。确定性工作用代码工作流 Step（kind=act 但 executor=code），语义判断才用 LLM Step。

```
plan ──► act(收集) ──► verify(核验) ──► summarize ──► [Evaluator]
              └─► act(落库, 幂等) ─┘
```

## 3. Task 状态机

```
            submit
   (none) ─────────► queued
                       │ claim(lease)
                       ▼
                    running ──────────────┐
   ┌───────────────────┼───────────────┐  │ lease 过期/崩溃
   │ needs_input        │ budget 耗尽   │  ▼
   │ (缺关键信息/审批)   │ (部分交付)    │ queued(重认领, attempt+1)
   ▼                    ▼               │
 paused ──resume──► running             │
   │                    │ Evaluator pass│
   │ cancel             ▼               │
   ▼                succeeded           │
 cancelled ◄──cancel── running          │
                        │ Evaluator fail / 不可恢复错误
                        ▼
                     failed ──retry(attempt<max)──► queued
```

转换规则（强制）：
1. `queued→running` 仅由 Worker claim（写 lease）。
2. `running→succeeded` **仅当 Evaluator 签发 passed=true**（执行 Agent 不得自判）。
3. `running→needs_input` 当缺关键信息或高危工具待审批；不自动续跑需人工确认的任务。
4. `running→failed` 当不可恢复错误或 Evaluator 拒绝；`attempt<maxAttempts` 可 retry 回 queued。
5. `cancelRequested=true` → Worker 在下一检查点协作式转 `cancelled`（不强杀，保证副作用一致）。
6. lease 过期且 `status=running` → 视为崩溃，回 queued 重认领（at-least-once）。
7. 预算耗尽 → 部分交付（`succeeded` 带 partial 证书）或 `needs_input` 请求决策，不无限重试。

## 4. Step 状态机

```
pending ──deps satisfied──► ready ──pick──► running ──┬─► succeeded
                                                      ├─► failed ──retry──► ready
                                                      └─► skipped(依赖失败/越界)
```

## 5. Event（append-only）

```ts
interface AgentEvent {
  id: number; taskId: string; userId: string; stepId?: string;
  seq: number;                       // 任务内单调
  type: EventType; payload: Record<string, unknown>;
  createdAt: string;
}
type EventType =
  | "goal.created" | "task.queued" | "task.claimed" | "step.started" | "step.finished"
  | "llm.request" | "llm.response" | "tool.called" | "tool.result" | "tool.approval_requested"
  | "checkpoint.written" | "budget.exceeded" | "eval.passed" | "eval.failed"
  | "task.needs_input" | "task.cancelled" | "task.failed" | "task.succeeded" | "lease.renewed";
```
事件只增不改不删；`seq` 由 Worker 在事务内 `max(seq)+1` 分配，保证有序。事件用于追踪/审计/回放，**不作为恢复的事实来源**（恢复用 checkpoint + 结构化状态）。

## 6. Checkpoint / Resume

```ts
interface Checkpoint {
  id: string; taskId: string; userId: string; stepId?: string;
  eventSeq: number;                  // 对齐事件流
  state: {
    messages: ChatMessage[];         // 当前上下文快照（含 tool_call-result 配对）
    stepProgress: Record<string, StepStatus>;
    repeat: Record<string, number>;  // 重复调用计数
    usage: Usage;
    pendingApprovals: string[];
  };
  createdAt: string;
}
```
写入时机：每个 Step 边界、每次工具副作用提交后、预算阈值跨越时。Resume：读 `last_checkpoint_id` → 还原 messages/stepProgress/usage → 从 `eventSeq` 之后继续；**已提交副作用由幂等键跳过**（不重复写业务数据）。崩溃恢复测试见 EVALUATION_SPEC（Test 进程崩溃）。

## 7. Retry / Error Recovery

错误分类（接 `errors.ts` 扩展）：
```ts
type ErrorClass = "transport"|"rate_limit"|"invalid_model_output"|"tool_transient"|"tool_permanent"|"permission"|"budget"|"evaluation";
```
策略：transport/rate_limit/tool_transient → 指数退避重试（上限 maxAttempts）；invalid_model_output → 结构化重试一次再降级；permission → needs_input 审批；tool_permanent → 换源/调整计划或 failed；budget → 部分交付/needs_input；evaluation → 补证据或 failed。**不无限重试**（attempt 上限 + 预算硬停）。

## 8. Cancellation

协作式：API 置 `cancel_requested=true`（RPC，不开放整行 update）；Worker 在每个检查点检查，若 true 则停止后续 Step、写 `task.cancelled` 事件、释放 lease、转 cancelled。已提交副作用不回滚（幂等保证一致），未提交不执行。

## 9. Budget

```ts
interface BudgetPolicy {
  onExceed: "partial_deliver"|"request_decision";
  hardStop: true;                    // 永远硬停，不超支
}
```
Worker 每轮累加 usage（tokens 来自 llm usage，toolCalls 计数，wallMs 计时，costUsd 按模型单价）。任一维度超 budget → 按 policy 部分交付或 needs_input。预算与 lease 独立：预算管"花多少"，lease 管"谁在跑"。

## 10. Lease / Heartbeat

```ts
interface LeaseConfig { ttlMs: number; heartbeatMs: number; concurrency: number; }
// 默认 ttl=60000, heartbeat=15000, concurrency=2
```
claim 用 `FOR UPDATE SKIP LOCKED`（DATABASE_SCHEMA_SPEC §6）。heartbeat 每 15s 续 `lease_expires_at=now()+ttl`。Worker 崩溃 → lease 过期 → 其他 Worker 重认领。单 Worker 时崩溃重启后自认领过期任务。幂等键保证重认领不重复副作用。

## 11. 与现有内核的衔接

保留 `runChat` 的：有界循环（MAX_TOOL_ROUNDS→Step 内预算）、原生 tool_calls + JSON 回退、noteRepeat 重复提醒、scope 动作掩码、错误边界、context 压缩/裁剪。改造点：循环状态外置到 Checkpoint；工具经 Capability Adapter；成功判定交 Evaluator；每步落 events/steps/invocations。