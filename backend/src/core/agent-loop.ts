// 纯 Agent 执行循环（解耦自 web chat.ts runChat）。环境无关：transport/executeTool/时钟均注入。
// 保留：有界循环、原生 tool_calls + JSON 工具回退、重复提醒、错误边界、预算硬停。
import type { Budget, ChatMessage, CheckpointState, EventType, ToolDef, Usage } from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";
import type { LlmTransport } from "./llm.ts";
import { errorMessage, isTransportError } from "./errors.ts";
import { trimToBudget, toolsTokens, resolveContextCap } from "./context.ts";
import { checkBudget } from "./budget.ts";

export interface AgentLoopHooks {
  onEvent?: (type: EventType, payload: Record<string, unknown>) => void;
  onCheckpoint?: (state: CheckpointState) => void;
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
  history?: ChatMessage[];
  resumeMessages?: ChatMessage[];
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
  const usage: Usage = { ...EMPTY_USAGE };
  let model = "unknown";
  const cap = resolveContextCap(opts.model);
  const tTools = toolsTokens(deps.tools);

  let messages: ChatMessage[] = opts.resumeMessages
    ? [...opts.resumeMessages]
    : [{ role: "system", content: opts.system }, ...(opts.history ?? []), { role: "user", content: opts.user }];

  const emit = (type: EventType, payload: Record<string, unknown>) => hooks.onEvent?.(type, payload);
  const snapshot = (): CheckpointState => ({
    messages, stepProgress: {}, repeat: Object.fromEntries(repeat), usage: { ...usage }, pendingApprovals: [],
  });
  const overBudget = () => checkBudget({ ...usage, wallMs: now() - start }, deps.budget).exceeded;
  const addUsage = (u: { input: number; output: number }) => {
    usage.tokens += u.input + u.output;
    usage.costUsd = usage.tokens * price;
    usage.wallMs = now() - start;
  };

  try {
    for (let i = 0; i < maxRounds; i++) {
      if (overBudget()) { emit("budget.exceeded", { usage }); break; }
      emit("llm.request", { round: i });
      const res = await deps.transport.chat({ messages, tools: deps.tools });
      addUsage(res.usage);
      model = res.model;
      emit("llm.response", { round: i, toolCalls: res.toolCalls.length });

      if (res.toolCalls.length > 0) {
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* empty args */ }
          emit("tool.called", { name: call.function.name });
          const out = await deps.executeTool(call.function.name, args);
          usage.toolCalls += 1;
          messages.push({ role: "tool", content: out, tool_call_id: call.id });
          emit("tool.result", { name: call.function.name });
          noteRepeat(repeat, call.function.name, args, messages);
          try { const parsed = JSON.parse(out); if (parsed && typeof parsed === "object" && !parsed.error) actions.push(call.function.name); } catch { /* non-json */ }
          if (out.includes(APPROVAL_PAUSE)) { hooks.onCheckpoint?.(snapshot()); return { reply: "等待人工审批", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: true, messages }; }
        }
        const trimmed = trimToBudget(messages, cap, tTools);
        messages = trimmed.messages;
        hooks.onCheckpoint?.(snapshot());
        emit("checkpoint.written", { round: i, compressed: trimmed.compressed, pruned: trimmed.pruned });
        continue;
      }

      if (/<tool_result/i.test(res.content)) {
        return { reply: "已拦截虚构的工具结果：模型未真实调用工具。", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, messages };
      }
      const jt = parseJsonTool(res.content, known);
      if (jt) {
        messages.push({ role: "assistant", content: res.content });
        emit("tool.called", { name: jt.name });
        const out = await deps.executeTool(jt.name, jt.args);
        usage.toolCalls += 1;
        messages.push({ role: "user", content: `工具 ${jt.name} 返回：${out}` });
        emit("tool.result", { name: jt.name });
        noteRepeat(repeat, jt.name, jt.args, messages);
        const trimmedJt = trimToBudget(messages, cap, tTools);
        messages = trimmedJt.messages;
        hooks.onCheckpoint?.(snapshot());
        if (out.includes(APPROVAL_PAUSE)) return { reply: "等待人工审批", actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: true, messages };
        continue;
      }
      return { reply: res.content, actions, usage, model, mock: false, rounds: i + 1, budgetExceeded: false, paused: false, messages };
    }

    // 预算/轮次用尽：强制一次无工具最终总结，保证有可用产出。
    const budgetExceeded = overBudget();
    messages.push({ role: "user", content: "工具调用预算已用尽。请基于以上已获取的工具结果，直接给出最终中文总结（含来源/截止/过期说明），不要再调用任何工具。" });
    const fin = await deps.transport.chat({ messages });
    addUsage(fin.usage);
    const actionsSummary = actions.length ? `已完成 ${actions.length} 步操作：${actions.join("；")}` : "（未获取到有效结果）";
    const finalText = fin.content && !parseJsonTool(fin.content, known) ? fin.content : actionsSummary;
    return { reply: finalText, actions, usage, model: fin.model || model, mock: false, rounds: maxRounds, budgetExceeded, paused: false, messages };
  } catch (err) {
    const reason = errorMessage(err);
    const done = actions.length ? `本轮已完成 ${actions.length} 步操作：${actions.join("；")}。` : "";
    if (isTransportError(err)) {
      return { reply: `${done}模型连接失败（${reason}）。`, actions, usage, model: "unreachable", mock: true, rounds: 0, budgetExceeded: false, paused: false, messages };
    }
    return { reply: `${done}处理过程中出现异常（${reason}），这不是模型连接问题。`, actions, usage, model, mock: false, rounds: 0, budgetExceeded: false, paused: false, messages };
  }
}