// 纯 Agent 执行循环（解耦自 web chat.ts runChat）。环境无关：transport/executeTool/时钟均注入。
// 保留：有界循环、原生 tool_calls + JSON 工具回退、重复提醒、错误边界、预算硬停。
import type { Budget, ChatMessage, CheckpointState, EventType, ToolDef, Usage } from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";
import type { LlmTransport } from "./llm.ts";
import { errorMessage, isTransportError } from "./errors.ts";
import { trimToBudget, toolsTokens, resolveContextCap, messagesTokens, RESERVE_OUTPUT } from "./context.ts";
import { checkBudget } from "./budget.ts";
import { budgetStopSummary } from "./budget.ts";
import type { GenerationStage } from "./generation-policy.ts";
import { argumentError } from "./tool-arguments.ts";
import { toolResultView } from "./task-events.ts";
import { LeaseLostError } from "./session-context.ts";
import { assessToolOutcomes } from './tool-outcomes.ts';
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR } from '../../../shared/tool-protocol.ts';

export class CheckpointWriteError extends Error {
  constructor(cause: unknown) { super("任务历史保存失败，请恢复重试", { cause }); }
}
class BudgetPauseError extends Error {}
export class TaskCancelledError extends Error {}

export interface AgentLoopHooks {
  onEvent?: (type: EventType, payload: Record<string, unknown>) => void | Promise<void>;
  onCheckpoint?: (state: CheckpointState) => void | Promise<void>;
  now?: () => number;
  pricePerToken?: number; // costUsd 估算，默认 0.5/1M
  onPromptUsage?: (usage: { inputTokens: number | null; contextLimit: number | null; outputReserve: number; source: "estimated" | "reported" | "unknown" }) => void | Promise<void>;
  prepareToolResult?: (name: string, raw: string) => Promise<string>;
  beforeRequest?: () => void | Promise<void>;
  toolMeta?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface AgentLoopDeps {
  transport: LlmTransport;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  tools: ToolDef[];
  budget: Budget;
  hooks?: AgentLoopHooks;
  maxRounds?: number;
  contextLimit?: number | null;
  reasoning?: string;
  stage?: GenerationStage;
  signal?: AbortSignal;
  isCancelled?: () => boolean | Promise<boolean>;
}

export interface AgentLoopResult {
  reply: string;
  actions: string[];
  usage: Usage;
  model: string;
  mock: boolean;
  rounds: number;
  budgetExceeded: boolean;
  paused: boolean;
  messages: ChatMessage[];
  transcript: ChatMessage[];
  truncated?: boolean;
  error?: string;
  telemetry?: import("./types.ts").LlmTelemetry;
  stopReason?: "completed" | "budget" | "cancelled" | "approval" | "round_limit" | "invalid_output" | "error";
  toolErrors?: number;
}

const MAX_TOOL_ROUNDS = 20;
const APPROVAL_PAUSE = "__approval_pending__";

export function parseJsonTool(content: string, known: Set<string>): { name: string; args: Record<string, unknown> } | null {
  const candidates: string[] = [];
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const brace = content.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      const name = obj.tool ?? obj.name ?? obj.function?.name;
      if (typeof name === "string" && known.has(name)) {
        let args = obj.args ?? obj.arguments ?? obj.parameters ?? {};
        if (typeof args === "string") args = JSON.parse(args);
        return { name, args };
      }
    } catch { /* try next */ }
  }
  return null;
}

function canonicalKey(name: string, args: Record<string, unknown>): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object"
      ? Object.keys(v as object).sort().reduce((o, k) => { o[k] = sort((v as Record<string, unknown>)[k]); return o; }, {} as Record<string, unknown>)
      : v;
  return name + ":" + JSON.stringify(sort(args));
}

function noteRepeat(repeat: Map<string, number>, name: string, args: Record<string, unknown>, messages: ChatMessage[]): void {
  const key = canonicalKey(name, args);
  const n = (repeat.get(key) ?? 0) + 1;
  repeat.set(key, n);
  if (n === 3 || n === 5 || n === 8) {
    messages.push({ role: "user", content: `[系统提醒] 工具 ${name} 已用相同参数调用 ${n} 次。若结果未变请停止重复重试：改用不同参数/来源，或基于已有结果直接总结；查不到不等于不存在，如实说明。` });
  }
}

