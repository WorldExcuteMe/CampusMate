// Context Builder：分层组装上下文。Task State（事实来源）恒注入，不被压缩丢弃。
// 相关记忆按 task/user 隔离检索；压缩摘要只引用不取代原始证据。
import type { ChatMessage, ToolDef } from "./types.ts";
import { composeContext, type ComposedContext } from "./context.ts";
import type { MemoryStore } from "./memory.ts";

export interface ContextLayers {
  stableInstructions: string;   // SYSTEM + scope.contract（稳定）
  taskContext: string;          // 当前 Task/Step 结构化状态摘要（事实来源，恒注入）
  userProfile: string;          // User Memory 精简
  relevantMemory: string;       // 隔离检索的相关 Episodic/Procedural
  toolSchemas: ToolDef[];
}

export interface BuildContextOpts {
  layers: ContextLayers;
  history: ChatMessage[];
  user: string;
  cap: number;
}

// 组装稳定层（taskContext 恒注入）+ 近期历史（按预算压缩，配对完整）。
export function buildContext(opts: BuildContextOpts): ComposedContext {
  const system = [
    opts.layers.stableInstructions,
    opts.layers.taskContext ? `【当前任务状态（事实来源，勿被摘要取代）】\n${opts.layers.taskContext}` : "",
    opts.layers.userProfile ? `【用户画像】\n${opts.layers.userProfile}` : "",
    opts.layers.relevantMemory ? `【相关记忆（已隔离检索，勿编造）】\n${opts.layers.relevantMemory}` : "",
  ].filter(Boolean).join("\n\n");
  return composeContext({ system, history: opts.history, user: opts.user, tools: opts.layers.toolSchemas, cap: opts.cap });
}

// 从记忆存储按隔离键检索相关记忆（user + task），组装 relevantMemory 文本。
export async function retrieveRelevantMemory(store: MemoryStore, userId: string, taskId: string): Promise<string> {
  const episodic = await store.listEpisodic(taskId, userId); // 仅本任务本用户
  const procedural = await store.listProcedural(userId);    // 仅本用户已验证技能
  const parts: string[] = [];
  if (episodic.length) parts.push(`任务经历：${episodic.slice(-8).map((e) => `${e.type}#${e.eventSeq}`).join("、")}`);
  if (procedural.length) parts.push(`可复用技能：${procedural.map((s) => s.name).join("、")}`);
  return parts.join("\n");
}

// 任务状态摘要（事实来源）：从结构化 Task/Step 生成，恒注入。
export function taskContextSummary(task: { id: string; title: string; status: string; usage: { tokens: number; toolCalls: number } }, steps: { seq: number; title: string; status: string }[]): string {
  const lines = [`任务 ${task.id}：${task.title}（${task.status}）`, `用量：tokens=${task.usage.tokens} toolCalls=${task.usage.toolCalls}`];
  if (steps.length) lines.push(`步骤：${steps.map((s) => `${s.seq}.[${s.status}]${s.title}`).join("；")}`);
  return lines.join("\n");
}