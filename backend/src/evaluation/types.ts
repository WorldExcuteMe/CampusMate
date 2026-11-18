// Headless Agent Evaluation & Optimization System —— 类型契约。
// 设计事实来源：现有 runtime（Worker/Store/API）、core/evaluator（执行期独立 Evaluator）、
// tests/agent-benchmark（30 任务脚本化基准）。本模块是「评测 CampusMate 整体表现」的
// Meta-Evaluation，不替代执行期 Evaluator。
// 约束：Node 24 类型剥离直跑（不用 enum / 参数属性）；仅类型与字面量联合。
import type {
  AcceptanceCriterion, Budget, ChatResult, CompletionCertificate, TaskStatus, ToolDef, Usage,
} from "../core/types.ts";
import type { AcademicTerm, CourseSchedule, InstitutionProfile } from "../core/personal-context.ts";

// ── 执行通道 ────────────────────────────────────────────────────────────────
// scripted：直接驱动 runAgentLoop（核心循环，毫秒级，确定性）。
// api-memory：HTTP API + Worker + InMemoryStore + 脚本化模型（完整运行时契约，不写真实库）。
// live：HTTP API + Worker + InMemoryStore + 真实 Provider/工具（真实模型能力，隔离数据）。
// legacy：既有 30 任务 scripted benchmark 适配器（兼容保留）。
export type TargetKind = "scripted" | "api-memory" | "live" | "legacy";

export type EvalDifficulty = "easy" | "medium" | "hard";
export type EvalSource = "fixed" | "generated" | "failure_replay";
export type EvalCategory = string;

// ── 测试用例 ────────────────────────────────────────────────────────────────
export interface EvalUserContext {
  profile?: Partial<InstitutionProfile> & { name?: string };
  term?: { name?: string; startDate: string; endDate: string; totalWeeks?: number; timezone?: string; institutionId?: string };
  schedules?: Array<Omit<CourseSchedule, "id" | "userId" | "termId">>;
  // 固定时钟（ISO）。缺省用真实当前时间。用于时间敏感场景的确定性复核。
  now?: string;
  sourceFixture?: "group-cursor" | "semester-csv" | "semester-ics";
}

// 脚本化模型单步：content 与 toolCalls 至少一个。toolCalls 为声明式简写，由 target 转成原生 ToolCall。
export interface ScriptStep {
  content?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown>; id?: string }>;
  usage?: { input: number; output: number };
  model?: string;
}

// 离线外部工具夹具：命中后直接返回该 JSON，不访问网络。键为工具名。
export interface ToolStub {
  ok?: Record<string, unknown>;
  error?: string;
  delayMs?: number;
}

// JSON 数据集的声明式期望（由 dataset.ts 归一化为 checks，便于人工/AI 编写）。
export interface ToolCallExpectation { name: string; min?: number; args?: Record<string, unknown>; argsContains?: Record<string, string>; }

export interface ExpectedBehavior {
  status?: TaskStatus | TaskStatus[];
  certificatePassed?: boolean;
  toolCalled?: ToolCallExpectation[];
  toolNotCalled?: string[];
  replyIncludes?: string[];
  replyAny?: string[];
  replyExcludes?: string[];
  replyRegex?: string[];
  inboxSaved?: { min?: number; max?: number; titleIncludes?: string; deadlineStartsWith?: string };
  opportunitySaved?: { min?: number; max?: number; titleIncludes?: string };
  pendingApproval?: number;
  evidenceVerified?: number;
  noWrite?: boolean;
  noToolErrors?: boolean;
  maxToolCalls?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  webSourceCited?: number;
}

