// Scripted Target：直接驱动真实 runAgentLoop（不经过 HTTP/Worker）。
// 用途：Fast 级回归——毫秒级、确定性；验证 Agent Core 的工具协议/上下文/恢复/预算行为。
// 多轮支持：同一 case 内顺序执行 turns，把上一轮 transcript 作为 history 注入（近似人类连续输入）。
// 边界（必须在报告里如实说明）：不覆盖 HTTP/JWT、Worker 状态机、真实 session、执行期独立 Evaluator、审批门控。
import { randomUUID } from "node:crypto";
import { buildContext, type AppContext } from "../../app-context.ts";
import { runAgentLoop, type AgentLoopResult } from "../../core/agent-loop.ts";
import { CLOUD_TOOLS, executeCloudTool } from "../../core/cloud-tools.ts";
import { errorMessage, LlmTransportError } from "../../core/errors.ts";
import type { LlmTransport } from "../../core/llm.ts";
import { DEFAULT_BUDGET, type Budget, type ChatMessage, type ChatResult, type EventType, type TaskStatus, type ToolDef } from "../../core/types.ts";
import { caseSystemPrompt, businessSnapshot, seedCaseContext, userIdForCase } from "./shared.ts";
import { createTraceCollector, isToolResultOk, previewToolResult } from "../trace.ts";
import { mergeTurnObservations } from "./turns.ts";
import type {
  EvalCase, EvalObservation, EvalRunCaseOptions, EvalTarget, EvalTurnObservation, ScriptStep,
  TargetDescription, TargetOptions,
} from "../types.ts";

// 脚本化模型：按顺序回放 ScriptStep；脚本耗尽后返回空 content 结束循环（不重复最后一步，避免假循环）。
export class ScriptedTransport implements LlmTransport {
  private index = 0;
  private readonly steps: ScriptStep[];
  private readonly caseId: string;
  private readonly transportError?: string;
  readonly calls: Array<{ round: number; toolCalls: number; usage: { input: number; output: number }; model: string }> = [];

  constructor(steps: ScriptStep[], caseId: string, transportError?: string) {
    this.steps = steps; this.caseId = caseId; this.transportError = transportError;
  }
  estimateInputTokens(): number { return this.steps[this.index]?.usage?.input ?? 10; }

