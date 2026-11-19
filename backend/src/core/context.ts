// 上下文窗口管理：模型感知上限 + 预算 + 按轮次组原子压缩（修复 tool_call↔result 配对）。
// 工具结果裁剪（spill）与历史压缩（compaction）分离；压缩摘要不取代任务状态与原始证据。
import type { ChatMessage, ToolDef, MessageContent } from "./types.ts";

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
/** 压缩摘要消息的稳定前缀；前缀缓存观测据此识别段 D（历史压缩块）。 */
export const COMPACTION_SUMMARY_MARKER = "【历史摘要：已压缩";
export class ContextLimitError extends Error {}

export function modelMaxContext(model?: string): number {
  if (!model) return DEFAULT_MAX_CONTEXT;
  for (const [re, n] of MODEL_MAX) if (re.test(model)) return n;
  return DEFAULT_MAX_CONTEXT;
}
export function resolveContextCap(model?: string, override?: number): number {
  return Math.min(override ?? WORKING_CAP, modelMaxContext(model));
}
export function compactionThreshold(cap: number, reserveOutput = RESERVE_OUTPUT): number {
  return Math.max(1, Math.floor(Math.min(cap * 0.8, cap - reserveOutput - Math.min(HEADROOM_TOKENS, cap * 0.1))));
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
export function contentText(content: string | MessageContent[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "[图片]")).join(" ");
}
export function messagesTokens(msgs: ChatMessage[]): number {
  return msgs.reduce((total, message) => {
    const toolCalls = message.tool_calls?.length ? estimateTokens(JSON.stringify(message.tool_calls)) : 0;
    return total + estimateTokens(contentText(message.content)) + estimateTokens(message.reasoning_content ?? "") + toolCalls + 8;
  }, 0);
}
export function toolsTokens(tools?: ToolDef[]): number {
  return tools ? estimateTokens(JSON.stringify(tools)) : 0;
}

