# DATABASE_SCHEMA_SPEC · Agent 运行时持久化

> 基于真实 `supabase/migrations/0001_init.sql` 取证。本文 DDL 为**提案，未应用**（本阶段禁止改库）。
> 原则：**结构化任务状态 = 事实来源；Event Log = 追踪；Checkpoint = 恢复**。三者分表，不混用。
> Agent 运行时表全部 `agent_` 前缀，**绝不与用户待办 `tasks` 表混淆**。

## 1. 现有表清单与复用判定（真实取证）

| 现有表 | 用途 | 判定 |
|---|---|---|
| `profiles` | 用户画像（id=auth.uid） | 复用（User Memory 来源） |
| `user_preferences` | 匹配权重 | 复用 |
| `information_sources` | 官方白名单（公共读） | 复用 |
| `inbox_items` | 收件箱（owner RLS） | 复用 + 加幂等列 |
| `opportunities` | 机会（**全局公共读，无 user_id**） | 复用 + 加审计/幂等列，写改服务端 |
| `opportunity_sources` | 机会来源 | 复用 |
| `match_assessments` | 匹配评估（owner，unique(opp,user)） | 复用 |
| `verification_reports` | 核验报告（**全局公共读，无 user_id**） | 重构：加 task_id/evaluated_by/证据门控 |
| `evidence_items` | 证据（全局公共读） | 复用 + 关联 agent_evidence |
| `goals`/`plans`/`tasks` | **用户业务域**目标/计划/待办 | 复用，**不是** Agent 运行时 |
| `activity_events` | 业务审计（owner） | 复用（业务审计，非 agent 事件日志） |
| `agent_runs` | 粗粒度运行记录（owner） | 复用为"任务级运行摘要"，细化由新表承担 |

关键取证缺口（代码证据）：
- `opportunities/verification_reports/evidence_items` 只有 `for select using(true)`（0001_init.sql:210-214），**无 insert/update 策略** → anon key 写入被 RLS 拒绝。现状 `SupabaseRepository.createOpportunity/createReport`（supabase.ts:154,187）在真实模式必然失败。
- `uid()`（data/types.ts:116）= `Math.random().toString(36)…`，**非 UUID**；所有 `id` 列是 `uuid` → 真实模式 insert 报 `invalid input syntax for type uuid`。
- `inbox_items` 无去重唯一约束；幂等仅靠浏览器 `localStorage SEEN_KEY`（qq.ts:27,79）。
- `updateInbox` 忽略 `mergedFrom`（supabase.ts:87-100 无该列）→ 合并引用丢失。

## 2. 新增表（提案 DDL，未应用）

### 2.1 agent_tasks（队列 + 任务事实来源）
```sql
create table agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  goal_id uuid references agent_goals(id) on delete set null,
  session_id uuid,                       -- 会话级隔离键（可空）
  title text not null,
  intent text not null default '',       -- 规范化目标
  status text not null default 'queued', -- queued|running|needs_input|succeeded|failed|cancelled|paused
  priority int not null default 50,
  -- 队列/lease
  lease_owner text,                      -- worker 实例 id
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  attempt int not null default 0,
  max_attempts int not null default 3,
  -- 预算（硬停）
  budget jsonb not null default '{"tokens":200000,"toolCalls":40,"wallMs":600000,"costUsd":0.5}',
  usage jsonb not null default '{"tokens":0,"toolCalls":0,"wallMs":0,"costUsd":0}',
  -- 恢复
  last_checkpoint_id uuid,
  cancel_requested boolean not null default false,
  result jsonb,                          -- 终态结果摘要 + 验收证书引用
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_agent_tasks_claim on agent_tasks(status, priority, created_at);
create index idx_agent_tasks_lease on agent_tasks(status, lease_expires_at);
create index idx_agent_tasks_user on agent_tasks(user_id, created_at);
```

### 2.2 agent_goals（目标，区别于业务 goals）
```sql
create table agent_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  raw_text text not null,
  normalized jsonb not null default '{}',  -- 规范化目标（约束/验收/来源偏好）
  status text not null default 'active',
  created_at timestamptz not null default now()
);
```

### 2.3 agent_steps（DAG 节点 + 验收条件）
```sql
create table agent_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seq int not null,
  kind text not null default 'act',      -- plan|act|verify|summarize
  title text not null,
  depends_on uuid[] not null default '{}',
  acceptance jsonb not null default '{}', -- 验收条件（Evaluator 用）
  status text not null default 'pending',-- pending|ready|running|succeeded|failed|skipped
  attempt int not null default 0,
  output_ref uuid,                       -- → agent_artifacts
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(task_id, seq)
);
create index idx_agent_steps_task on agent_steps(task_id, status);
```

### 2.4 agent_events（append-only 事件日志）
```sql
create table agent_events (
  id bigint generated always as identity primary key,  -- 单调有序
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references agent_steps(id) on delete set null,
  seq int not null,                      -- 任务内单调序号
  type text not null,                    -- goal.created|step.started|llm.request|tool.called|tool.result|checkpoint.written|eval.passed|task.failed…
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique(task_id, seq)
);
create index idx_agent_events_task on agent_events(task_id, seq);
```
事件日志**只增不改不删**（RLS 禁 update/delete，见 §4）。

### 2.5 agent_checkpoints（恢复点）
```sql
create table agent_checkpoints (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references agent_steps(id) on delete set null,
  event_seq int not null,                -- 对应事件序号（恢复对齐）
  state jsonb not null,                  -- messages 快照 + step 进度 + repeat 计数 + usage
  created_at timestamptz not null default now()
);
create index idx_agent_checkpoints_task on agent_checkpoints(task_id, created_at);
```

