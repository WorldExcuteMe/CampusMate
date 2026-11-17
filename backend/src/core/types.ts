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

export interface ProviderSnapshot {
  providerId: string; displayName: string; protocol: string; baseUrl: string; modelId: string;
  capabilities: Record<string, unknown>; contextLimit: number | null; metadataSource: string; configVersion: string;
  reasoningPreference?: "auto" | "low" | "medium" | "high";
}

export interface Task {
  id: string;
  userId: string;
  goalId?: string;
  sessionId?: string;
  turnId?: string;
  turnSeq?: number;
  inputHash?: string;
  transcriptCommitted?: boolean;
  promptUsage?: { inputTokens: number | null; contextLimit: number | null; outputReserve: number; source: "estimated" | "reported" | "unknown" };
  modelConfig?: ProviderSnapshot;
  modelRuntime?: { actualModel: string; providerId?: string; lastRequest?: LlmTelemetry };
  title: string;
  intent: string;
  images?: string[];
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
  historyRevision?: string;
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
  completion?: { state: "complete" | "partial"; reason: string; checks?: { id: string; passed: boolean; detail?: string }[] };
}

export type EventType =
  | "goal.created" | "task.queued" | "task.claimed" | "step.started" | "step.finished"
  | "llm.request" | "llm.response" | "tool.called" | "tool.result" | "tool.recovered" | "tool.approval_requested"
  | "llm.delta"
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
  documentRun?: import("./proposal.ts").DocumentRun;
  messages: ChatMessage[];
  transcript?: ChatMessage[];
  stepProgress: Record<string, StepStatus>;
  repeat: Record<string, number>;
  usage: Usage;
  pendingApprovals: string[];
  toolErrors?: number; // Optional for checkpoints written by older versions.
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
export type MessageContent = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContent[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Opaque provider continuation data. Server-only; never emit as visible text. */
  reasoning_content?: string;
  reasoning_source?: string;
}
export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  model: string;
  truncated?: boolean;
  streamInterrupted?: boolean; // SSE ended early without caller abort, length stop or protocol error.
  finishReason?: string | null;
  telemetry?: LlmTelemetry;
  reasoningContent?: string;
  reasoningSource?: string;
}

export interface NormalizedLlmUsage {
  inputTotal: number | null; output: number | null; reasoning: number | null; cacheRead: number | null; cacheWrite: number | null;
  reasoningIncludedInOutput: boolean | null; costUsd: number | null; source: "reported" | "unknown"; raw: Record<string, unknown> | null;
}
export interface LlmTelemetry {
  requestId: string; attempts: number; ttftMs: number | null; totalMs: number; finishReason: string | null;
  stablePrefixHash: string; toolsHash: string; usage: NormalizedLlmUsage;
  reasoning: { requested: string; effective: string | null; family: string; stage: string; reason: string };
}

export interface ToolResult { ok: true; data: unknown; invocationId: string; }
export interface ToolError { ok: false; error: string; class: ErrorClass; retryable: boolean; invocationId: string; }

export const DEFAULT_BUDGET: Budget = { tokens: 200_000, toolCalls: 40, wallMs: 600_000, costUsd: 0.5 };
export const EMPTY_USAGE: Usage = { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 };