// 多轮对话的一轮：同一 session 内顺序执行，模拟人类在聊天框连续输入。
export interface EvalTurn {
  prompt: string;
  // Same owner, independent chat sessions; a repeated key returns to that chat.
  sessionKey?: string;
  images?: string[];
  // 该轮的脚本化模型输出（api-memory 通道）；live 通道忽略。
  script?: ScriptStep[];
  // 该轮的检查；未声明则只看会话级 checks。
  checks?: EvalCheck[];
  // 该轮期望任务终态；缺省不单独约束（仍会记录状态）。
  expectedStatus?: TaskStatus | TaskStatus[];
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  difficulty: EvalDifficulty;
  source: EvalSource;
  // 留出集用例：默认 run 不加载，需显式 --holdout；用于检测过拟合。
  holdout?: boolean;
  // 探索性用例（AI 生成扩面）：不计入 Gate 通过率，只用于发现新失败。
  exploratory?: boolean;
  // 适用通道；缺省全部通道。legacy 通道由适配器单独处理。
  tiers?: Array<Exclude<TargetKind, "legacy">>;
  // 单轮任务提示词；多轮用例中作为会话标题/首轮兜底（loader 会填成首轮 prompt）。
  prompt: string;
  images?: string[];
  context?: EvalUserContext;
  // 多轮对话（同一 session/turn 语义，与人类聊天一致）；存在时每轮用 turns[i].script/checks。
  turns?: EvalTurn[];
  // 脚本化模型（单轮 case）。多轮请用 turns[].script。
  script?: ScriptStep[];
  // 工具白名单（仅这些工具可见）；缺省为 CLOUD_TOOLS 全集。
  toolNames?: string[];
  // 离线工具夹具（scripted/api-memory 默认离线；live 默认真实网络）。
  toolStubs?: Record<string, ToolStub>;
  budget?: Partial<Budget>;
  // 故障注入：脚本化/集成通道用于恢复力用例。
  simulate?: { transportError?: string };
  // 独立 Evaluator 的执行期验收条件（api-memory/live 可注入；scripted 不启用）。
  acceptance?: AcceptanceCriterion[];
  // 人类可读验收说明（Judge / 人工抽检参考，不参与确定性判定）。
  acceptanceNotes?: string[];
  judge?: { rubric?: string; minScore?: number; weight?: number };
  // 静态检查；JSON 也可只写 expected，由 dataset.ts 归一化为 checks。
  checks: EvalCheck[];
  tags?: string[];
}

export interface EvalSuite {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  holdout?: boolean;
  source?: string;
  cases: EvalCase[];
}

// ── 确定性检查（声明式、可序列化）──────────────────────────────────────────
// required=true 的检查全部通过，用例才算 passed；required=false 只产生告警。
type CheckBase = { id?: string; required?: boolean; label?: string };

export type EvalCheck =
  | (CheckBase & { kind: "status"; in: TaskStatus[] })
  | (CheckBase & { kind: "certificate"; passed: boolean })
  | (CheckBase & { kind: "tool_called"; name: string; min?: number; args?: Record<string, unknown>; argsContains?: Record<string, string> })
  | (CheckBase & { kind: "tool_not_called"; name: string })
  | (CheckBase & { kind: "tool_order"; names: string[] })
  | (CheckBase & { kind: "reply_includes"; all?: string[]; any?: string[] })
  | (CheckBase & { kind: "reply_excludes"; any: string[] })
  | (CheckBase & { kind: "reply_regex"; pattern: string; flags?: string })
  | (CheckBase & { kind: "inbox_saved"; min?: number; max?: number; titleIncludes?: string; deadlineStartsWith?: string })
  | (CheckBase & { kind: "opportunity_saved"; min?: number; max?: number; titleIncludes?: string })
  | (CheckBase & { kind: "pending_approval"; min?: number })
  | (CheckBase & { kind: "evidence_verified"; min?: number })
  | (CheckBase & { kind: "no_write" })
  | (CheckBase & { kind: "no_tool_errors" })
  | (CheckBase & { kind: "max_tool_calls"; n: number })
  | (CheckBase & { kind: "max_tokens"; n: number })
  | (CheckBase & { kind: "max_duration_ms"; n: number })
  | (CheckBase & { kind: "web_source_cited"; min?: number })
  | (CheckBase & { kind: "source_complete"; dataset: "messages" | "timetable"; minRecords?: number })
  | (CheckBase & { kind: "timetable_preview"; minRows: number })
  | (CheckBase & { kind: "artifact_export"; format: "md" | "docx" | "pdf"; minBytes?: number; contains?: string[]; minHeadings?: number; minBodyChars?: number });

export type EvalCheckKind = EvalCheck["kind"];

// ── 执行观测（统一结构化结果）──────────────────────────────────────────────
export interface TraceToolCall {
  seq: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  approvalPending?: boolean;
  // 结果摘要（默认 ≤1200 字符，完整结果写入 trace 文件）。
  resultPreview: string;
  durationMs?: number;
}

export interface TraceLlmRound {
  round: number;
  turn?: number;
  stage?: string;
  toolCalls: number;
  finishReason?: string | null;
  telemetry?: unknown;
}

export interface TraceStep {
  kind: "plan" | "act" | "verify" | "summarize";
  title: string;
  detail?: string;
}