export async function runAgentLoop(opts: Parameters<typeof runAgentLoopInternal>[0]): Promise<AgentLoopResult> {
  const result = await runAgentLoopInternal(opts);
  const outcomes = assessToolOutcomes(result.transcript, opts.resumeToolErrors ?? 0);
  result.toolErrors = outcomes.count;
  for (const recovery of outcomes.recovered) await opts.deps.hooks?.onEvent?.('tool.recovered', { ...recovery });
  result.stopReason ??= result.budgetExceeded ? "budget" : result.paused ? "approval" : result.mock || result.error || result.truncated ? "error" : "completed";
  return result;
}
async function runAgentLoopInternal(opts: {
  system: string;
  systemMessages?: ChatMessage[];
  user: string;
  images?: string[];
  history?: ChatMessage[];
  resumeMessages?: ChatMessage[];
  resumeTranscript?: ChatMessage[];
  initialUsage?: Usage;
  resumeUsage?: Usage;
  resumeToolErrors?: number;
  deps: AgentLoopDeps;
  repeat?: Map<string, number>;
  model?: string;
}): Promise<AgentLoopResult> {
  const { deps } = opts;
  const hooks = { ...deps.hooks, beforeRequest: async () => { if (await deps.isCancelled?.()) throw new TaskCancelledError(); await deps.hooks?.beforeRequest?.(); } };
  const now = hooks.now ?? Date.now;
  const price = hooks.pricePerToken;
  const maxRounds = deps.maxRounds ?? MAX_TOOL_ROUNDS;
  const known = new Set(deps.tools.map((t) => t.function.name));
  let uncertainEffects = JSON.stringify(opts.resumeTranscript ?? []).includes('tool_result_uncertain');
  const invoke = async (name: string, args: Record<string, unknown>) => {
    await hooks.beforeRequest?.();
    if (overBudget()) throw new BudgetPauseError();
    const tool = deps.tools.find((t) => t.function.name === name);
    if (!tool) return JSON.stringify({ error: "工具未在本轮授权范围内" });
    const invalid = argumentError(tool.function.parameters, args);
    const out = invalid ? JSON.stringify({ error: `工具参数无效：${invalid}`, class: 'tool_validation' }) : await deps.executeTool(name, args);
    if (out.includes('tool_result_uncertain')) uncertainEffects = true;
    return out;
  };
  const actions: string[] = [];
  const repeat = opts.repeat ?? new Map<string, number>();
  const start = now();
  const usage: Usage = { ...(opts.initialUsage ?? opts.resumeUsage ?? EMPTY_USAGE) };
  const priorWallMs = usage.wallMs;
  const transcript: ChatMessage[] = structuredClone(opts.resumeTranscript ?? []);
  let model = "unknown";
  const cap = deps.contextLimit ?? resolveContextCap(opts.model);
  const reserve = Math.min(RESERVE_OUTPUT, Math.floor(cap * 0.25));
  const tTools = toolsTokens(deps.tools);

  const userContent: ChatMessage["content"] = opts.images?.length
    ? [{ type: "text", text: opts.user }, ...opts.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
    : opts.user;
  let messages: ChatMessage[] = opts.resumeMessages
    ? structuredClone(opts.resumeMessages)
    : [...(opts.systemMessages ?? [{ role: "system" as const, content: opts.system }]), ...(opts.history ?? []), { role: "user", content: userContent }];
  let telemetry: import("./types.ts").LlmTelemetry | undefined;

  const emit = async (type: EventType, payload: Record<string, unknown>) => { await hooks.onEvent?.(type, payload); };
  const tracedTool = async (name: string, args: Record<string, unknown>, toolCallId: string, callInstanceId: string, resumed = false, parseError = false) => {
    await hooks.beforeRequest?.();
    const meta = await hooks.toolMeta?.(name, args) ?? {};
    const started = now();
    await emit("tool.called", { name, toolCallId, callInstanceId, resumed, ...meta });
    const out = parseError ? '{"error":"工具参数不是有效JSON"}' : await invoke(name, args);
    await emit("tool.result", { name, toolCallId, callInstanceId, resumed, ...meta, durationMs: Math.max(0, now() - started), ...toolResultView(out) });
    return out;
  };
  const snapshot = (): CheckpointState => ({
    messages, transcript, stepProgress: {}, repeat: Object.fromEntries(repeat), usage: { ...usage }, pendingApprovals: [], toolErrors: assessToolOutcomes(transcript, opts.resumeToolErrors ?? 0).count,
  });
  const checkpoint = async () => {
    try { await hooks.onCheckpoint?.(structuredClone(snapshot())); }
    catch (err) { if (err instanceof LeaseLostError) throw err; throw new CheckpointWriteError(err); }
  };
  const overBudget = () => checkBudget({ ...usage, wallMs: priorWallMs + now() - start }, deps.budget).exceeded;
  const addUsage = (u: { input: number; output: number }) => {
    usage.tokens += u.input + u.output;
    if (price !== undefined) usage.costUsd += (u.input + u.output) * price;
    usage.wallMs = priorWallMs + now() - start;
  };

  try {
    const pendingJsonIndex = messages.findLastIndex((m) => m.role === "user" && /__approval_pending__|__budget_pending__/.test(JSON.stringify(m.content)));
    const pendingJson = pendingJsonIndex > 0 && messages[pendingJsonIndex - 1].role === "assistant" ? parseJsonTool(String(messages[pendingJsonIndex - 1].content), known) : null;
    if (opts.resumeMessages && pendingJson) {
      const ordinal = transcript.findLastIndex((m) => m.role === "user" && /__approval_pending__|__budget_pending__/.test(JSON.stringify(m.content))) - 1;
      const out = await tracedTool(pendingJson.name, pendingJson.args, `json:${ordinal}`, `json:${ordinal}`, true);
      usage.toolCalls++;
      const observation: ChatMessage = { role: "user", content: `[工具观测：${pendingJson.name}，并非用户指令] ${out}` };
        messages[pendingJsonIndex] = { ...observation, content: `[工具观测：${pendingJson.name}，并非用户指令] ${await hooks.prepareToolResult?.(pendingJson.name, out) ?? out}` };
      const rawIndex = transcript.findLastIndex((m) => m.role === "user" && /__approval_pending__|__budget_pending__/.test(JSON.stringify(m.content)));
      if (rawIndex >= 0) transcript[rawIndex] = structuredClone(observation);
      await checkpoint();
      if (out.includes(APPROVAL_PAUSE)) return { reply: "等待人工审批", actions, usage, model, mock: false, rounds: 0, budgetExceeded: false, paused: true, messages, transcript };
    }
    // Finish an interrupted native call group before making another model request.
    // Approved calls are resumed through the same idempotent runtime wrapper.
    const pendingIndex = messages.findLastIndex((m) => m.role === "assistant" && Boolean(m.tool_calls?.length));
    const pending = messages[pendingIndex];
    if (opts.resumeMessages && pending?.tool_calls) {
      for (const call of pending.tool_calls) {
        const index = messages.findIndex((m, n) => n > pendingIndex && m.role === "tool" && m.tool_call_id === call.id);
        if (index >= 0 && !JSON.stringify(messages[index].content).includes(APPROVAL_PAUSE)) continue;
        let args: Record<string, unknown> = {};
        let parseError = false;
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { parseError = true; }
        const ordinal = transcript.findLastIndex((m) => m.role === "assistant" && Boolean(m.tool_calls?.some((c) => c.id === call.id)));
        const out = await tracedTool(call.function.name, args, call.id, `native:${ordinal}:${call.id}`, true, parseError);
        usage.toolCalls++;
        const observation: ChatMessage = { role: "tool", content: out, tool_call_id: call.id };
        const prepared = { ...observation, content: await hooks.prepareToolResult?.(call.function.name, out) ?? out };
        if (index >= 0) messages[index] = prepared; else messages.push(prepared);
        const rawIndex = transcript.findLastIndex((m) => m.role === "tool" && m.tool_call_id === call.id);
        if (rawIndex >= 0) transcript[rawIndex] = structuredClone(observation); else transcript.push(structuredClone(observation));
        if (out.includes(APPROVAL_PAUSE)) { await checkpoint(); return { reply: "等待人工审批", actions, usage, model, mock: false, rounds: 0, budgetExceeded: false, paused: true, messages, transcript }; }
      }
      await checkpoint();
    }
    for (let i = 0; i < maxRounds; i++) {
      if (overBudget()) { await emit("budget.exceeded", { usage }); break; }
      await hooks.beforeRequest?.();
      await emit("llm.request", { round: i });
      await hooks.onPromptUsage?.({ inputTokens: messagesTokens(messages) + tTools, contextLimit: deps.contextLimit ?? null, outputReserve: reserve, source: "estimated" });
      const res = await deps.transport.chat({ messages, tools: deps.tools, signal: deps.signal, reasoning: deps.reasoning, stage: deps.stage, deadlineAt: start + deps.budget.wallMs - priorWallMs, maxOutputTokens: Math.min(reserve, Math.max(1, deps.budget.tokens - usage.tokens)), onDelta: (text) => { void emit("llm.delta", { text, round: i }).catch(() => {}); } });
      telemetry = res.telemetry;
      if (!res.telemetry || res.telemetry.usage.inputTotal !== null) await hooks.onPromptUsage?.({ inputTokens: res.telemetry?.usage.inputTotal ?? res.usage.input, contextLimit: deps.contextLimit ?? null, outputReserve: reserve, source: "reported" });
      addUsage(res.usage);
      await hooks.beforeRequest?.();
      model = res.model;
      const continuation = res.reasoningContent !== undefined ? { reasoning_content: res.reasoningContent, reasoning_source: res.reasoningSource } : {};
      await emit("llm.response", { round: i, toolCalls: res.toolCalls.length, telemetry });
      if (hasRawToolMarkup(res.content)) {
        // Fail closed even for truncated/mixed responses; DSML text isn't a tool
        // invocation and must never certify a successful write or run by parsing.
        messages.push({ role: 'assistant', content: TOOL_PROTOCOL_ERROR });
        transcript.push({ role: 'assistant', content: TOOL_PROTOCOL_ERROR });
        await checkpoint();
        return { reply: TOOL_PROTOCOL_ERROR, actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, messages, transcript, telemetry, stopReason: 'invalid_output', error: 'tool_protocol_error' };
      }
      if (res.truncated) {
        const reply = res.content || "模型输出未完成，保留执行记录待继续。";
        messages.push({ role: "assistant", content: reply, ...continuation }); transcript.push({ role: "assistant", content: `[未完成草稿] ${reply}`, ...continuation });
        await checkpoint();
        return { reply, actions, usage, model: res.model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, truncated: true, messages, transcript, telemetry };
      }

      if (res.toolCalls.length > 0) {
        const request: ChatMessage = { role: "assistant", content: res.content, tool_calls: res.toolCalls, ...continuation };
        messages.push(request);
        transcript.push(structuredClone(request));
        for (const call of res.toolCalls) {
          let args: Record<string, unknown> = {};
          let parseError = false;
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { parseError = true; }
          const ordinal = transcript.findLastIndex((m) => m.role === "assistant" && Boolean(m.tool_calls?.some((c) => c.id === call.id)));
          const out = await tracedTool(call.function.name, args, call.id, `native:${ordinal}:${call.id}`, false, parseError);
          usage.toolCalls += 1;
          const observation: ChatMessage = { role: "tool", content: out, tool_call_id: call.id };
          messages.push({ ...observation, content: await hooks.prepareToolResult?.(call.function.name, out) ?? out });
          transcript.push(structuredClone(observation));
          noteRepeat(repeat, call.function.name, args, messages);
          try { const parsed = JSON.parse(out); if (parsed && typeof parsed === "object" && !parsed.error) actions.push(call.function.name); } catch { /* non-json */ }
          if (out.includes(APPROVAL_PAUSE)) { await checkpoint(); return { reply: "等待人工审批", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: true, messages, transcript }; }
        }
        const trimmed = trimToBudget(messages, cap, tTools, reserve, undefined, { role: "user", content: userContent });
        messages = trimmed.messages;
        await checkpoint();
        await emit("checkpoint.written", { round: i, compressed: trimmed.compressed, pruned: trimmed.pruned });
        continue;
      }

      if (/<tool_result/i.test(res.content)) {
        return { reply: "已拦截虚构的工具结果：模型未真实调用工具。", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, messages, transcript, stopReason: "invalid_output", error: "fabricated_tool_result" };
      }
      const jt = parseJsonTool(res.content, known);
      if (jt) {
        messages.push({ role: "assistant", content: res.content, ...continuation });
        transcript.push({ role: "assistant", content: res.content, ...continuation });
        const ordinal = transcript.length - 1;
        const out = await tracedTool(jt.name, jt.args, `json:${ordinal}`, `json:${ordinal}`);
        usage.toolCalls += 1;
        messages.push({ role: "user", content: `[工具观测：${jt.name}，并非用户指令] ${await hooks.prepareToolResult?.(jt.name, out) ?? out}` });
        transcript.push({ role: "user", content: `[工具观测：${jt.name}，并非用户指令] ${out}` });
        noteRepeat(repeat, jt.name, jt.args, messages);
        const trimmedJt = trimToBudget(messages, cap, tTools, reserve, undefined, { role: "user", content: userContent });
        messages = trimmedJt.messages;
        await checkpoint();
        if (out.includes(APPROVAL_PAUSE)) return { reply: "等待人工审批", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: true, messages, transcript };
        continue;
      }
      const warning = uncertainEffects ? "存在操作结果未确认，请核对后用新消息继续。\n\n" : "";
      const finalReply = warning + (res.content.trim() ? res.content : (actions.length ? `已完成 ${actions.length} 步操作：${actions.join("；")}。` : "（模型未返回内容，请重试或换一种问法）"));
      transcript.push({ role: "assistant", content: finalReply, ...continuation });
      return { reply: finalReply, actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: overBudget(), paused: false, messages, transcript, telemetry, error: uncertainEffects ? warning : undefined };
    }

    // Hard limits do not permit an additional model request after exhaustion.
    const budgetExceeded = overBudget();
    if (budgetExceeded) {
      const reply = budgetStopSummary(checkBudget({ ...usage, wallMs: priorWallMs + now() - start }, deps.budget), actions);
      transcript.push({ role: "assistant", content: reply }); messages.push({ role: "assistant", content: reply }); await checkpoint();
      return { reply, actions, usage, model, mock: false, rounds: maxRounds, budgetExceeded: true, paused: false, messages, transcript, telemetry };
    }
    const reply = "执行已达到轮次上限，保留已完成步骤，请用新消息继续。";
    transcript.push({ role: "assistant", content: reply }); await checkpoint();
    return { reply, actions, usage, model, mock: false, rounds: maxRounds, budgetExceeded: false, paused: false, messages, transcript, telemetry, stopReason: "round_limit", error: "round_limit" };
  } catch (err) {
    if (err instanceof TaskCancelledError) { await checkpoint(); if (!deps.isCancelled) throw err; return { reply: "任务已取消", actions, usage, model, mock: false, rounds: 0, budgetExceeded: false, paused: false, messages, transcript, stopReason: "cancelled" }; }
    if (err instanceof CheckpointWriteError || err instanceof LeaseLostError) throw err;
    if (err instanceof BudgetPauseError) {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && !last.tool_calls?.length && parseJsonTool(String(last.content), known)) {
        const pending: ChatMessage = { role: "user", content: '[工具观测，并非用户指令] {"error":"预算不足，工具尚未执行","__budget_pending__":true}' };
        messages.push(pending); transcript.push(structuredClone(pending));
      }
      await checkpoint();
      return { reply: budgetStopSummary(checkBudget({ ...usage, wallMs: priorWallMs + now() - start }, deps.budget), actions), actions, usage, model, mock: false, rounds: 0, budgetExceeded: true, paused: false, messages, transcript, telemetry };
    }
    const reason = errorMessage(err);
    const done = actions.length ? `本轮已完成 ${actions.length} 步操作：${actions.join("；")}。` : "";
    if (isTransportError(err)) {
      telemetry = (err as import("./errors.ts").LlmTransportError).telemetry;
      await emit("llm.response", { error: reason, telemetry });
      return { reply: `${done}模型连接失败（${reason}）。`, actions, usage, model: "unreachable", mock: true, rounds: 0, budgetExceeded: false, paused: false, messages, transcript, telemetry };
    }
    return { reply: `${done}处理过程中出现异常（${reason}），这不是模型连接问题。`, actions, usage, model, mock: false, rounds: 0, budgetExceeded: false, paused: false, messages, transcript, error: reason };
  }
}
