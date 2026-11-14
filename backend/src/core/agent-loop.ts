// 纯 Agent 执行循环（解耦自 web chat.ts runChat）。环境无关：transport/executeTool/时钟均注入。
// 保留：有界循环、原生 tool_calls + JSON 工具回退、重复提醒、错误边界、预算硬停。
import type { Budget, ChatMessage, CheckpointState, EventType, ToolDef, Usage } from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";
import type { LlmTransport } from "./llm.ts";
import { errorMessage, isTransportError } from "./errors.ts";
import { trimToBudget, toolsTokens, resolveContextCap } from "./context.ts";
import { checkBudget, budgetStopSummary } from "./budget.ts";
import { toolResultFailed } from "./tool-result.ts";

export interface AgentLoopHooks {
  onEvent?: (type: EventType, payload: Record<string, unknown>) => unknown | Promise<unknown>;
  onCheckpoint?: (state: CheckpointState) => unknown | Promise<unknown>;
  now?: () => number;
  pricePerToken?: number; // costUsd 估算，默认 0.5/1M
}

export interface AgentLoopDeps {
  transport: LlmTransport;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  tools: ToolDef[];
  budget: Budget;
  hooks?: AgentLoopHooks;
  maxRounds?: number;
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
  stopReason: "completed" | "budget" | "round_limit" | "cancelled" | "error" | "approval" | "invalid_output";
  toolErrors: number;
}

const MAX_TOOL_ROUNDS = 20;
const APPROVAL_PAUSE = "__approval_pending__";

