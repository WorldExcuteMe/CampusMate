// 上下文窗口管理：模型感知上限 + 预算 + 按轮次组原子压缩（修复 tool_call↔result 配对）。
// 工具结果裁剪（spill）与历史压缩（compaction）分离；压缩摘要不取代任务状态与原始证据。
import type { ChatMessage, ToolDef } from "./types.ts";

const MODEL_MAX: Array<[RegExp, number]> = [
  [/deepseek/i, 1_000_000], [/kimi|moonshot/i, 256_000], [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000], [/gpt-4o|o3|o4/i, 128_000], [/qwen/i, 1_000_000], [/glm/i, 128_000],
];
export const DEFAULT_MAX_CONTEXT = 128_000;
export const WORKING_CAP = 200_000;
export const RESERVE_OUTPUT = 8_000;
export const TOOL_RESULT_CAP = 12_000;
export const HEADROOM_TOKENS = 65_536;
export const SPILL_HEAD_CHARS = 4096;
export const SPILL_TAIL_CHARS = 1024;

export function modelMaxContext(model?: string): number {
  if (!model) return DEFAULT_MAX_CONTEXT;
  for (const [re, n] of MODEL_MAX) if (re.test(model)) return n;
  return DEFAULT_MAX_CONTEXT;
}
export function resolveContextCap(model?: string, override?: number): number {
  return Math.min(override ?? WORKING_CAP, modelMaxContext(model));
}
export function compactionThreshold(cap: number, reserveOutput = RESERVE_OUTPUT): number {
  return Math.floor(Math.min(cap * 0.8, cap - reserveOutput - HEADROOM_TOKENS));
}
export function retainTokens(cap: number, reserveOutput = RESERVE_OUTPUT): number {
  return Math.floor((cap - reserveOutput) * 0.16);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0, other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
export function messagesTokens(msgs: ChatMessage[]): number {
  return msgs.reduce((s, m) => s + estimateTokens(m.content ?? "") + (m.tool_calls ? 64 : 0) + 8, 0);
}
export function toolsTokens(tools?: ToolDef[]): number {
  return tools ? estimateTokens(JSON.stringify(tools)) : 0;
}

// 工具结果裁剪（spill）：保留 head+tail + 取回提示。仅裁剪 tool 消息内容，不丢消息。
export function truncateTool(m: ChatMessage, cap = TOOL_RESULT_CAP): ChatMessage {
  const content = m.content ?? "";
  if (m.role === "tool" && content.length > cap) {
    const omitted = content.length - SPILL_HEAD_CHARS - SPILL_TAIL_CHARS;
    const notice = `\n[... 省略 ${omitted} 字符；完整输出可用 rag_search / read_file 取回 ...]\n`;
    return { ...m, content: content.slice(0, SPILL_HEAD_CHARS) + notice + content.slice(-SPILL_TAIL_CHARS) };
  }
  return m;
}

// 轮次组：一个 assistant(tool_calls) + 其后所有 tool 结果 = 一组；其余消息各自成组。
// 压缩时整组丢弃，绝不拆散 tool_call↔tool_result 配对。
export function groupTurns(msgs: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i];
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const group: ChatMessage[] = [m];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === "tool") { group.push(msgs[j]); j++; }
      groups.push(group);
      i = j;
    } else {
      groups.push([m]);
      i++;
    }
  }
  return groups;
}

// 配对完整性校验：每个 tool 消息必须有前置 assistant 含匹配 tool_call_id；无孤儿 tool。
export function validatePairing(msgs: ChatMessage[]): { ok: boolean; orphans: number } {
  const pending = new Set<string>();
  let orphans = 0;
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) pending.add(c.id);
    if (m.role === "tool") {
      if (m.tool_call_id && pending.has(m.tool_call_id)) pending.delete(m.tool_call_id);
      else orphans++;
    }
  }
  return { ok: orphans === 0, orphans };
}

function summarizeDropped(groups: ChatMessage[][]): string {
  const lines: string[] = [];
  for (const g of groups) for (const m of g) {
    const c = (m.content ?? "").replace(/\s+/g, " ").trim();
    if (c) lines.push(`[${m.role}] ${c.slice(0, 160)}`);
  }
  return `【历史摘要：已压缩 ${groups.length} 组早期轮次，保留要点】\n${lines.join("\n").slice(0, 4000)}`;
}