### 2.6 agent_tool_invocations（幂等 + 执行记录）
```sql
create table agent_tool_invocations (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references agent_steps(id) on delete set null,
  tool_name text not null,
  idempotency_key text not null,         -- 见 TOOL_EXECUTION_SPEC
  args_hash text not null,               -- canonical args sha256
  runtime text not null default 'cloud', -- cloud|local-companion|dev
  status text not null default 'pending',-- pending|running|succeeded|failed|approved|rejected
  approval_id uuid,                      -- 高危工具人工审批
  result jsonb,
  error text,
  attempt int not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique(task_id, idempotency_key)       -- ★ 幂等核心：同任务同键只执行一次
);
create index idx_agent_tool_inv_task on agent_tool_invocations(task_id);
```

### 2.7 agent_artifacts / agent_evidence（产物与证据引用）
```sql
create table agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,                    -- text|file|json|url_snapshot
  storage_path text,                     -- Supabase Storage（大对象）
  inline jsonb,                          -- 小对象内联
  sha256 text,
  created_at timestamptz not null default now()
);
create table agent_evidence (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null,
  excerpt text not null default '',
  retrieved_at timestamptz not null default now(),
  supports text not null default '',
  confidence numeric not null default 0.5,
  artifact_id uuid references agent_artifacts(id) on delete set null,
  verified boolean not null default false  -- Evaluator 核验后置 true
);
```

## 3. 现有表的最小增量（提案，未应用）

```sql
-- 幂等：inbox 去重键（服务端计算，替代 localStorage SEEN_KEY）
alter table inbox_items add column dedup_key text;
create unique index uq_inbox_user_dedup on inbox_items(user_id, dedup_key) where dedup_key is not null;
alter table inbox_items add column merged_from uuid[] not null default '{}';

-- 机会：审计 + 内容幂等（全局共享，写仅服务端）
alter table opportunities add column created_by uuid references auth.users(id);
alter table opportunities add column content_hash text;
create unique index uq_opp_content on opportunities(content_hash) where content_hash is not null;

-- 核验：绑定任务 + Evaluator 门控（禁止模型自判 VERIFIED 直接落库）
alter table verification_reports add column task_id uuid references agent_tasks(id);
alter table verification_reports add column evaluated_by text not null default 'pending'; -- pending|evaluator|human
alter table verification_reports add column evidence_count int not null default 0;
```
`verification_reports.status='VERIFIED'` 仅当 `evaluated_by='evaluator'` 且 `evidence_count>=1` 才允许（应用层 + 触发器双重强制，见 EVALUATION_SPEC）。

## 4. RLS 设计

```sql
-- 所有 agent_* 启用 RLS
alter table agent_tasks enable row level security;
-- …（agent_goals/steps/events/checkpoints/tool_invocations/artifacts/evidence 同）

-- 客户端：owner 只读自己的任务/事件/产物（写由服务端 service_role）
create policy agent_tasks_owner_read on agent_tasks for select using (auth.uid()=user_id);
create policy agent_events_owner_read on agent_events for select using (auth.uid()=user_id);
-- steps/checkpoints/tool_invocations/artifacts/evidence 同 owner_read

-- 客户端可提交目标/任务（insert 自己的），但不可改状态/lease（防伪造进度）
create policy agent_tasks_owner_insert on agent_tasks for insert with check (auth.uid()=user_id and status='queued');
-- 取消：仅允许置 cancel_requested（用 RPC 封装，不开放整行 update）

-- 事件日志 append-only：无 update/delete 策略 → 客户端与 service_role 之外不可改
-- （service_role 绕过 RLS，但代码层只 insert 事件，绝不 update/delete）
```

## 5. Worker 安全访问 / Service Role 限制 / 防跨用户

1. **service_role 仅服务端**：只存在于 Backend/Worker 环境变量，绝不进 SPA（现状 `config.ts` 浏览器只用 anon，遵守）。
2. **Worker 绕过 RLS 但代码强制隔离**：每次写 agent_* / 业务表，`user_id` 取自 `agent_tasks.user_id`（认领时读出），**不接受工具参数里的 user_id**；执行前断言 `task.user_id` 与目标行 owner 一致。
3. **API 层**：验 Supabase JWT 得 uid，提交任务时 `user_id=uid`；查询/取消/审批前校验 `task.user_id===uid`，否则 403。
4. **全局参考数据写**：opportunities/reports/evidence 由 service_role 写，带 `created_by=uid` 审计；客户端仍只读。
5. **id 生成**：agent_* 与业务写一律由 Postgres `gen_random_uuid()` 生成（insert 省略 id），**废弃客户端 `uid()` 传 id**（修非 UUID 缺陷）。
6. **Storage**：agent_artifacts 大对象走 Supabase Storage，bucket 策略按 `user_id` 前缀隔离。

## 6. 队列可行性（PostgreSQL 轻量队列）

`FOR UPDATE SKIP LOCKED` + `lease_expires_at` 实现认领/崩溃重投，单 Worker 限并发足够小规模产品。无需 Redis/Kafka。lease TTL 默认 60s，heartbeat 15s；崩溃后 ≤TTL 被重认领。幂等键保证重投不重复副作用。验证项见 ARCHITECTURE_REVIEW（待验证：Supabase 连接池下 SKIP LOCKED 行为，需用直连/事务验证）。