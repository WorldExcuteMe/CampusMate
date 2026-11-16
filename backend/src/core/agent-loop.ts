// 纯 Agent 执行循环（解耦自 web chat.ts runChat）。环境无关：transport/executeTool/时钟均注入。
// 保留：有界循环、原生 tool_calls + JSON 工具回退、重复提醒、错误边界、预算硬停。
import type { Budget, ChatMessage, CheckpointState, EventType, ToolDef, Usage } from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";
import type { LlmTransport } from "./llm.ts";
import { errorMessage, isTransportError, isStorageUnavailable } from "./errors.ts";
import { trimToBudget, toolsTokens, resolveContextCap, messagesTokens, RESERVE_OUTPUT } from "./context.ts";
import { checkBudget } from "./budget.ts";
import { budgetStopSummary } from "./budget.ts";
import type { GenerationStage } from "./generation-policy.ts";
import { argumentError } from "./tool-arguments.ts";
import { toolResultView } from "./task-events.ts";
import { LeaseLostError } from "./session-context.ts";
import { toolResultFailed } from "./tool-result.ts";
import { parseTextToolCall, looksLikeToolCall } from "./tool-protocol.ts";

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
  recoveredReadErrors?: number;
}

const MAX_TOOL_ROUNDS = 20;
const APPROVAL_PAUSE = "__approval_pending__";