export interface TrimResult { messages: ChatMessage[]; compressed: boolean; pruned: boolean; }

// 按轮次组原子压缩：超阈值时从最旧组整组丢弃，保留 system + 尾部 retain 预算内的完整组。
// 绝不拆散 tool_call↔result；压缩后校验配对。工具结果裁剪独立（pruned）。
export function trimToBudget(messages: ChatMessage[], cap: number, tTools: number, reserveOutput = RESERVE_OUTPUT, trCap = TOOL_RESULT_CAP): TrimResult {
  // 先裁剪较旧工具结果（保留最新 tool 完整）——pruned，不算历史压缩。
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "tool") { lastToolIdx = i; break; }
  let msgs = messages.map((m, i) => (m.role === "tool" && i !== lastToolIdx ? truncateTool(m, trCap) : m));
  let pruned = msgs.some((m, i) => m !== messages[i]);
  let compressed = false;

  const budget = cap - reserveOutput - tTools;
  const threshold = compactionThreshold(cap, reserveOutput);
  const retain = retainTokens(cap, reserveOutput);

  if (messagesTokens(msgs) > threshold) {
    // 分离 system 前缀与正文组。
    const systemPrefix: ChatMessage[] = [];
    let bodyStart = 0;
    while (bodyStart < msgs.length && msgs[bodyStart].role === "system") { systemPrefix.push(msgs[bodyStart]); bodyStart++; }
    const groups = groupTurns(msgs.slice(bodyStart));
    // 从最旧组整组丢弃，直到落入预算（保留尾部 retain 内的完整组）。
    let droppedCount = 0;
    while (groups.length > 1 && messagesTokens([...systemPrefix, ...groups.flat()]) > Math.max(retain, budget)) {
      groups.shift();
      droppedCount++;
      compressed = true;
    }
    const droppedGroups = groupTurns(msgs.slice(bodyStart)).slice(0, droppedCount);
    const summary = droppedCount > 0 ? summarizeDropped(droppedGroups) : "";
    const summaryMsg: ChatMessage = { role: "system", content: summary };
    msgs = summary
      ? [...systemPrefix, summaryMsg, ...groups.flat()]
      : [...systemPrefix, ...groups.flat()];
  }

  // 兜底：单条超大最新工具结果仍超预算→裁剪（pruned）。
  if (messagesTokens(msgs) > budget) {
    const before = msgs;
    msgs = msgs.map((m) => truncateTool(m, trCap));
    pruned = pruned || msgs.some((m, i) => m !== before[i]);
  }
  return { messages: msgs, compressed, pruned };
}

export interface ComposedContext { messages: ChatMessage[]; usedTokens: number; compressed: boolean; droppedTurns: number; cap: number; }

// 分层组装：system + 工具 + 历史（按预算保留近期完整组）+ 当前输入。
export function composeContext(opts: { system: string; history: ChatMessage[]; user: string; tools?: ToolDef[]; cap: number; reserveOutput?: number; toolResultCap?: number }): ComposedContext {
  const reserve = opts.reserveOutput ?? RESERVE_OUTPUT;
  const trCap = opts.toolResultCap ?? TOOL_RESULT_CAP;
  const tTools = toolsTokens(opts.tools);
  const systemMsg: ChatMessage = { role: "system", content: opts.system };
  const userMsg: ChatMessage = { role: "user", content: opts.user };
  const fixed = messagesTokens([systemMsg, userMsg]) + tTools + reserve;
  const budget = Math.max(0, opts.cap - fixed);

  const hist = opts.history.map((m) => truncateTool(m, trCap));
  const groups = groupTurns(hist);
  const kept: ChatMessage[][] = [];
  let used = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const t = messagesTokens(groups[i]);
    if (used + t > budget) break;
    kept.unshift(groups[i]);
    used += t;
  }
  const dropped = groups.length - kept.length;
  const keptFlat = kept.flat();
  const summaryMsg: ChatMessage = { role: "system", content: summarizeDropped(groups.slice(0, dropped)) };
  const messages: ChatMessage[] = dropped > 0
    ? [systemMsg, summaryMsg, ...keptFlat, userMsg]
    : [systemMsg, ...keptFlat, userMsg];
  return { messages, usedTokens: messagesTokens(messages) + tTools, compressed: dropped > 0, droppedTurns: dropped, cap: opts.cap };
}