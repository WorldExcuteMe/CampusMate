// 前缀缓存观测（Phase 1）与可选前缀稳定策略（Phase 2，CM_PREFIX_POLICY=1）。
// 在请求体完成序列化、发送之前按段计算指纹与 token 估算；事件只含哈希、长度、角色与计数，
// 绝不把提示词正文写进 telemetry。缓存块粒度按 AMD 端点实测取 1024 tokens：
// 1226 token 的相同前缀命中 cached_tokens=1024；系统提示词中段改写使缓存整段失效，
// 末尾追加只保留旧前缀命中；思考档位切换会让端点在最前面注入不同思考提示词，同样整段失效。
import { createHash } from "node:crypto";
import type { ChatMessage, LlmTelemetry, ToolDef } from "./types.ts";
import { COMPACTION_SUMMARY_MARKER, contentText, messagesTokens, toolsTokens } from "./context.ts";
import { canonicalArgs } from "../runtime/idempotency.ts";

export const PREFIX_TRACE_VERSION = 1;
/** 端点 KV 缓存按块命中；AMD 端点实测 1226 token 前缀命中 1024。 */
export const CACHE_BLOCK_TOKENS = 1024;

export type ToolPlacement = "body" | "system" | "none";
export type SystemChange = "unchanged" | "appended" | "middle";
export type DivergenceKind = "initial" | "none" | "extended" | "changed" | "truncated";
export type PrefixChangeSegment = "system" | "tools" | "effort" | "history-rewrite" | "scope";
export type ChangeKind = "initial" | "none" | "tail-only" | "prefix-append" | "invalidating";

export interface SegmentSummary { hash: string; chars: number; tokens: number; count: number; }
export interface MessageSubsetSummary extends SegmentSummary { indices: number[]; }
export interface ToolSegment extends SegmentSummary { names: string[]; placement: ToolPlacement; changed: boolean; added: string[]; removed: string[]; }
export interface HistoryBoundary { index: number; role: ChatMessage["role"]; hash: string; chars: number; tokens: number; }
export interface FirstDivergence { kind: DivergenceKind; index: number | null; previousRequestId: string | null; }
export interface EffortFingerprint { requested: string; effective: string | null; family: string; stage: string; }

/** 提供商会话/账号/工作区作用域。只暴露哈希前缀，原始 id 永不进入事件。 */
export interface PrefixScope {
  id: string;
  source: "explicit" | "endpoint";
  /** userId 与 workspaceId 都由调用方显式提供时才为 true。 */
  complete: boolean;
  userIdHash: string | null;
  workspaceHash: string | null;
  conversationHash: string | null;
}

export interface PrefixCacheEstimate {
  /** 端点缓存块大小（tokens）。 */
  blockTokens: number;
  /** 系统提示词 + 工具定义（不含历史）的估算 token。 */
  stablePrefixTokens: number;
  /** 思考档位为 high/max 时端点前置注入的思考提示词估算；未配置时为 null。 */
  preambleTokens: number | null;
  preambleExpected: boolean;
  preambleUnaccounted: boolean;
  coldPrefixTokens: number;
  coldPrefixBlockTokens: number;
  matchedHistoryMessages: number;
  reusablePrefixTokens: number;
  /** floor(reusablePrefixTokens / 1024) * 1024，0 表示没有可复用的缓存块。 */
  expectedCacheableTokens: number;
  basis: "no-baseline" | "previous-request";
  prefixInvalidatingChange: boolean;
  changedSegments: PrefixChangeSegment[];
  changedSegment: PrefixChangeSegment | null;
  changeKind: ChangeKind;
}

export interface PrefixPolicyTrace {
  enabled: boolean;
  mode: "observe-only" | "tail-stable";
  effortLocked: boolean;
  /** 自动工具裁剪默认关闭：裁剪会改变可见工具集（前缀 B 变化），必须由显式阶段切换驱动并记录。 */
  toolPruning: "disabled";
  notes: string[];
}

export interface ObservedUsage { inputTokens: number | null; cachedTokens: number | null; }