export function parseJsonTool(content: string, known: Set<string>): { name: string; args: Record<string, unknown> } | null {
  return parseTextToolCall(content, known);
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
  const rawErrors = (messages: ChatMessage[]) => messages.filter((m) => m.role === "tool" ? toolResultFailed(String(m.content)) : m.role === "user" && typeof m.content === "string" && m.content.startsWith("[工具观测：") && toolResultFailed(m.content.replace(/^\[工具观测：[^\]]+\]\s*/, ""))).length;
  const requiredText = [opts.user, ...(opts.history ?? []).filter(m => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[工具观测")).map(m => String(m.content))].join("\n");
  const recovered = !result.error && !result.mock && !result.truncated && !result.budgetExceeded && !result.paused ? recoveredFetchErrors(result.transcript, requiredText, result.reply, new Set(opts.deps.tools.map(t => t.function.name))) : 0;
  // Preserve errors whose original observations are absent from an old checkpoint.
  result.toolErrors = Math.max(0, (opts.resumeToolErrors ?? 0) - rawErrors(opts.resumeTranscript ?? [])) + rawErrors(result.transcript) - recovered;
  if (recovered) {
    const oldReply = result.reply;
    result.reply = `有${recovered}次网页读取失败；摘要采用已取得并列出的资料，未成功读取的链接仅作入口，未核实部分仍需核对。\n\n${oldReply}`;
    const last = result.transcript.at(-1); if (last?.role === "assistant" && last.content === oldReply) last.content = result.reply;
    result.recoveredReadErrors = recovered;
  }
  result.stopReason ??= result.budgetExceeded ? "budget" : result.paused ? "approval" : result.mock || result.error || result.truncated ? "error" : "completed";
  return result;
}
function toolObservations(messages: ChatMessage[], known: Set<string>, toolName: string) {
  type Call = { name: string; args: Record<string, unknown> };
  const calls = new Map<string, Call>(); let lastTextCall: Call | null = null;
  const observations: { index: number; call: Call; data: Record<string, unknown>; failed: boolean }[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) { try { calls.set(call.id, { name: call.function.name, args: JSON.parse(call.function.arguments) }); } catch { /* Invalid calls remain errors. */ } }
      lastTextCall = typeof message.content === "string" ? parseJsonTool(message.content, known) : null;
    }
    let call: Call | undefined, content: string | undefined;
    if (message.role === "tool") { call = calls.get(message.tool_call_id ?? ""); content = String(message.content); }
    if (message.role === "user" && typeof message.content === "string") {
      const match = /^\[工具观测：([^，\]]+)(?:，[^\]]*)?\]\s*([\s\S]*)$/.exec(message.content);
      if (match && lastTextCall?.name === match[1]) { call = lastTextCall; content = match[2]; }
    }
    if (call?.name !== toolName || content === undefined) continue;
    try { const data = JSON.parse(content); if (data && typeof data === "object") observations.push({ index, call, data, failed: toolResultFailed(content) }); } catch { /* No structured fetch proof. */ }
  }
  return observations;
}
function fetchObservations(messages: ChatMessage[], known: Set<string>) { return toolObservations(messages, known, "web_fetch"); }
function informationSourceCandidates(messages: ChatMessage[], known: Set<string>, user: string): string[] {
  const topic = user.replace(/^\s*(?:(?:请|帮我|麻烦)\s*)*(?:收集|搜集|查询|查找|搜索|了解|介绍)\s*/, "").replace(/的?(?:信息|资料|情况)[。！？\s]*$/, "");
  const focus = topic.match(/[\u3400-\u9fff]{4,}/g)?.sort((a, b) => b.length - a.length)[0];
  const grams = focus ? [...new Set(Array.from({ length: focus.length - 1 }, (_, i) => focus.slice(i, i + 2)))] : [];
  const attempted = fetchObservations(messages, known).map(o => o.call.args.url).filter((url): url is string => typeof url === "string");
  const failedHosts = new Set(attempted.flatMap(url => { try { return [new URL(url).hostname]; } catch { return []; } }));
  const candidates = new Map<string, number>();
  for (const observation of toolObservations(messages, known, "web_search")) {
    if (observation.failed || !Array.isArray(observation.data.results)) continue;
    for (const result of observation.data.results) {
      if (!result || typeof result !== "object" || typeof result.url !== "string") continue;
      const description = String(result.title ?? "") + " " + String(result.snippet ?? "");
      if (grams.length && grams.filter(gram => description.includes(gram)).length < Math.max(2, Math.ceil(grams.length * 0.35))) continue;
      try {
        const url = new URL(result.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || attempted.includes(url.href)) continue;
        const score = (/\.(edu\.cn|edu)$/.test(url.hostname) ? 100 : 0) + (/\.html?$/i.test(url.pathname) ? 10 : 0) - (failedHosts.has(url.hostname) ? 200 : 0) - (/^\/(?:default\.[^/]+|index\.[^/]+)?$/i.test(url.pathname) ? 20 : 0);
        if (!candidates.has(url.href)) candidates.set(url.href, score);
      } catch { /* Search data never authorizes malformed or invented URLs. */ }
    }
  }
  return [...candidates].sort((a, b) => b[1] - a[1]).map(([url]) => url).slice(0, 2);
}
function advanceNoticesOnly(sources: ReturnType<typeof fetchObservations>): boolean {
  return sources.length > 0 && sources.every(o => {
    const text = String(o.data.text);
    const heading = text.slice(0, 300).match(/(?:关于|参赛|报名|竞赛|大赛|赛事).{0,100}?通知/)?.[0];
    return Boolean(heading)
      // A notice can describe successful past editions in its body. Only a
      // result/report heading distinguishes it from an advance announcement.
      && !/成功举办|圆满(?:结束|落幕)|获奖|(?:结果|成绩).{0,15}(?:通知|公示)|决赛战报/.test(heading!);
  });
}
function noticeStatusGuard(reply: string, sources: ReturnType<typeof fetchObservations>): string {
  if (!advanceNoticesOnly(sources)) return reply;
  // A published schedule is not proof of an actual event or current status.
  // Omit unsupported conclusions; never invent a replacement date/result.
  const supported = reply.split(/\n|(?<=[。！？])/).filter(part =>
    !/(?:已经?|现已|目前已).{0,30}(?:结束|截止|落幕|举行|举办|完成|完赛|闭幕|收官)|圆满(?:结束|落幕)|成功举办|非报名期/.test(part)
    && !/(?:赛事|竞赛|比赛|报名|当前|最新).{0,6}(?:状态|进展|时效)|(?:状态|时效)[：:]/.test(part)
    && !/(?:暂无|尚无|尚未|未曾|没有).{0,30}(?:发布|公布|报名信息|报名通知|官方.{0,10}(?:信息|通知))/.test(part)
    && !(/(?:总决赛|决赛|赛事|竞赛|比赛).{0,60}于.{0,35}(?:举行|举办)/.test(part) && !/拟|计划|暂定|预定|预计|定于/.test(part)),
  ).join("\n").trim();
  return "资料时效：本次读取的是参赛通知；实际举办情况、最新报名状态及下一届安排尚未核实。\n\n" + supported;
}
function recoveredFetchErrors(messages: ChatMessage[], requiredText: string, reply: string, known: Set<string>): number {
  const observations = fetchObservations(messages, known);
  return observations.filter(o => o.failed && typeof o.call.args?.url === "string" && !requiredText.includes(o.call.args.url) && observations.some(later =>
    later.index > o.index && !later.failed && Number(later.data.status) >= 200 && Number(later.data.status) < 300 && typeof later.data.text === "string" && later.data.text.trim().length > 0 && typeof later.data.url === "string" && reply.includes(later.data.url),
  )).length;
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
    const out = invalid ? JSON.stringify({ error: `工具参数无效：${invalid}` }) : await deps.executeTool(name, args);
    if (out.includes('tool_result_uncertain')) uncertainEffects = true;
    return out;
  };
  const actions: string[] = [];
  const repeat = opts.repeat ?? new Map<string, number>();
  const start = now();
  const usage: Usage = { ...(opts.initialUsage ?? opts.resumeUsage ?? EMPTY_USAGE) };
  const priorWallMs = usage.wallMs;
  const transcript: ChatMessage[] = structuredClone(opts.resumeTranscript ?? []);
  let informationReadAttempted = transcript.some(m => m.tool_calls?.some(c => c.id.startsWith("information-read:")));
  let model = "unknown";
  let protocolRepairs = 0;
  let synthesizing = false;
  const briefInformation = (!deps.stage || deps.stage === "simple") && /^\s*(?:(?:请|帮我|麻烦)\s*)*(收集|搜集|查询|查找|搜索|了解|介绍)/.test(opts.user) && !/详细|全面|长文|报告|对比|分别|保存|写入|导出|生成|制作|计划|方案|推导|验证|核验/.test(opts.user);
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
    messages, transcript, stepProgress: {}, repeat: Object.fromEntries(repeat), usage: { ...usage }, pendingApprovals: [],
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
      // A brief collection has a bounded search -> read -> summary path. These
      // are real traced tool invocations, never fabricated model observations.
      if (briefInformation && known.has("web_fetch") && !informationReadAttempted && !/https?:\/\//.test(opts.user)
        && !fetchObservations(transcript, known).some(o => !o.failed && Number(o.data.status) >= 200 && Number(o.data.status) < 300 && typeof o.data.text === "string" && o.data.text.trim())) {
        const candidates = informationSourceCandidates(transcript, known, opts.user);
        if (candidates.length) {
          informationReadAttempted = true;
          let read = false;
          for (const url of candidates) {
            if (overBudget()) break;
            const id = `information-read:${transcript.length}`;
            const request: ChatMessage = { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url }) } }] };
            messages.push(request); transcript.push(structuredClone(request));
            const out = await tracedTool("web_fetch", { url }, id, `native:${transcript.length - 1}:${id}`);
            usage.toolCalls++;
            const observation: ChatMessage = { role: "tool", content: out, tool_call_id: id };
            messages.push({ ...observation, content: await hooks.prepareToolResult?.("web_fetch", out) ?? out }); transcript.push(structuredClone(observation));
            if (!toolResultFailed(out)) actions.push("web_fetch");
            await checkpoint();
            read = fetchObservations(transcript, known).some(o => !o.failed && Number(o.data.status) >= 200 && Number(o.data.status) < 300 && typeof o.data.text === "string" && o.data.text.trim());
            if (read) break;
          }
          messages = trimToBudget(messages, cap, tTools, reserve, undefined, { role: "user", content: userContent }).messages;
          if (overBudget()) break;
          if (!read) {
            const reply = "已取得搜索线索，但尝试的资料页未能读取，尚不能交付已核实的摘要。请稍后重试或提供可访问的材料。";
            transcript.push({ role: "assistant", content: reply });
            usage.wallMs = priorWallMs + now() - start;
            return { reply, actions, usage, model, mock: false, rounds: i, budgetExceeded: false, paused: false, messages, transcript, telemetry, stopReason: "error", error: "source_unavailable" };
          }
        }
      }
      await hooks.beforeRequest?.();
      await emit("llm.request", { round: i });
      const availableSources = briefInformation && !synthesizing ? fetchObservations(transcript, known).filter(o => !o.failed && Number(o.data.status) >= 200 && Number(o.data.status) < 300 && typeof o.data.text === "string" && o.data.text.trim() && typeof o.data.url === "string") : [];
      if (availableSources.length) {
        synthesizing = true;
        const noticeRule = /竞赛|大赛|赛事|比赛/.test(opts.user) && advanceNoticesOnly(availableSources) ? "本次材料仅为参赛通知。不要输出赛事状态、报名状态或时效段落，系统另行提示未核实的时效。不能据计划日期断言已举办、已完成或非报名期，也不能断言下一届未发布；日期只能按通知计划表述。" : "材料未证明的当前状态写未核实，不能根据日期推断已实际举办或通知不存在。";
        messages.push({ role: "system", content: "【信息摘要阶段】已取得真实网页材料，现在交付首轮摘要，不再调用工具。只用最多6条单句要点，约300字，不用分节标题或大表格。仅整理材料明确支持的组织方、参赛对象、组队、材料及通知计划流程等信息；最后一条引用成功读取页的完整URL，而非页面内提到但没有读取的官网入口。" + noticeRule + "用户需要详细材料时可继续展开。本轮可引用的实际读取URL：" + JSON.stringify([...new Set(availableSources.map(o => o.data.url))]) });
      }
      const requestTools = synthesizing ? [] : deps.tools;
      const outputLimit = Math.min(reserve, Math.max(1, deps.budget.tokens - usage.tokens), synthesizing ? 1024 : Infinity);
      await hooks.onPromptUsage?.({ inputTokens: messagesTokens(messages) + (synthesizing ? 0 : tTools), contextLimit: deps.contextLimit ?? null, outputReserve: outputLimit, source: "estimated" });
      let heldDelta = "", plainDelta = false;
      const res = await deps.transport.chat({ messages, tools: requestTools, signal: deps.signal, reasoning: deps.reasoning, stage: synthesizing ? "summary" : deps.stage, temperature: synthesizing ? 0 : undefined, deadlineAt: start + deps.budget.wallMs - priorWallMs, maxOutputTokens: outputLimit, onDelta: (text) => {
        if (briefInformation) { heldDelta += text; return; }
        if (plainDelta) { void emit("llm.delta", { text, round: i }).catch(() => {}); return; }
        heldDelta += text;
        const first = heldDelta.trimStart()[0];
        if (first && !["{", "<", "`"].includes(first)) { plainDelta = true; void emit("llm.delta", { text: heldDelta, round: i }).catch(() => {}); heldDelta = ""; }
      } });
      telemetry = res.telemetry;
      if (!res.telemetry || res.telemetry.usage.inputTotal !== null) await hooks.onPromptUsage?.({ inputTokens: res.telemetry?.usage.inputTotal ?? res.usage.input, contextLimit: deps.contextLimit ?? null, outputReserve: reserve, source: "reported" });
      addUsage(res.usage);
      await hooks.beforeRequest?.();
      model = res.model;
      await emit("llm.response", { round: i, toolCalls: res.toolCalls.length, telemetry });
      if (res.truncated) {
        const reply = looksLikeToolCall(res.content) ? "工具指令尚未完整接收，未执行相应操作；请用新消息继续。" : res.content || "模型输出未完成，保留执行记录待继续。";
        messages.push({ role: "assistant", content: reply }); transcript.push({ role: "assistant", content: `[未完成草稿] ${reply}` });
        await checkpoint();
        return { reply, actions, usage, model: res.model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, truncated: true, messages, transcript, telemetry };
      }
      if (synthesizing && (res.toolCalls.length || looksLikeToolCall(res.content))) return { reply: "模型在摘要阶段仍返回了工具指令，未执行相应操作，请用新消息继续。", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, messages, transcript, telemetry, stopReason: "invalid_output", error: "invalid_tool_protocol" };

      if (res.toolCalls.length > 0) {
        const request: ChatMessage = { role: "assistant", content: res.content, tool_calls: res.toolCalls };
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
        messages.push({ role: "assistant", content: res.content });
        transcript.push({ role: "assistant", content: res.content });
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
      if (looksLikeToolCall(res.content)) {
        if (protocolRepairs++ < 1) {
          messages.push({ role: "assistant", content: res.content });
          messages.push({ role: "user", content: '[系统协议校验] 上一条工具指令未能解析，尚未执行。请用本轮已提供的原生工具，或单个严格JSON {"tool":"已注册名称","args":{...}} 修正；不要返回表达式、多个指令或裸控制标记。' });
          await checkpoint();
          continue;
        }
        return { reply: "模型工具调用格式无效，尚未执行该操作。已尝试修正一次，请用新消息重试。", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, messages, transcript, telemetry, stopReason: "invalid_output", error: "invalid_tool_protocol" };
      }
      if (briefInformation && actions.includes("web_search") && !synthesizing) {
        const reply = "本轮未取得与原问题相关的可读资料正文，尚不能完成可靠摘要。请稍后重试或提供官方链接。";
        transcript.push({ role: "assistant", content: reply });
        return { reply, actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, messages, transcript, telemetry, stopReason: "error", error: "source_unavailable" };
      }
      if (heldDelta && !synthesizing) await emit("llm.delta", { text: heldDelta, round: i });
      const warning = uncertainEffects ? "存在操作结果未确认，请核对后用新消息继续。\n\n" : "";
      let finalReply = warning + (res.content.trim() ? res.content : (actions.length ? `已完成 ${actions.length} 步操作：${actions.join("；")}。` : "（模型未返回内容，请重试或换一种问法）"));
      if (synthesizing) {
        const sources = fetchObservations(transcript, known).filter(o => !o.failed && Number(o.data.status) >= 200 && Number(o.data.status) < 300 && typeof o.data.text === "string" && o.data.text.trim() && typeof o.data.url === "string");
        if (/竞赛|大赛|赛事|比赛/.test(opts.user)) finalReply = noticeStatusGuard(finalReply, sources);
        const urls = [...new Set(sources.map(o => String(o.data.url)))];
        if (!urls.some(url => finalReply.includes(url))) finalReply += "\n\n本次实际读取的资料来源：\n" + urls.map(url => `- ${url}`).join("\n");
        if (heldDelta) await emit("llm.delta", { text: finalReply, round: i });
      }
      transcript.push({ role: "assistant", content: finalReply });
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
    if (err instanceof CheckpointWriteError || err instanceof LeaseLostError || isStorageUnavailable(err)) throw err;
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
      const category = (err as import("./errors.ts").LlmTransportError).reason ?? "network";
      if (category === "network") return { reply: `${done}模型连接失败（${reason}）。`, actions, usage, model: "unreachable", mock: true, rounds: 0, budgetExceeded: false, paused: false, messages, transcript, telemetry };
      return { reply: `${done}${reason}。`, actions, usage, model, mock: false, rounds: 0, budgetExceeded: false, paused: false, messages, transcript, telemetry, error: `llm_${category}`, stopReason: category === "cancelled" ? "cancelled" : "error" };
    }
    return { reply: `${done}处理过程中出现异常（${reason}），这不是模型连接问题。`, actions, usage, model, mock: false, rounds: 0, budgetExceeded: false, paused: false, messages, transcript, error: reason };
  }
}