export interface EvalTrace {
  caseId: string;
  target: TargetKind;
  startedAt: number;
  finishedAt: number;
  events: Array<{ seq: number; type: string; payload: Record<string, unknown>; at: number; turn?: number }>;
  llm: { requests: number; rounds: TraceLlmRound[]; models: string[]; telemetry: unknown[] };
  tools: TraceToolCall[];
  steps: TraceStep[];
  checkpointMessageCount?: number;
  // 真实 session（多轮/useSession 时存在）：与人类聊天使用同一 session 语义。
  session?: { id: string; messageCount?: number };
  // 多轮聚合时保留每轮独立 trace，便于定位“哪一轮出错”。
  turns?: EvalTrace[];
  finalStatus: string;
  finalOutput: string;
  certificate?: CompletionCertificate;
  error?: string;
}

export interface BusinessSnapshot {
  inbox: Array<{ id: string; title: string; deadline?: string | null }>;
  opportunities: Array<{ id: string; title: string; deadline?: string | null; sourceUrl?: string | null }>;
  pendingApprovals: number;
  artifacts: Array<{ id: string; kind: string; title?: string; format?: string; bytes?: number; inspectionPassed?: boolean; downloadVerified?: boolean; sourceArtifactId?: string; text?: string; headings?: number; bodyChars?: number; evidencePath?: string }>;
  evidenceVerified: number;
  linkedSources?: { dataset: "messages" | "timetable" | "reference"; records: number; pages: number; verified: boolean }[];
  timetablePreviews?: { rows: number; errorCount: number; verified: boolean }[];
}

// 单轮的可观测结果（多轮聚合时保留）。
export interface EvalTurnObservation {
  turn: number;
  prompt: string;
  taskId?: string;
  status: TaskStatus | "error";
  reply: string;
  toolCalls: TraceToolCall[];
  trace: EvalTrace;
  business: BusinessSnapshot;
  usage: Usage;
  durationMs: number;
  mock: boolean;
  error?: string;
}

export interface EvalObservation {
  case: EvalCase;
  target: TargetKind;
  status: TaskStatus | "error";
  reply: string;
  toolCalls: TraceToolCall[];
  trace: EvalTrace;
  business: BusinessSnapshot;
  usage: Usage;
  durationMs: number;
  mock: boolean;
  error?: string;
  // 多轮对话：每轮独立观测；会话级字段（status/reply/business/usage）为聚合结果。
  turns?: EvalTurnObservation[];
}

// ── 评分结果 ────────────────────────────────────────────────────────────────
export type FailureCategory =
  | "planning_error"
  | "tool_selection_error"
  | "tool_argument_error"
  | "context_missing"
  | "execution_recovery"
  | "evidence_missing"
  | "evidence_hallucination"
  | "safety_violation"
  | "side_effect_error"
  | "format_error"
  | "task_incomplete"
  | "budget_exceeded"
  | "runtime_error"
  | "response_quality";

export interface CheckResult {
  id: string;
  kind: EvalCheckKind | "runtime" | "judge";
  label: string;
  passed: boolean;
  required: boolean;
  detail: string;
}

export type EvalResultStatus = TaskStatus | "error" | "skipped";

export interface EvalResult {
  caseId: string;
  category: EvalCategory;
  difficulty: EvalDifficulty;
  source: EvalSource;
  holdout?: boolean;
  exploratory?: boolean;
  target: TargetKind;
  status: EvalResultStatus;
  passed: boolean;
  skippedReason?: string;
  checks: CheckResult[];
  failureCategory?: FailureCategory;
  failureReason?: string;
  durationMs: number;
  usage: { tokens: number; toolCalls: number; costUsd: number };
  replyPreview: string;
  tracePath?: string;
  // 供工作 Agent 快速定位，不重复整段 Trace。
  toolSequence: string[];
  // 多轮用例轮数（单轮为 1）。
  turnCount?: number;
}

export interface JudgeVerdict {
  score: number;      // 0–100
  passed: boolean;
  dimensions?: Record<string, number>;
  reason: string;
}

export interface Judge {
  name: string;
  evaluate(c: EvalCase, obs: EvalObservation): Promise<JudgeVerdict>;
}

// ── 运行与指标 ──────────────────────────────────────────────────────────────
export interface CategoryMetrics {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number;
}

export interface EvalMetrics {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  exploratory: number;
  passRate: number;             // passed / (total - skipped - exploratory)
  byCategory: Record<string, CategoryMetrics>;
  byDifficulty: Record<string, CategoryMetrics>;
  avgDurationMs: number;
  avgTokens: number;
  totalTokens: number;
  avgToolCalls: number;
  totalCostUsd: number;
  failureCategories: Record<string, number>;
  hardGateViolations: string[];
}

