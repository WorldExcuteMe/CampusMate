// Agent 运行时核心类型（提案规范的实现）。结构化状态=事实来源；Event=追踪；Checkpoint=恢复。
// 零运行时依赖；仅类型与字面量联合（erasableSyntaxOnly，可被 Node 类型剥离直接运行）。

export type TaskStatus =
  | "queued" | "running" | "needs_input" | "paused"
  | "succeeded" | "failed" | "cancelled";

export type StepStatus =
  | "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";

export type Runtime = "cloud" | "local-companion" | "dev";

export type ErrorClass =
  | "transport" | "rate_limit" | "invalid_model_output"
  | "tool_transient" | "tool_permanent" | "permission" | "budget" | "evaluation";

export interface AcceptanceCriterion {
  id: string;
  kind: "artifact_exists" | "evidence_verified" | "field_present" | "count_min" | "no_expired" | "source_cited";
  params: Record<string, unknown>;
  required: boolean;
}

export interface Budget { tokens: number; toolCalls: number; wallMs: number; costUsd: number; }
export interface Usage { tokens: number; toolCalls: number; wallMs: number; costUsd: number; }

export interface GoalSpec {
  id: string;
  userId: string;
  rawText: string;
  normalized: {
    objective: string;
    constraints: string[];
    acceptance: AcceptanceCriterion[];
    sourcePreference?: ("qq" | "wechat" | "web" | "any")[];
  };
  status: "active" | "done" | "abandoned";
  createdAt: string;
}

export interface Lease { owner: string | null; expiresAt: number | null; heartbeatAt: number | null; }

export interface Task {
  id: string;
  userId: string;
  goalId?: string;
  sessionId?: string;
  title: string;
  intent: string;
  status: TaskStatus;
  priority: number;
  lease: Lease;
  attempt: number;
  maxAttempts: number;
  budget: Budget;
  usage: Usage;
  lastCheckpointId?: string;
  cancelRequested: boolean;
  result?: TaskResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Step {
  id: string;
  taskId: string;
  userId: string;
  seq: number;
  kind: "plan" | "act" | "verify" | "summarize";
  title: string;
  dependsOn: string[];
  acceptance: AcceptanceCriterion[];
  status: StepStatus;
  attempt: number;
  outputRef?: string;
}

export interface CriterionResult { id: string; passed: boolean; evidenceIds: string[]; note: string; }

export interface CompletionCertificate {
  taskId: string;
  evaluatedBy: "evaluator";
  passed: boolean;
  criteria: CriterionResult[];
  evaluatedAt: number;
}

export interface TaskResult {
  summary: string;
  certificate?: CompletionCertificate;
  artifactIds: string[];
  partial?: boolean;
}

export type EventType =
  | "goal.created" | "task.queued" | "task.claimed" | "step.started" | "step.finished"
  | "llm.request" | "llm.response" | "tool.called" | "tool.result" | "tool.approval_requested"
  | "checkpoint.written" | "budget.exceeded" | "eval.passed" | "eval.failed"
  | "task.needs_input" | "task.cancelled" | "task.failed" | "task.succeeded" | "lease.renewed";

export interface AgentEvent {
  id: number;
  taskId: string;
  userId: string;
  stepId?: string;
  seq: number;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CheckpointState {
  messages: ChatMessage[];
  stepProgress: Record<string, StepStatus>;
  repeat: Record<string, number>;
  usage: Usage;
  pendingApprovals: string[];
}

export interface Checkpoint {
  id: string;
  taskId: string;
  userId: string;
  stepId?: string;
  eventSeq: number;
  state: CheckpointState;
  createdAt: number;
}

export interface ToolInvocation {
  id: string;
  taskId: string;
  userId: string;
  stepId?: string;
  toolName: string;
  idempotencyKey: string;
  argsHash: string;
  runtime: Runtime;
  status: "pending" | "running" | "succeeded" | "failed" | "approved" | "rejected";
  approvalId?: string;
  result?: unknown;
  error?: string;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
}

// LLM 对话契约（与 web/src/lib/llm/proxy.ts 对齐）
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string }; }
export interface ToolDef { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> }; }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  model: string;
}

export interface ToolResult { ok: true; data: unknown; invocationId: string; }
export interface ToolError { ok: false; error: string; class: ErrorClass; retryable: boolean; invocationId: string; }

export const DEFAULT_BUDGET: Budget = { tokens: 200_000, toolCalls: 40, wallMs: 600_000, costUsd: 0.5 };
export const EMPTY_USAGE: Usage = { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 };