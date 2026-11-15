// 上下文窗口管理：模型感知上限 + 预算分配 + 裁剪/压缩 + 实时占用估算。
// 成熟 agent 的上下文组成 = system + 工具定义 + (历史摘要) + 近期历史 + 当前输入 + 输出预留。
// 超窗时裁剪最旧轮次并做抽取式摘要，工具结果截断，保证永不超模型上限。
import type { ChatMessage, ToolDef } from "../llm/proxy";

// 各模型真实上下文上限（token）。DeepSeek V4 Flash/Pro 官方 1M；其余按公开规格。
const MODEL_MAX: Array<[RegExp, number]> = [
  [/deepseek/i, 1_000_000],
  [/kimi|moonshot/i, 256_000],
  [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-4o|o3|o4/i, 128_000],
  [/qwen/i, 1_000_000],
  [/glm/i, 128_000],
];
export const DEFAULT_MAX_CONTEXT = 128_000;
// 默认工作上限（200K 量级）；实际取 min(工作上限, 模型上限)，可被 override 覆盖。
export const WORKING_CAP = 200_000;
export const RESERVE_OUTPUT = 8_000;
export const TOOL_RESULT_CAP = 12_000;
// DSH compaction-basic 阈值公式：threshold=min(窗口*0.8, 窗口-输出预留-headroom)；保留尾部16%。
export const HEADROOM_TOKENS = 65_536;
export const SPILL_HEAD_CHARS = 4096;
export const SPILL_TAIL_CHARS = 1024;
export function compactionThreshold(cap: number, reserveOutput = RESERVE_OUTPUT): number {
  return Math.floor(Math.min(cap * 0.8, cap - reserveOutput - HEADROOM_TOKENS));
}
export function retainTokens(cap: number, reserveOutput = RESERVE_OUTPUT): number {
  return Math.floor((cap - reserveOutput) * 0.16);
}

export function modelMaxContext(model?: string): number {
  if (!model) return DEFAULT_MAX_CONTEXT;
  for (const [re, n] of MODEL_MAX) if (re.test(model)) return n;
  return DEFAULT_MAX_CONTEXT;
}

export function resolveContextCap(model?: string, override?: number): number {
  return Math.min(override ?? WORKING_CAP, modelMaxContext(model));
}

// 估算 token：CJK 约 1/字，其余约 4 字符/token；每条消息加固定开销。
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
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

// 执行期截断（DSH spill-policy）：保留 head+tail，中间留省略量+取回提示；不视为历史压缩。
function truncateTool(m: ChatMessage, cap: number): ChatMessage {
  const content = m.content ?? "";
  if (m.role === "tool" && content.length > cap) {
    const omitted = content.length - SPILL_HEAD_CHARS - SPILL_TAIL_CHARS;
    const notice = `\n[... 省略 ${omitted} 字符；完整输出可用 rag_search / read_file 取回 ...]\n`;
    return { ...m, content: content.slice(0, SPILL_HEAD_CHARS) + notice + content.slice(-SPILL_TAIL_CHARS) };
  }
  return m;
}

// 抽取式摘要：保留被裁剪轮次的关键行（标题/截止/动作），不额外调用模型。
function summarizeDropped(msgs: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    const c = (m.content ?? "").replace(/\s+/g, " ").trim();
    if (!c) continue;
    lines.push(`[${m.role}] ${c.slice(0, 160)}`);
  }
  return `【历史摘要：已压缩 ${msgs.length} 条早期消息，保留要点】\n${lines.join("\n").slice(0, 4000)}`;
}

// 按 token 预算截断文本（保证摘要本身不超预算）。
function truncateToTokens(text: string, max: number): string {
  if (max <= 0) return "";
  let t = text;
  while (t.length > 0 && estimateTokens(t) > max) t = t.slice(0, Math.floor(t.length * 0.8));
  return t;
}

export interface ComposedContext {
  messages: ChatMessage[];
  usedTokens: number;
  compressed: boolean;
  droppedTurns: number;
  cap: number;
}

export function composeContext(opts: {
  system: string;
  history: ChatMessage[];
  user: string;
  tools?: ToolDef[];
  cap: number;
  reserveOutput?: number;
  toolResultCap?: number;
}): ComposedContext {
  const reserve = opts.reserveOutput ?? RESERVE_OUTPUT;
  const trCap = opts.toolResultCap ?? TOOL_RESULT_CAP;
  const tTools = toolsTokens(opts.tools);
  const systemMsg: ChatMessage = { role: "system", content: opts.system };
  const userMsg: ChatMessage = { role: "user", content: opts.user };
  const fixed = messagesTokens([systemMsg, userMsg]) + tTools + reserve;
  const budget = Math.max(0, opts.cap - fixed);

  const hist = opts.history.map((m) => truncateTool(m, trCap));
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = messagesTokens([hist[i]]);
    if (used + t > budget) break;
    kept.unshift(hist[i]);
    used += t;
  }
  const dropped = hist.length - kept.length;
  let messages: ChatMessage[];
  if (dropped > 0) {
    const summary = truncateToTokens(summarizeDropped(hist.slice(0, dropped)), Math.max(0, budget - used));
    messages = summary
      ? [systemMsg, { role: "system", content: summary }, ...kept, userMsg]
      : [systemMsg, ...kept, userMsg];
  } else {
    messages = [systemMsg, ...kept, userMsg];
  }
  return {
    messages,
    usedTokens: messagesTokens(messages) + tTools,
    compressed: dropped > 0,
    droppedTurns: dropped,
    cap: opts.cap,
  };
}

// 工具循环内再裁剪。DSH 理念：工具结果裁剪(tool-result-pruner)与历史压缩(compaction)分离——
// 仅裁剪较旧工具结果、保留最新工具结果完整；裁剪不算"历史压缩"，只有丢弃历史轮次才置 compressed。
export function trimToBudget(
  messages: ChatMessage[],
  cap: number,
  tTools: number,
  reserveOutput = RESERVE_OUTPUT,
  trCap = TOOL_RESULT_CAP,
): { messages: ChatMessage[]; compressed: boolean; pruned: boolean } {
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") { lastToolIdx = i; break; }
  }
  let msgs = messages.map((m, i) => (m.role === "tool" && i !== lastToolIdx ? truncateTool(m, trCap) : m));
  let pruned = msgs.some((m, i) => m !== messages[i]);
  let compressed = false;
  const budget = cap - reserveOutput - tTools;
  const threshold = compactionThreshold(cap, reserveOutput);
  const retain = retainTokens(cap, reserveOutput);
  const head = msgs.findIndex((m) => m.role !== "system");
  // 历史压缩仅在超阈值时触发；丢弃最旧轮次但保留尾部 retain（不切断调用-结果对由 head 起整轮丢弃保证）
  if (messagesTokens(msgs) > threshold) {
    while (messagesTokens(msgs) > Math.max(retain, budget - tTools) && msgs.length > head + 2) {
      msgs = [...msgs.slice(0, head), ...msgs.slice(head + 1)];
      compressed = true;
    }
  }
  // 兜底：单条超大最新工具结果仍超预算时裁剪（工具裁剪，非历史压缩）
  if (messagesTokens(msgs) > budget) {
    const before = msgs;
    msgs = msgs.map((m) => truncateTool(m, trCap));
    pruned = pruned || msgs.some((m, i) => m !== before[i]);
  }
  return { messages: msgs, compressed, pruned };
}