export interface PrefixTrace {
  version: number;
  requestId: string;
  /** 本 transport 实例内的模型请求序号（0 起）。 */
  requestSeq: number;
  round: number | null;
  stage: string | null;
  scope: PrefixScope;
  policy: PrefixPolicyTrace;
  /** 段 A：领先 system 区（jsonTools 端点合并后含工具协议正文）的精确序列化字节。 */
  system: SegmentSummary & { change: SystemChange; hoisted: number };
  /** 段 B：工具定义 canonical JSON。placement=system 时内容位于段 A 内，stablePrefix 不重复计数。 */
  tools: ToolSegment;
  /** 段 C：system 区之后每条消息边界的滚动哈希链。 */
  history: {
    messages: number;
    chars: number;
    tokens: number;
    rollingHash: string;
    boundaries: HistoryBoundary[];
    firstDivergence: FirstDivergence;
  };
  /** 段 D：历史压缩摘要消息（逻辑子集，C 仍包含其物理字节）。 */
  compaction: MessageSubsetSummary;
  /** 段 E：运行期动态观测（tool 结果、JSON 协议工具观测、尾部 system 注入、重复提醒）。 */
  dynamicTail: MessageSubsetSummary & { roles: ChatMessage["role"][] };
  effort: EffortFingerprint & {
    preambleExpected: boolean;
    preambleTokens: number | null;
    changed: boolean;
    previous: EffortFingerprint | null;
  };
  cache: PrefixCacheEstimate;
  total: { chars: number; tokens: number };
  overhead: { hashedChars: number; hashCalls: number; elapsedMs: number };
  /** 响应返回后由 transport 回填：提供商实际报告值，用于和 expectedCacheableTokens 对照。 */
  observed?: ObservedUsage;
}

/** LlmTelemetry + prefixTrace。LlmTelemetry 在 types.ts 中保持稳定，观测数据以结构扩展附加。 */
export type PrefixTelemetry = LlmTelemetry & { prefixTrace?: PrefixTrace };

export interface PrefixScopeInput { userId?: string; workspaceId?: string; conversationId?: string; }

export interface PrefixTracerOptions {
  baseUrl: string;
  model: string;
  policy: boolean;
  scope?: PrefixScopeInput;
  /** 端点注入的思考提示词 tokens 估算，键为 effective 档位（high/max）。 */
  preambleTokens?: Record<string, number>;
  now?: () => number;
}

export interface PrefixRequestInput {
  requestId: string;
  round?: number | null;
  stage?: string | null;
  /** 实际发送的 messages 数组。 */
  messages: ChatMessage[];
  /** messages 中领先 system 消息的数量（段 A 的边界）。 */
  systemEnd: number;
  tools: ToolDef[];
  toolPlacement: ToolPlacement;
  /** 合并 system 之前的原始消息（用于识别压缩摘要与尾部动态观测的逻辑位置）。 */
  sourceMessages?: ChatMessage[];
  effort: EffortFingerprint;
  /** 本次实际发送的思考参数（用于 Phase 2 在同一任务阶段锁定档位）。 */
  effortParams?: Record<string, unknown>;
  effortLocked: boolean;
  policyNotes?: string[];
  bodyChars: number;
  bodyTokens: number;
}

interface HashMeter { calls: number; chars: number; }
interface PreviousRequest { trace: PrefixTrace; systemText: string; effortParams: Record<string, unknown> | null; }

const HISTORY_CHAIN_SEED = "prefix-trace:v1:history";
const USER_OBSERVATION_RE = /^\[(?:工具观测|系统提醒)[：，\]]/;
const HIGH_EFFORT = new Set(["medium", "high", "max"]);