// 工具结果裁剪（spill）：保留 head+tail + 取回提示。仅裁剪 tool 消息内容，不丢消息。
export function truncateTool(m: ChatMessage, cap = TOOL_RESULT_CAP): ChatMessage {
  const content = typeof m.content === "string" ? m.content : contentText(m.content);
  if (m.role === "tool" && content.length > cap) {
    const head = Math.min(SPILL_HEAD_CHARS, Math.floor(cap * 0.75));
    const tail = Math.min(SPILL_TAIL_CHARS, Math.floor(cap * 0.2));
    const omitted = content.length - head - tail;
    const notice = `\n[... 省略 ${omitted} 字符；完整输出可用 rag_search / read_file 取回 ...]\n`;
    return { ...m, content: content.slice(0, head) + notice + content.slice(-tail) };
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

function contentOf(m: ChatMessage): string {
  return contentText(m.content).replace(/\s+/g, " ").trim();
}

// 结构化压缩：早期轮次被丢弃时保留"目标/计划/产物/证据/未完成"，避免摘要只剩零散句子。
// 借鉴 DSH/Claude Code 的上下文工程：摘要必须能支撑后续决策，而不只是复述对话。
function summarizeDropped(groups: ChatMessage[][]): string {
  const flat = groups.flat();
  const goal = flat
    .map(contentOf)
    .find((text) => text.length > 0 && !text.startsWith("[工具观测：") && !text.startsWith("[系统提醒]") && !text.startsWith("【历史摘要"));
  const todoLines: string[] = [];
  for (const group of groups) {
    for (const message of group) {
      for (const call of message.tool_calls ?? []) {
        if (call.function.name !== "todo_write") continue;
        try {
          const args = JSON.parse(call.function.arguments || "{}") as { todos?: Array<{ content?: unknown; status?: unknown }> };
          if (!Array.isArray(args.todos)) continue;
          todoLines.length = 0;
          for (const item of args.todos.slice(0, 8)) {
            const status = item.status === "completed" ? "✓" : item.status === "in_progress" ? "▶" : "…";
            todoLines.push(`${status} ${clipLine(String(item.content ?? ""), 60)}`);
          }
        } catch { /* ignore malformed todo args */ }
      }
    }
  }
  const artifactSet = new Set<string>();
  const evidenceSet = new Set<string>();
  const failures: string[] = [];
  for (const group of groups) {
    for (const message of group) {
      const text = `${contentOf(message)} ${message.tool_calls?.map((call) => call.function.arguments).join(" ") ?? ""}`;
      for (const match of text.matchAll(/[\w./-]+\.(?:md|docx|pdf|xlsx|csv|txt|ics|pptx)\b/gi)) artifactSet.add(match[0]);
      for (const match of contentOf(message).matchAll(/https?:\/\/[^\s"')]+/g)) evidenceSet.add(match[0]);
      if (message.role === "tool" && /失败|超时|error|failed|HTTP\s*[45]\d\d/i.test(contentOf(message))) {
        failures.push(clipLine(contentOf(message), 120));
      }
    }
  }
  const recent: string[] = [];
  for (const group of groups.slice(-2)) {
    const first = group[0];
    if (first && contentOf(first)) recent.push(clipLine(contentOf(first), 140));
  }
  const artifacts = [...artifactSet].slice(-8);
  const evidence = [...evidenceSet].slice(-5);
  const sections: string[] = [];
  if (goal) sections.push(`【目标】${clipLine(goal, 240)}`);
  if (todoLines.length) sections.push(`【计划】\n${todoLines.join("\n")}`);
  if (artifacts.length) sections.push(`【产物】${artifacts.join("、")}`);
  if (evidence.length) sections.push(`【证据】${evidence.join(" ")}`);
  if (failures.length) sections.push(`【未完成/错误】\n${failures.slice(-3).join("\n")}`);
  if (recent.length) sections.push(`【最近步骤】\n${recent.join("\n")}`);
  const body = sections.join("\n").slice(0, 2400);
  return `${COMPACTION_SUMMARY_MARKER} ${groups.length} 组早期轮次，保留要点】\n${body}`;
}

function clipLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export interface TrimResult { messages: ChatMessage[]; compressed: boolean; pruned: boolean; }

// 按轮次组原子压缩：超阈值时从最旧组整组丢弃，保留 system + 尾部 retain 预算内的完整组。
// 绝不拆散 tool_call↔result；压缩后校验配对。工具结果裁剪独立（pruned）。
export function trimToBudget(messages: ChatMessage[], cap: number, tTools: number, reserveOutput = RESERVE_OUTPUT, trCap = TOOL_RESULT_CAP, protectedUser?: ChatMessage): TrimResult {
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
    const droppedGroups: ChatMessage[][] = [];
    const protectedKey = protectedUser ? JSON.stringify(protectedUser) : null;
    const assemble = () => [...systemPrefix, ...(droppedGroups.length ? [{ role: "system" as const, content: summarizeDropped(droppedGroups) }] : []), ...groups.flat()];
    while (groups.length > 1 && messagesTokens(assemble()) > Math.max(retain, budget)) {
      const index = groups.findIndex((g, i) => i < groups.length - 1 && (!protectedKey || !g.some((m) => JSON.stringify(m) === protectedKey)));
      if (index < 0) break;
      droppedGroups.push(...groups.splice(index, 1));
      compressed = true;
    }
    const base = [...systemPrefix, ...groups.flat()];
    const summaryBudget = Math.max(0, budget - messagesTokens(base) - 8);
    const summary = droppedGroups.length ? clipTokens(summarizeDropped(droppedGroups), summaryBudget) : "";
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
  if (messagesTokens(msgs) > budget) {
    for (let limit = Math.min(trCap, Math.floor(budget / 3)); limit >= 128 && messagesTokens(msgs) > budget; limit = Math.floor(limit / 2)) msgs = msgs.map((m) => truncateTool(m, limit));
    pruned = true;
  }
  if (messagesTokens(msgs) > budget) throw new ContextLimitError("必须保留的目标与工具组超过上下文窗口，请缩小输入或选择更大模型窗口");
  return { messages: msgs, compressed, pruned };
}

function clipTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let low = 0, high = text.length;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (estimateTokens(text.slice(0, mid)) <= budget) low = mid; else high = mid - 1; }
  return text.slice(0, low);
}

export interface ComposedContext { messages: ChatMessage[]; usedTokens: number; compressed: boolean; droppedTurns: number; cap: number; }

// 分层组装：system + 工具 + 历史（按预算保留近期完整组）+ 当前输入。
export function composeContext(opts: { system: string; dynamic?: string; history: ChatMessage[]; user: string; tools?: ToolDef[]; cap: number; reserveOutput?: number; toolResultCap?: number }): ComposedContext {
  const reserve = opts.reserveOutput ?? Math.min(RESERVE_OUTPUT, Math.floor(opts.cap * 0.25));
  const trCap = opts.toolResultCap ?? TOOL_RESULT_CAP;
  const tTools = toolsTokens(opts.tools);
  const systemMsg: ChatMessage = { role: "system", content: opts.system };
  const prefix: ChatMessage[] = [systemMsg, ...(opts.dynamic ? [{ role: "system" as const, content: opts.dynamic }] : [])];
  const userMsg: ChatMessage = { role: "user", content: opts.user };
  const fixed = messagesTokens([...prefix, userMsg]) + tTools + reserve;
  if (fixed > opts.cap) throw new ContextLimitError("身份、规则、工具和当前输入超出配置窗口，请缩小材料或选择更大窗口模型");
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
  let dropped = groups.length - kept.length;
  while (dropped > 0 && kept.length && messagesTokens([...prefix, { role: "system", content: summarizeDropped(groups.slice(0, dropped)) }, ...kept.flat(), userMsg]) + tTools + reserve > opts.cap) { kept.shift(); dropped++; }
  const keptFlat = kept.flat();
  const summaryMsg: ChatMessage = { role: "system", content: clipTokens(summarizeDropped(groups.slice(0, dropped)), Math.max(0, opts.cap - tTools - reserve - messagesTokens([...prefix, ...keptFlat, userMsg]) - 8)) };
  const messages: ChatMessage[] = dropped > 0
    ? [...prefix, summaryMsg, ...keptFlat, userMsg]
    : [...prefix, ...keptFlat, userMsg];
  return { messages, usedTokens: messagesTokens(messages) + tTools, compressed: dropped > 0, droppedTurns: dropped, cap: opts.cap };
}