export interface EvalManifest {
  runId: string;
  label?: string;
  target: TargetKind;
  suites: string[];
  caseCount: number;
  createdAt: string;
  git: { commit: string; branch: string; dirty: boolean };
  node: string;
  model: { providerId?: string; displayName?: string; modelId?: string; baseUrlHost?: string; real: boolean };
  // 与人类聊天入口对齐的执行参数（reasoning/provider/session）。
  entry?: { reasoning?: string; providerId?: string; useSession?: boolean };
  systemPromptHash: string;
  toolsHash: string;
  datasetHashes: Record<string, string>;
  concurrency: number;
  offlineTools: boolean;
  seed?: number;
  notes?: string[];
}

export interface EvalRun {
  schemaVersion: 1;
  runId: string;
  label?: string;
  target: TargetKind;
  suites: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  manifest: EvalManifest;
  metrics: EvalMetrics;
  results: EvalResult[];
}

export interface CompactRunSummary {
  runId: string;
  label?: string;
  target: TargetKind;
  suites: string[];
  metrics: EvalMetrics;
  failures: Array<{
    caseId: string;
    category: string;
    failureCategory?: FailureCategory;
    reason: string;
    failedChecks: string[];
    toolSequence: string[];
    tracePath?: string;
    // 探索性/负样本失败：不计入通过率，但保留可见性。
    exploratory?: boolean;
  }>;
  reportPath?: string;
  resultsPath?: string;
}

// ── 通道接口 ────────────────────────────────────────────────────────────────
export interface TargetOptions {
  concurrency: number;
  defaultTimeoutMs: number;
  offlineTools: boolean;
  artifactsDir?: string;
  seed?: number;
  // live 通道使用：覆盖 env（默认从 process.env 构造，去掉真实数据库）。
  env?: Record<string, string | undefined>;
  now?: () => number;
  // 与人类聊天入口对齐：思考强度、指定供应商、单轮是否也使用真实 session。
  reasoning?: "auto" | "low" | "medium" | "high";
  providerId?: string;
  useSession?: boolean;
}

export interface TargetDescription {
  kind: TargetKind;
  label: string;
  realModel: boolean;
  durableStore: boolean;
  networkTools: boolean;
  supportsBusinessFacts: boolean;
  model?: EvalManifest["model"];
  notes: string[];
}

export interface EvalRunCaseOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface EvalTarget {
  readonly kind: TargetKind;
  setup(options: TargetOptions): Promise<void>;
  run(c: EvalCase, options: EvalRunCaseOptions): Promise<EvalObservation>;
  dispose(): Promise<void>;
  describe(): TargetDescription;
}

export interface RunOptions {
  suites: EvalSuite[];
  target: EvalTarget;
  concurrency: number;
  timeoutMs: number;
  label?: string;
  seed?: number;
  judge?: Judge;
  runsRoot?: string;
  offlineTools: boolean;
  // 与人类聊天入口对齐（透传给 Target.setup）。
  reasoning?: "auto" | "low" | "medium" | "high";
  providerId?: string;
  useSession?: boolean;
  // 留出集用例标记（用于 manifest/报告；Gate 要求单独运行）
  holdoutRun?: boolean;
  now?: () => number;
}

// ── 回归 Gate / 版本对比 ────────────────────────────────────────────────────
export interface GateThresholds {
  minPassRate: number;             // 候选版本最低通过率（默认 0.8）
  maxPassRateDrop: number;         // 相对基线最大允许下降（默认 0.03）
  minHoldoutPassRate: number;      // Holdout 最低通过率（默认 0.7）
  requireHoldout: boolean;         // 是否必须有 holdout 运行结果（默认 true）
  maxAvgDurationMs?: number;
  maxAvgCostUsd?: number;
  // 硬门槛类别：这些类别出现失败即拒绝晋级（默认 security/evidence）。
  hardCategories: string[];
}

export interface GateItem {
  name: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  ok: boolean;
  detail: string;
}

export interface GateOutcome {
  passed: boolean;
  reasons: string[];
  items: GateItem[];
  warnings: string[];
}

export interface RunComparison {
  baselineRunId: string;
  candidateRunId: string;
  baselineLabel?: string;
  candidateLabel?: string;
  overall: { baseline: number; candidate: number; delta: number };
  byCategory: Record<string, { baseline: number; candidate: number; delta: number }>;
  regressions: string[];   // 基线通过、候选失败
  improvements: string[];  // 基线失败、候选通过
  newCases: string[];
  removedCases: string[];
  cost: { baseline: number; candidate: number; delta: number };
  duration: { baseline: number; candidate: number; delta: number };
  manifestDiff: Record<string, { baseline: string | number | boolean; candidate: string | number | boolean }>;
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  minPassRate: 0.8,
  maxPassRateDrop: 0.03,
  minHoldoutPassRate: 0.7,
  requireHoldout: true,
  hardCategories: ["security", "evidence"],
};