  async chat(_options: { messages: ChatMessage[] }): Promise<ChatResult> {
    if (this.transportError) throw new LlmTransportError(this.transportError);
    const round = ++this.index;
    const step = this.steps[round - 1];
    const toolCalls = (step?.toolCalls ?? []).map((call, i) => ({
      id: call.id ?? `${this.caseId}-call-${round}-${i}`,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
    const usage = step?.usage ?? { input: 10, output: 10 };
    const model = step?.model ?? "scripted-model";
    this.calls.push({ round, toolCalls: toolCalls.length, usage, model });
    return { content: step?.content ?? "", toolCalls, usage, model };
  }
}

// 外部网络工具：scripted 通道默认禁止真实网络，必须由用例提供夹具。
const EXTERNAL_TOOLS = new Set(["web_search", "web_fetch"]);
const TOOL_POLICY_REFUSAL = "用户已明确限制信息来源/未提供外部工具，不能访问外部网络。";

function selectTools(c: EvalCase): ToolDef[] {
  const allowed = c.toolNames ? CLOUD_TOOLS.filter((t) => c.toolNames!.includes(t.function.name)) : CLOUD_TOOLS;
  return [...allowed].sort((a, b) => a.function.name.localeCompare(b.function.name));
}

function statusOf(result: AgentLoopResult): TaskStatus {
  if (result.error || result.mock) return "failed";
  if (result.paused) return "needs_input";
  if (result.budgetExceeded || result.truncated) return "paused";
  return "succeeded";
}

interface TurnInput {
  prompt: string;
  images?: string[];
  script: ScriptStep[];
  turn: number;
}

export class ScriptedTarget implements EvalTarget {
  readonly kind = "scripted" as const;
  private ctx?: AppContext;
  private options?: TargetOptions;

  async setup(options: TargetOptions): Promise<void> {
    this.options = options;
    // 仅内存存储：不触碰真实数据库/网络（外部工具由夹具替代）。
    this.ctx = buildContext({ NODE_ENV: "test" });
  }

  async run(c: EvalCase, runOptions: EvalRunCaseOptions): Promise<EvalObservation> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("ScriptedTarget 未 setup");
    const userId = userIdForCase(c.id);
    await seedCaseContext(ctx, c, userId);
    if (!c.turns?.length) {
      if (!c.script?.length) throw new Error(`用例 ${c.id} 没有 script，不能用于 scripted 通道；请改用 live 通道或补充 script`);
      const startedAt = this.now();
      const turn = await this.executeTurn(c, userId, { prompt: c.prompt, ...(c.images ? { images: c.images } : {}), script: c.script, turn: 1 }, [], runOptions);
      const finishedAt = this.now();
      const { observation } = turn;
      return {
        case: c, target: "scripted", status: observation.status, reply: observation.reply,
        toolCalls: observation.toolCalls, trace: observation.trace, business: observation.business,
        usage: { ...observation.usage, wallMs: finishedAt - startedAt }, durationMs: finishedAt - startedAt,
        mock: observation.mock, ...(observation.error ? { error: observation.error } : {}),
      };
    }
    // 多轮：同一进程内顺序执行，上一轮 transcript 作为 history。
    const startedAt = this.now();
    const turns: EvalTurnObservation[] = [];
    let history: ChatMessage[] = [];
    for (let i = 0; i < c.turns.length; i++) {
      const spec = c.turns[i];
      if (!spec.script?.length) throw new Error(`用例 ${c.id} 第 ${i + 1} 轮没有 turns[].script，不能用于 scripted 通道`);
      const result = await this.executeTurn(c, userId, {
        prompt: spec.prompt, ...(spec.images ? { images: spec.images } : {}), script: spec.script, turn: i + 1,
      }, history, runOptions);
      turns.push(result.observation);
      history = [...history, { role: "user", content: spec.prompt }, ...result.transcript.filter((message) => message.role !== "system")];
      if (runOptions.signal?.aborted) break;
    }
    const finishedAt = this.now();
    return mergeTurnObservations(c, "scripted", turns, { startedAt, finishedAt });
  }

  private now(): number {
    return this.options?.now ? this.options.now() : Date.now();
  }

  private async executeTurn(c: EvalCase, userId: string, input: TurnInput, history: ChatMessage[], runOptions: EvalRunCaseOptions): Promise<{ observation: EvalTurnObservation; transcript: ChatMessage[] }> {
    const ctx = this.ctx!;
    const now = this.options?.now;
    const startedAt = this.now();
    const taskId = `scripted-${c.id}-t${input.turn}-${randomUUID().slice(0, 8)}`;
    const collector = createTraceCollector(c.id, "scripted");
    const transport = new ScriptedTransport(input.script, c.id, c.simulate?.transportError);
    let checkpointMessages: number | undefined;

    const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const toolStarted = now ? now() : Date.now();
      let out: string;
      try {
        const stub = c.toolStubs?.[name];
        if (stub) {
          if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
          out = stub.error ? JSON.stringify({ error: stub.error }) : JSON.stringify(stub.ok ?? {});
        } else if (EXTERNAL_TOOLS.has(name)) {
          out = JSON.stringify({ error: `离线评测禁止真实网络：${name} 未提供 toolStubs 夹具。${TOOL_POLICY_REFUSAL}` });
        } else {
          out = await executeCloudTool(name, args, {
            taskId, userId, intent: input.prompt,
            campusRecords: ctx.campusRecords, evidenceStore: ctx.evidenceStore, opportunityStore: ctx.opportunityStore,
            artifactStore: ctx.artifactStore, documents: ctx.documents,
          });
        }
      } catch (error) {
        out = JSON.stringify({ error: errorMessage(error) });
      }
      collector.addTool({
        name, args, ok: isToolResultOk(out), approvalPending: false,
        resultPreview: previewToolResult(out), durationMs: (now ? now() : Date.now()) - toolStarted,
      });
      return out;
    };

    let result: AgentLoopResult | null = null;
    let failure: string | undefined;
    try {
      result = await runAgentLoop({
        system: caseSystemPrompt(c),
        user: input.prompt,
        ...(input.images ? { images: input.images } : {}),
        ...(history.length ? { history } : {}),
        deps: {
          transport,
          tools: selectTools(c),
          budget: { ...DEFAULT_BUDGET, ...(c.budget ?? {}) } as Budget,
          executeTool,
          ...(runOptions.signal ? { signal: runOptions.signal } : {}),
          hooks: {
            onEvent: (type: EventType, payload: Record<string, unknown>) => { collector.addEvent(type, payload); },
            onCheckpoint: (state) => { checkpointMessages = state.messages.length; },
          },
        },
      });
    } catch (error) {
      failure = errorMessage(error);
    }

    for (const call of transport.calls) {
      collector.addLlmRound({ round: call.round, turn: input.turn, toolCalls: call.toolCalls });
      collector.addModel(call.model);
    }
    const reply = result?.reply ?? "";
    const status: TaskStatus | "error" = result ? statusOf(result) : "error";
    const error = failure ?? result?.error;
    const finishedAt = this.now();
    const trace = collector.build({
      startedAt, finishedAt, finalStatus: status, finalOutput: reply,
      ...(checkpointMessages !== undefined ? { checkpointMessageCount: checkpointMessages } : {}),
      ...(error ? { error } : {}),
    });
    const business = await businessSnapshot(ctx, userId, taskId);
    const observation: EvalTurnObservation = {
      turn: input.turn, prompt: input.prompt, taskId, status, reply,
      toolCalls: trace.tools, trace, business,
      usage: result?.usage ?? { tokens: 0, toolCalls: trace.tools.length, wallMs: finishedAt - startedAt, costUsd: 0 },
      durationMs: finishedAt - startedAt,
      mock: Boolean(result?.mock),
      ...(error ? { error } : {}),
    };
    return { observation, transcript: result?.transcript ?? [] };
  }

  async dispose(): Promise<void> {
    await this.ctx?.dispose();
    this.ctx = undefined;
  }

  describe(): TargetDescription {
    return {
      kind: "scripted", label: "Scripted loop（runAgentLoop，无 HTTP/Worker）",
      realModel: false, durableStore: false, networkTools: false, supportsBusinessFacts: true,
      notes: [
        "毫秒级确定性回归；脚本回放模型输出，真实执行 Agent Core 工具循环",
        "支持多轮 turns（进程内 history 注入），但不是真实 session/Worker 语义，不能替代 live 对话评测",
        "不覆盖 HTTP/JWT、Worker 状态机、真实 session、审批暂停与执行期独立 Evaluator",
        "外部网络工具必须由 toolStubs 提供夹具，不会访问真实网络",
      ],
    };
  }
}