function parseJsonTool(content: string, known: Set<string>): { name: string; args: Record<string, unknown> } | null {
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

export async function runAgentLoop(opts: {
  system: string;
  user: string;
  images?: string[];
  history?: ChatMessage[];
  resumeMessages?: ChatMessage[];
  resumeUsage?: Usage;
  resumeToolErrors?: number;
  deps: AgentLoopDeps;
  repeat?: Map<string, number>;
  model?: string;
}): Promise<AgentLoopResult> {
  const { deps } = opts;
  const hooks = deps.hooks ?? {};
  const now = hooks.now ?? Date.now;
  const price = hooks.pricePerToken ?? 0.5 / 1_000_000;
  const maxRounds = deps.maxRounds ?? MAX_TOOL_ROUNDS;
  const known = new Set(deps.tools.map((t) => t.function.name));
  const actions: string[] = [];
  const repeat = opts.repeat ?? new Map<string, number>();
  const start = now();
  const usage: Usage = { ...(opts.resumeUsage ?? EMPTY_USAGE) };
  const previousWallMs = usage.wallMs;
  let toolErrors = opts.resumeToolErrors ?? 0;
  let rounds = 0;
  let model = "unknown";
  const cap = resolveContextCap(opts.model);
  const tTools = toolsTokens(deps.tools);

  const userContent: ChatMessage["content"] = opts.images?.length
    ? [{ type: "text", text: opts.user }, ...opts.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))]
    : opts.user;
  let messages: ChatMessage[] = opts.resumeMessages
    ? [...opts.resumeMessages]
    : [{ role: "system", content: opts.system }, ...(opts.history ?? []), { role: "user", content: userContent }];

  const emit = async (type: EventType, payload: Record<string, unknown>) => { await hooks.onEvent?.(type, payload); };
  const updateWall = () => { usage.wallMs = previousWallMs + Math.max(0, now() - start); };
  const snapshot = (): CheckpointState => ({
    messages: structuredClone(messages), stepProgress: {}, repeat: Object.fromEntries(repeat), usage: { ...usage }, pendingApprovals: [], toolErrors,
  });
  const overBudget = () => { updateWall(); return checkBudget(usage, deps.budget).exceeded; };
  const finish = (reply: string, stopReason: AgentLoopResult["stopReason"], mock = false): AgentLoopResult => {
    updateWall();
    return { reply, actions, usage, model: mock ? "unreachable" : model, mock, rounds,
      budgetExceeded: stopReason === "budget", paused: stopReason === "approval", messages, stopReason, toolErrors };
  };
  // Check the persisted cancel flag before every model/tool call, not merely after a turn.
  const gate = async (): Promise<AgentLoopResult | null> => {
    if (await deps.isCancelled?.()) return finish("任务已取消；已执行的操作不会自动撤销。", "cancelled");
    if (!overBudget()) return null;
    await emit("budget.exceeded", { usage: { ...usage } });
    return finish(budgetStopSummary(checkBudget(usage, deps.budget), actions), "budget");
  };
  const addUsage = (u: { input: number; output: number }) => {
    usage.tokens += u.input + u.output;
    usage.costUsd += (u.input + u.output) * price;
    updateWall();
  };

  try {
    for (let i = 0; i < maxRounds; i++) {
      const stopped = await gate();
      if (stopped) return stopped;
      rounds = i + 1;
      await emit("llm.request", { round: i });
      const beforeRequest = await gate();
      if (beforeRequest) return beforeRequest;
      const res = await deps.transport.chat({ messages, tools: deps.tools });
      addUsage(res.usage);
      model = res.model;
      await emit("llm.response", { round: i, toolCalls: res.toolCalls.length });
      const afterRequest = await gate();
      if (afterRequest) return afterRequest;

      if (res.toolCalls.length > 0) {
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          const beforeTool = await gate();
          if (beforeTool) return beforeTool;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("invalid args");
          } catch {
            toolErrors++;
            messages.push({ role: "tool", content: JSON.stringify({ error: "工具参数必须为 JSON 对象" }), tool_call_id: call.id });
            continue;
          }
          if (!known.has(call.function.name)) {
            toolErrors++;
            messages.push({ role: "tool", content: JSON.stringify({ error: "工具不在本任务允许列表" }), tool_call_id: call.id });
            continue;
          }
          await emit("tool.called", { name: call.function.name });
          const atBoundary = await gate();
          if (atBoundary) return atBoundary;
          // Charge attempts, including thrown executions. No second native call may skip the limit.
          usage.toolCalls += 1;
          const out = await deps.executeTool(call.function.name, args);
          messages.push({ role: "tool", content: out, tool_call_id: call.id });
          const approvalPending = out.includes(APPROVAL_PAUSE);
          if (!approvalPending && toolResultFailed(out)) toolErrors++;
          await emit("tool.result", { name: call.function.name });
          noteRepeat(repeat, call.function.name, args, messages);
          if (!approvalPending && !toolResultFailed(out)) actions.push(call.function.name);
          if (approvalPending) { updateWall(); await hooks.onCheckpoint?.(snapshot()); return finish("等待人工审批", "approval"); }
        }
        const trimmed = trimToBudget(messages, cap, tTools);
        messages = trimmed.messages;
        updateWall();
        await hooks.onCheckpoint?.(snapshot());
        await emit("checkpoint.written", { round: i, compressed: trimmed.compressed, pruned: trimmed.pruned });
        continue;
      }

      if (/<tool_result/i.test(res.content)) {
        return finish("已拦截虚构的工具结果：模型未真实调用工具。", "invalid_output");
      }
      const jt = parseJsonTool(res.content, known);
      if (jt) {
        messages.push({ role: "assistant", content: res.content });
        const beforeTool = await gate();
        if (beforeTool) return beforeTool;
        if (!jt.args || typeof jt.args !== "object" || Array.isArray(jt.args)) return finish("工具参数必须为 JSON 对象。", "invalid_output");
        await emit("tool.called", { name: jt.name });
        const atBoundary = await gate();
        if (atBoundary) return atBoundary;
        usage.toolCalls += 1;
        const out = await deps.executeTool(jt.name, jt.args);
        const approvalPending = out.includes(APPROVAL_PAUSE);
        if (!approvalPending && toolResultFailed(out)) toolErrors++;
        if (!approvalPending && !toolResultFailed(out)) actions.push(jt.name);
        messages.push({ role: "user", content: `工具 ${jt.name} 返回：${out}` });
        await emit("tool.result", { name: jt.name });
        noteRepeat(repeat, jt.name, jt.args, messages);
        const trimmedJt = trimToBudget(messages, cap, tTools);
        messages = trimmedJt.messages;
        updateWall();
        await hooks.onCheckpoint?.(snapshot());
        if (approvalPending) return finish("等待人工审批", "approval");
        continue;
      }
      const finalReply = res.content.trim() ? res.content : (actions.length ? `已完成 ${actions.length} 步操作：${actions.join("；")}。` : "（模型未返回内容，请重试或换一种问法）");
      return finish(finalReply, res.content.trim() ? "completed" : "invalid_output");
    }

    // A hard budget stop must not issue another paid model request for a summary.
    const stopped = await gate();
    if (stopped) return stopped;
    const actionsSummary = actions.length ? `已完成 ${actions.length} 步操作：${actions.join("；")}` : "（未获取到有效结果）";
    return finish(`${actionsSummary}。达到执行轮次上限，任务未完整完成。`, "round_limit");
  } catch (err) {
    const reason = errorMessage(err);
    const done = actions.length ? `本轮已完成 ${actions.length} 步操作：${actions.join("；")}。` : "";
    if (isTransportError(err)) {
      return finish(`${done}模型连接失败（${reason}）。`, "error", true);
    }
    return finish(`${done}处理过程中出现异常（${reason}），这不是模型连接问题。`, "error");
  }
}