function sha(text: string, meter: HashMeter): string {
  meter.calls += 1;
  meter.chars += text.length;
  return createHash("sha256").update(text).digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function messageText(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function leadingSystemCount(messages: ChatMessage[]): number {
  let index = 0;
  while (index < messages.length && messages[index].role === "system") index += 1;
  return index;
}

function buildScope(baseUrl: string, model: string, input?: PrefixScopeInput): PrefixScope {
  const explicit = Boolean(input && (input.userId || input.workspaceId || input.conversationId));
  const id = sha(
    canonicalArgs({
      version: PREFIX_TRACE_VERSION,
      provider: baseUrl.replace(/\/+$/, ""),
      model,
      userId: input?.userId ?? null,
      workspaceId: input?.workspaceId ?? null,
      conversationId: input?.conversationId ?? null,
    }),
    { calls: 0, chars: 0 },
  );
  return {
    id,
    source: explicit ? "explicit" : "endpoint",
    complete: Boolean(input?.userId && input?.workspaceId),
    userIdHash: input?.userId ? shortHash(input.userId) : null,
    workspaceHash: input?.workspaceId ? shortHash(input.workspaceId) : null,
    conversationHash: input?.conversationId ? shortHash(input.conversationId) : null,
  };
}

function classifySystemChange(previousText: string, currentText: string): SystemChange {
  if (previousText === currentText) return "unchanged";
  // 末尾追加保留既有缓存前缀；从中间改写会让端点缓存整段失效。
  if (currentText.length > previousText.length && currentText.startsWith(previousText)) return "appended";
  return "middle";
}

function firstDivergence(previous: PrefixTrace | undefined, boundaries: HistoryBoundary[]): FirstDivergence {
  if (!previous) return { kind: "initial", index: null, previousRequestId: null };
  const prior = previous.history.boundaries;
  const limit = Math.min(prior.length, boundaries.length);
  for (let index = 0; index < limit; index += 1) {
    if (prior[index].hash !== boundaries[index].hash) {
      return { kind: "changed", index, previousRequestId: previous.requestId };
    }
  }
  if (boundaries.length > prior.length) {
    return { kind: "extended", index: prior.length, previousRequestId: previous.requestId };
  }
  if (boundaries.length < prior.length) {
    return { kind: "truncated", index: boundaries.length, previousRequestId: previous.requestId };
  }
  return { kind: "none", index: null, previousRequestId: previous.requestId };
}

function matchedHistory(
  divergence: FirstDivergence,
  boundaries: HistoryBoundary[],
  totalTokens: number,
): { messages: number; tokens: number } {
  switch (divergence.kind) {
    case "none":
      return { messages: boundaries.length, tokens: totalTokens };
    case "extended":
    case "changed": {
      const index = divergence.index ?? 0;
      return { messages: index, tokens: index > 0 ? boundaries[index - 1].tokens : 0 };
    }
    case "truncated":
      return { messages: boundaries.length, tokens: boundaries.length > 0 ? boundaries[boundaries.length - 1].tokens : 0 };
    default:
      return { messages: 0, tokens: 0 };
  }
}

/**
 * 每个 transport 实例持有一条「上一次请求」基线：模型请求串行，基线不回跨任务/用户复用。
 * Phase 2 的推理档位锁定也只在本实例内生效，因此不会把某个任务阶段的策略带到另一个任务。
 */
export class PrefixTracer {
  readonly scope: PrefixScope;
  private readonly policy: boolean;
  private readonly preambleTokens: Record<string, number> | undefined;
  private readonly now: () => number;
  private sequence = 0;
  private previous: PreviousRequest | undefined;
  private pending: PreviousRequest | undefined;

  constructor(options: PrefixTracerOptions) {
    this.policy = options.policy;
    this.preambleTokens = options.preambleTokens;
    this.now = options.now ?? (() => performance.now());
    this.scope = buildScope(options.baseUrl, options.model, options.scope);
  }

  /** 请求发出前用当前 wire 前缀做一次廉价比较，供 Phase 2 决定是否锁定思考档位。 */
  phaseUnchanged(messages: ChatMessage[], systemEnd: number, tools: ToolDef[], placement: ToolPlacement): boolean {
    const previous = this.previous;
    if (!previous) return false;
    const system = this.summarizeSystem(messages, systemEnd, { calls: 0, chars: 0 });
    const tool = this.summarizeTools(tools, placement, { calls: 0, chars: 0 });
    return previous.trace.system.hash === system.hash
      && previous.trace.tools.hash === tool.hash
      && previous.trace.tools.placement === placement;
  }

  previousEffort(): EffortFingerprint | null {
    return this.previous?.trace.effort ?? null;
  }

  previousEffortParams(): Record<string, unknown> | null {
    return this.previous?.effortParams ?? null;
  }

  /** 完整记录一次已序列化请求；调用 commit() 后才成为下一次请求的基线。 */
  record(input: PrefixRequestInput): PrefixTrace {
    const startedAt = this.now();
    const meter: HashMeter = { calls: 0, chars: 0 };
    const previous = this.previous?.trace;
    const sourceMessages = input.sourceMessages ?? input.messages;
    const sourceLeading = leadingSystemCount(sourceMessages);
    const system = this.summarizeSystem(input.messages, input.systemEnd, meter);
    const tools = this.summarizeTools(input.tools, input.toolPlacement, meter);
    const bodyMessages = input.messages.slice(input.systemEnd);
    const history = this.summarizeHistory(bodyMessages, meter);
    const divergence = firstDivergence(previous, history.boundaries);
    const compaction = this.summarizeCompaction(sourceMessages, sourceLeading, meter);
    const dynamicTail = this.summarizeDynamicTail(sourceMessages, sourceLeading, meter);
    const wireBodySystem = input.messages.slice(input.systemEnd).filter((message) => message.role === "system").length;
    const sourceBodySystem = sourceMessages.slice(sourceLeading).filter((message) => message.role === "system").length;
    const hoisted = Math.max(0, sourceBodySystem - wireBodySystem);
    const systemText = input.messages.slice(0, input.systemEnd).map(messageText).join("\u0000");
    const systemChange = previous ? classifySystemChange(this.previous?.systemText ?? "", systemText) : "unchanged";

    const toolsChanged = previous
      ? previous.tools.hash !== tools.hash || previous.tools.placement !== tools.placement
      : false;
    const toolNames = tools.names;
    const previousNames = new Set(previous?.tools.names ?? []);
    const currentNames = new Set(toolNames);
    const added = previous ? toolNames.filter((name) => !previousNames.has(name)).sort() : [];
    const removed = previous ? (previous?.tools.names ?? []).filter((name) => !currentNames.has(name)).sort() : [];
    tools.changed = toolsChanged;
    tools.added = added;
    tools.removed = removed;
    tools.names = toolNames;

    const effortChanged = previous
      ? previous.effort.family !== input.effort.family || previous.effort.effective !== input.effort.effective
      : false;
    const effort: PrefixTrace["effort"] = {
      ...input.effort,
      preambleExpected: input.effort.effective !== null && HIGH_EFFORT.has(String(input.effort.effective)),
      preambleTokens: null,
      changed: effortChanged,
      previous: previous?.effort ?? null,
    };
    const preambleEstimated = effort.preambleExpected && this.preambleTokens
      ? this.preambleTokens[String(input.effort.effective)]
      : undefined;
    effort.preambleTokens = preambleEstimated ?? null;

    const changedSegments: PrefixChangeSegment[] = [];
    if (previous) {
      const scopeChanged = previous.scope.id !== this.scope.id;
      if (systemChange === "middle") changedSegments.push("system");
      if (toolsChanged) changedSegments.push("tools");
      if (effortChanged) changedSegments.push("effort");
      if (divergence.kind === "changed" || divergence.kind === "truncated") changedSegments.push("history-rewrite");
      if (scopeChanged) changedSegments.push("scope");
    }
    const stablePrefixTokens = system.tokens + (input.toolPlacement === "body" ? tools.tokens : 0);
    const preambleCount = effort.preambleExpected ? preambleEstimated ?? 0 : 0;
    const coldPrefixTokens = stablePrefixTokens + preambleCount;
    let reusablePrefixTokens = 0;
    let matchedHistoryMessages = 0;
    let basis: PrefixCacheEstimate["basis"] = previous ? "previous-request" : "no-baseline";
    let changeKind: ChangeKind = previous ? "none" : "initial";
    if (previous) {
      if (previous.scope.id !== this.scope.id) {
        changeKind = "invalidating";
      } else if (systemChange === "appended" && !toolsChanged && !effortChanged) {
        // 段 A 仅在末尾追加：旧 system 前缀仍可命中，但历史整体后移，不能复用。
        reusablePrefixTokens = previous.cache.coldPrefixTokens;
        changeKind = "prefix-append";
      } else if (systemChange === "unchanged" && !toolsChanged && !effortChanged) {
        const matched = matchedHistory(divergence, history.boundaries, history.tokens);
        matchedHistoryMessages = matched.messages;
        reusablePrefixTokens = stablePrefixTokens + preambleCount + matched.tokens;
        changeKind = divergence.kind === "extended" ? "tail-only" : divergence.kind === "none" ? "none" : "invalidating";
      } else {
        changeKind = "invalidating";
      }
    }
    // 无基线或作用域切换时不推断可复用块；history-rewrite 只丢改写点之后的块。
    if (previous && previous.scope.id === this.scope.id && changedSegments.some((segment) => segment === "system" || segment === "tools" || segment === "effort")) {
      reusablePrefixTokens = 0;
    }
    if (changedSegments.includes("history-rewrite")) basis = "previous-request";
    const cache: PrefixCacheEstimate = {
      blockTokens: CACHE_BLOCK_TOKENS,
      stablePrefixTokens,
      preambleTokens: effort.preambleTokens,
      preambleExpected: effort.preambleExpected,
      preambleUnaccounted: effort.preambleExpected && effort.preambleTokens === null,
      coldPrefixTokens,
      coldPrefixBlockTokens: Math.floor(coldPrefixTokens / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS,
      matchedHistoryMessages,
      reusablePrefixTokens,
      expectedCacheableTokens: Math.floor(reusablePrefixTokens / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS,
      basis,
      prefixInvalidatingChange: changedSegments.length > 0,
      changedSegments,
      changedSegment: changedSegments[0] ?? null,
      changeKind,
    };

    const notes = [...(input.policyNotes ?? [])];
    if (this.policy && !this.scope.complete) notes.push("scope-incomplete");
    const trace: PrefixTrace = {
      version: PREFIX_TRACE_VERSION,
      requestId: input.requestId,
      requestSeq: this.sequence,
      round: input.round ?? null,
      stage: input.stage ?? null,
      scope: this.scope,
      policy: {
        enabled: this.policy,
        mode: this.policy ? "tail-stable" : "observe-only",
        effortLocked: input.effortLocked,
        toolPruning: "disabled",
        notes,
      },
      system: { ...system, change: systemChange, hoisted },
      tools,
      history: { ...history, firstDivergence: divergence },
      compaction,
      dynamicTail,
      effort,
      cache,
      total: { chars: input.bodyChars, tokens: input.bodyTokens },
      overhead: {
        hashedChars: meter.chars,
        hashCalls: meter.calls,
        elapsedMs: Math.round((this.now() - startedAt) * 1000) / 1000,
      },
    };
    this.sequence += 1;
    this.pending = { trace, systemText, effortParams: input.effortParams ?? null };
    return trace;
  }

  /** 请求实际开始发送后调用：本次记录成为后续请求的基线。 */
  commit(): void {
    if (this.pending) {
      this.previous = this.pending;
      this.pending = undefined;
    }
  }

  private summarizeSystem(messages: ChatMessage[], systemEnd: number, meter: HashMeter): SegmentSummary {
    const region = messages.slice(0, systemEnd);
    const bytes = JSON.stringify(region);
    return { hash: sha(bytes, meter), chars: bytes.length, tokens: messagesTokens(region), count: region.length };
  }

  private summarizeTools(tools: ToolDef[], placement: ToolPlacement, meter: HashMeter): ToolSegment {
    const canonical = canonicalArgs(tools);
    return {
      hash: sha(canonical, meter),
      chars: placement === "none" ? 0 : canonical.length,
      tokens: placement === "none" ? 0 : toolsTokens(tools),
      count: tools.length,
      names: tools.map((tool) => tool.function.name),
      placement,
      changed: false,
      added: [],
      removed: [],
    };
  }

  private summarizeHistory(messages: ChatMessage[], meter: HashMeter): PrefixTrace["history"] {
    let rolling = sha(HISTORY_CHAIN_SEED + "|" + this.scope.id, meter);
    let chars = 0;
    let tokens = 0;
    const boundaries: HistoryBoundary[] = [];
    for (const [index, message] of messages.entries()) {
      const bytes = JSON.stringify(message);
      chars += bytes.length;
      tokens += messagesTokens([message]);
      rolling = sha(rolling + "\n" + bytes, meter);
      boundaries.push({ index, role: message.role, hash: rolling, chars, tokens });
    }
    return { messages: messages.length, chars, tokens, rollingHash: rolling, boundaries, firstDivergence: { kind: "initial", index: null, previousRequestId: null } };
  }

  private summarizeCompaction(messages: ChatMessage[], start: number, meter: HashMeter): MessageSubsetSummary {
    const indices: number[] = [];
    const matched: ChatMessage[] = [];
    messages.slice(start).forEach((message, offset) => {
      if (message.role === "system" && typeof message.content === "string" && message.content.startsWith(COMPACTION_SUMMARY_MARKER)) {
        indices.push(start + offset);
        matched.push(message);
      }
    });
    const bytes = JSON.stringify(matched);
    return { hash: sha(bytes, meter), chars: bytes.length, tokens: messagesTokens(matched), count: matched.length, indices };
  }

  private summarizeDynamicTail(messages: ChatMessage[], start: number, meter: HashMeter): MessageSubsetSummary & { roles: ChatMessage["role"][] } {
    const indices: number[] = [];
    const roles: ChatMessage["role"][] = [];
    const matched: ChatMessage[] = [];
    messages.slice(start).forEach((message, offset) => {
      const text = contentText(message.content).trimStart();
      const runtimeSystem = message.role === "system" && !text.startsWith(COMPACTION_SUMMARY_MARKER);
      const userObservation = message.role === "user" && USER_OBSERVATION_RE.test(text);
      if (runtimeSystem || userObservation || message.role === "tool") {
        indices.push(start + offset);
        roles.push(message.role);
        matched.push(message);
      }
    });
    const bytes = JSON.stringify(matched);
    return { hash: sha(bytes, meter), chars: bytes.length, tokens: messagesTokens(matched), count: matched.length, indices, roles };
  }
}
