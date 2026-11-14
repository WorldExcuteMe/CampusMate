// Durable Worker：认领(lease)→执行 agent-loop→事件/检查点→心跳续 lease→Evaluator→终态。
// at-least-once + 幂等键 ⇒ 副作用 exactly-once。崩溃后 lease 过期被重认领，从 checkpoint 续跑。
import { randomUUID } from "node:crypto";
import type { AcceptanceCriterion, CompletionCertificate, Task, ToolDef, ToolInvocation } from "../core/types.ts";
import type { LlmTransport } from "../core/llm.ts";
import { CheckpointWriteError, runAgentLoop, type AgentLoopResult } from "../core/agent-loop.ts";
import { errorMessage } from "../core/errors.ts";
import type { CompanionRegistry } from "../core/companion.ts";
import { checkFsPath, checkTerminal, checkGroup } from "../core/companion.ts";
import type { EvidenceStore } from "../core/evidence.ts";
import { Evaluator, buildEvaluationInput } from "../core/evaluator.ts";
import type { CapabilityRegistry } from "../core/capability.ts";
import { buildManifest } from "../core/manifest.ts";
import { manifestTools } from "../core/tool-registry.ts";
import { TOOL_SPECS } from "../core/tool-registry.ts";
import type { MemoryStore } from "../core/memory.ts";
import { buildContext, retrieveRelevantMemory, taskContextSummary } from "../core/context-builder.ts";
import { contentText, messagesTokens, resolveContextCap } from "../core/context.ts";
import type { CompanionServer } from "../core/companion-server.ts";
import type { TaskStore } from "./store.ts";
import type { ApprovalStore } from "./approval.ts";
import { requiresApproval } from "./approval.ts";
import { idempotencyKey, sha256, canonicalArgs } from "./idempotency.ts";
import { canMarkSucceeded } from "./state-machine.ts";
import type { SessionStore } from "../core/storage-contracts.ts";
import type { PersonalContextStore } from "../core/personal-context.ts";
import type { ChatMessage } from "../core/types.ts";
import { assertTurnLease, LeaseLostError, sessionHistory, identityContext, committedPrefix } from "../core/session-context.ts";

export interface WorkerDeps {
  store: TaskStore;
  transport: LlmTransport;
  tools: ToolDef[];
  buildSystem: (task: Task) => string;
  executeTool: (task: Task, name: string, args: Record<string, unknown>) => Promise<string>;
  evaluator?: (task: Task, result: AgentLoopResult) => Promise<CompletionCertificate>;
  approvals?: ApprovalStore;
  companion?: CompanionRegistry;
  evidenceStore?: EvidenceStore;
  acceptance?: (task: Task) => AcceptanceCriterion[];
  capabilityRegistry?: CapabilityRegistry;
  memoryStore?: MemoryStore;
  sessionStore?: SessionStore;
  personalContext?: PersonalContextStore;
  companionServer?: CompanionServer;
  workerId?: string;
  concurrency?: number;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  now?: () => number;
}

// 默认验收：模型可达（无独立证据要求时的基线）。有 evidenceStore 时由独立 Evaluator 按 acceptance 核验。
function defaultAcceptance(_task: Task): AcceptanceCriterion[] {
  return [];
}

export class Worker {
  private store: TaskStore;
  private transport: LlmTransport;
  private tools: ToolDef[];
  private buildSystem: (task: Task) => string;
  private executeTool: (task: Task, name: string, args: Record<string, unknown>) => Promise<string>;
  private evaluator: (task: Task, result: AgentLoopResult) => Promise<CompletionCertificate>;
  private approvals?: ApprovalStore;
  private companion?: CompanionRegistry;
  private evidenceStore?: EvidenceStore;
  private acceptance: (task: Task) => AcceptanceCriterion[];
  private independentEvaluator?: Evaluator;
  private capabilityRegistry?: CapabilityRegistry;
  private memoryStore?: MemoryStore;
  private sessions?: SessionStore;
  private personalContext?: PersonalContextStore;
  private companionServer?: CompanionServer;
  private workerId: string;
  private concurrency: number;
  private leaseTtlMs: number;
  private heartbeatMs: number;
  private now: () => number;

  constructor(deps: WorkerDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.tools = deps.tools;
    this.buildSystem = deps.buildSystem;
    this.executeTool = deps.executeTool;
    this.approvals = deps.approvals;
    this.companion = deps.companion;
    this.evidenceStore = deps.evidenceStore;
    this.acceptance = deps.acceptance ?? defaultAcceptance;
    if (deps.evidenceStore) this.independentEvaluator = new Evaluator({ evidenceStore: deps.evidenceStore });
    this.capabilityRegistry = deps.capabilityRegistry;
    this.memoryStore = deps.memoryStore;
    this.sessions = deps.sessionStore;
    this.personalContext = deps.personalContext;
    this.companionServer = deps.companionServer;
    this.evaluator = deps.evaluator ?? this.defaultEvaluate.bind(this);
    this.workerId = deps.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.concurrency = deps.concurrency ?? 2;
    this.leaseTtlMs = deps.leaseTtlMs ?? 60_000;
    this.heartbeatMs = deps.heartbeatMs ?? 15_000;
    this.now = deps.now ?? Date.now;
  }

  // 默认评估：有独立 Evaluator + 验收条件→逐条核验证据；否则基线（模型可达）。
  private async defaultEvaluate(task: Task, result: AgentLoopResult): Promise<CompletionCertificate> {
    const criteria = this.acceptance(task);
    if (this.independentEvaluator && this.evidenceStore && criteria.length > 0) {
      const evidence = await this.evidenceStore.listByTask(task.id);
      const input = buildEvaluationInput({ reply: result.reply, evidence, citedSources: evidence.map((e) => e.sourceUrl) });
      return this.independentEvaluator.evaluate(task.id, criteria, input);
    }
    const passed = !result.mock;
    return { taskId: task.id, evaluatedBy: "evaluator", passed, criteria: [{ id: "model_reachable", passed, evidenceIds: [], note: passed ? "模型真实答复" : "模型不可达，降级" }], evaluatedAt: this.now() };
  }

  // 认领并执行至多 concurrency 个任务，返回处理数。
  async tick(): Promise<number> {
    let processed = 0;
    for (let i = 0; i < this.concurrency; i++) {
      const task = await this.store.claimNext({ workerId: this.workerId, leaseTtlMs: this.leaseTtlMs, now: this.now() });
      if (!task) break;
      await this.executeTask(task);
      processed++;
    }
    return processed;
  }

  async run(opts: { signal?: AbortSignal; pollMs?: number } = {}): Promise<void> {
    const pollMs = opts.pollMs ?? 1000;
    while (!opts.signal?.aborted) {
      const n = await this.tick();
      if (n === 0) await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async executeTask(task: Task): Promise<void> {
    const store = this.store;
    const heartbeat = setInterval(() => { void store.renewLease(task.id, this.workerId, this.leaseTtlMs, this.now()); }, this.heartbeatMs);
    try {
      if (task.turnId) assertTurnLease(await store.getTask(task.id), { userId: task.userId, workerId: this.workerId, attempt: task.attempt, now: this.now() });
      if (task.cancelRequested) { await this.finalize(task, "cancelled"); return; }

      // 恢复：从最新 checkpoint 还原 messages/repeat/usage。
      const cp = await store.latestCheckpoint(task.id);
      const resumeMessages = cp?.state.messages;
      const repeat = cp ? new Map(Object.entries(cp.state.repeat)) : undefined;
      let history: ChatMessage[] = [];
      let identity = "";
      let priorSummary = "";
      if (task.sessionId && this.sessions) {
        let session = await this.sessions.get(task.userId, task.sessionId);
        if (!session) throw new Error("Session owner forbidden");
        const rows = await this.sessions.listMessages(task.userId, task.sessionId);
        const tasks = await store.listTasksByUser(task.userId);
        history = sessionHistory(rows, tasks, task);
        identity = identityContext(rows, tasks, task);
        if (task.turnSeq && messagesTokens(history) > resolveContextCap() * 0.5) {
          const prefix = committedPrefix(rows, tasks);
          const oldTasks = new Set(tasks.filter((t) => (t.turnSeq ?? task.turnSeq!) < task.turnSeq! - 6).map((t) => t.id));
          const recentStart = Math.min(Infinity, ...rows.filter((m) => !m.taskId || !oldTasks.has(m.taskId)).map((m) => m.seq));
          const through = Math.min(prefix, recentStart - 1);
          const oldRows = rows.filter((m) => m.seq <= through);
          if (through > session.summaryThroughSeq) {
            const summary = `已提交历史片段，原文仍可按seq查阅；摘要不能取代证据：\n${oldRows.map((m) => `[seq=${m.seq},${m.role}] ${contentText(m.content).slice(0, 160)}`).join("\n").slice(0, 6000)}`;
            session = await this.sessions.updateSummary(task.userId, task.sessionId, summary, through);
            if (!session) throw new Error("Session summary owner forbidden");
          }
        }
        if (session.summary) {
          priorSummary = `【历史摘要，覆盖已提交seq<=${session.summaryThroughSeq}；最新用户纠正优先】\n${session.summary}`;
          history = sessionHistory(rows.filter((m) => m.seq > session.summaryThroughSeq), tasks, task);
        }
        if (!rows.some((m) => m.taskId === task.id && m.role === "user")) {
          await this.sessions.appendMessage({ userId: task.userId, sessionId: task.sessionId, turnId: task.turnId ?? task.id, messageKey: `${task.turnId ?? task.id}:user`, taskId: task.id, role: "user", content: task.intent });
        }
      }
      const profile = await this.personalContext?.getProfile(task.userId);
      const userProfile = [profile ? JSON.stringify(profile) : "", priorSummary, identity].filter(Boolean).join("\n\n");
      const saveTranscript = async (transcript: ChatMessage[]) => {
        if (!task.sessionId || !this.sessions) return;
        for (let index = 0; index < transcript.length; index++) {
          await this.sessions.appendMessage({ ...transcript[index], userId: task.userId, sessionId: task.sessionId, turnId: task.id, messageKey: `${task.id}:transcript:${index}`, taskId: task.id });
        }
      };
      let latestState = cp?.state;
      const finishTurn = async (patch: Partial<Task>) => {
        if (task.turnId && this.sessions && store.finishSessionTurn && latestState) {
          await store.finishSessionTurn({ taskId: task.id, userId: task.userId, workerId: this.workerId, attempt: task.attempt, now: this.now(), state: latestState, patch }, this.sessions);
        } else await store.updateTask(task.id, patch);
      };

      // 幂等 + 授权 + 审批包装：已成功的调用直接返回缓存；本机工具需 Companion 授权；高危需审批。
      const wrappedExecuteTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const key = idempotencyKey(name, args, { userId: task.userId });
        const existing = await store.getInvocation(task.id, key);
        if (existing && existing.status === "succeeded") return JSON.stringify(existing.result ?? { ok: true, deduped: true });

        // 本机能力授权（云端默认无 Companion → 拒绝）。
        const hostCheck = this.checkHostAuthorization(task.userId, name, args);
        if (!hostCheck.ok) return JSON.stringify({ error: hostCheck.reason });

        // 高危工具审批门控（服务端强制，非仅 Prompt）。
        const ap = requiresApproval(name, args);
        if (ap.required && this.approvals) {
          const approval = await this.approvals.create({ taskId: task.id, userId: task.userId, toolName: name, args, idempotencyKey: key, risk: ap.risk });
          if (approval.status === "rejected") return JSON.stringify({ error: `审批被拒绝：${ap.risk}` });
          if (approval.status !== "approved") {
            await store.appendEvent({ taskId: task.id, userId: task.userId, type: "tool.approval_requested", payload: { approvalId: approval.id, tool: name, risk: ap.risk } });
            return JSON.stringify({ error: "等待人工审批", approvalId: approval.id, __approval_pending__: true });
          }
        }

        // 本机工具经 CompanionServer RPC 分派（授权+审批通过后）；云工具走 executeTool。
        // Per-tool Timeout 由 Runtime 强制（TOOL_SPECS.timeoutMs）。
        const isHostTool = ["run_terminal", "read_file", "write_file", "sync_group_notices", "list_groups"].includes(name);
        const timeoutMs = TOOL_SPECS[name]?.timeoutMs ?? 60000;
        const runTool = async (): Promise<string> => {
          if (isHostTool && this.companionServer) {
            try { const r = await this.companionServer.invoke(task.userId, name, args); return JSON.stringify(r ?? { ok: true }); }
            catch (e) { return JSON.stringify({ error: errorMessage(e) }); }
          }
          return await this.executeTool(task, name, args);
        };
        let out: string;
        try {
          out = await withTimeout(runTool(), timeoutMs, name);
        } catch (e) {
          out = JSON.stringify({ error: errorMessage(e), class: "tool_transient" });
        }
        let parsed: unknown = out; let ok = true;
        try { parsed = JSON.parse(out); ok = !(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).error); } catch { /* non-json */ }
        const inv: ToolInvocation = {
          id: randomUUID(), taskId: task.id, userId: task.userId, toolName: name,
          idempotencyKey: key, argsHash: sha256(canonicalArgs(args)), runtime: this.companion?.resolve(task.userId) ? "local-companion" : "cloud",
          status: ok ? "succeeded" : "failed", result: parsed, attempt: 1, startedAt: this.now(), finishedAt: this.now(),
        };
        await store.recordInvocation(inv);
        return out;
      };

      // 任务前生成 Environment Manifest，按可用能力过滤工具集（确定性门控）。
      let taskTools = this.tools;
      if (this.capabilityRegistry) {
        const manifest = buildManifest({ registry: this.capabilityRegistry, companion: this.companion, userId: task.userId, taskId: task.id, budget: task.budget });
        taskTools = manifestTools(manifest, this.tools);
        await store.appendEvent({ taskId: task.id, userId: task.userId, type: "step.started", payload: { manifest: { runtime: manifest.runtime, capabilities: manifest.capabilities.filter((c) => c.available).map((c) => c.id) } } });
      }

      // 分层上下文：taskContext（事实来源）恒注入 + 记忆隔离检索。
      let system = this.buildSystem(task);
      if (this.memoryStore || this.sessions || userProfile) {
        const relevantMemory = this.memoryStore ? await retrieveRelevantMemory(this.memoryStore, task.userId, task.id) : "";
        const taskContext = taskContextSummary(task, []);
        const composed = buildContext({ layers: { stableInstructions: this.buildSystem(task), taskContext, userProfile, relevantMemory, toolSchemas: taskTools }, history, user: task.intent, cap: resolveContextCap() });
        system = composed.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
        history = composed.messages.filter((m) => m.role !== "system").slice(0, -1);
      }

      const result = await runAgentLoop({
        system,
        user: task.intent,
        images: task.images,
        history,
        resumeMessages,
        resumeTranscript: cp?.state.transcript,
        initialUsage: cp?.state.usage,
        repeat,
        deps: {
          transport: this.transport,
          tools: taskTools,
          budget: task.budget,
          executeTool: wrappedExecuteTool,
          hooks: {
            now: this.now,
            onPromptUsage: async (promptUsage) => { await store.updateTask(task.id, { promptUsage }); },
            onEvent: (type, payload) => { void store.appendEvent({ taskId: task.id, userId: task.userId, type, payload }); },
            onCheckpoint: async (state) => {
              latestState = state;
              await store.renewLease(task.id, this.workerId, this.leaseTtlMs, this.now());
              if (task.turnId && this.sessions && store.saveTurnProgress) {
                await store.saveTurnProgress({ taskId: task.id, userId: task.userId, workerId: this.workerId, attempt: task.attempt, now: this.now(), state }, this.sessions);
                return;
              }
              await saveTranscript(state.transcript ?? []);
              await store.writeCheckpoint({ taskId: task.id, userId: task.userId, eventSeq: 0, state });
            },
          },
        },
      });
      latestState = { messages: result.messages, transcript: result.transcript, stepProgress: {}, repeat: {}, usage: result.usage, pendingApprovals: [] };
      if (!task.turnId) await saveTranscript(result.transcript);

      // 协作式取消：执行后检查标志。
      const fresh = await store.getTask(task.id);
      if (fresh?.cancelRequested) { await finishTurn({ status: "cancelled" }); return; }

      await store.updateTask(task.id, { usage: result.usage });

      // 审批暂停：转 needs_input，等待人工审批后 resume（不执行未批准的高危工具）。
      if (result.paused) {
        await store.updateTask(task.id, { status: "needs_input" });
        await store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.needs_input", payload: { reason: "approval_pending" } });
        return;
      }

      const certificate = await this.evaluator(task, result);
      await store.appendEvent({ taskId: task.id, userId: task.userId, type: certificate.passed ? "eval.passed" : "eval.failed", payload: { certificate } });

      if (canMarkSucceeded(certificate.passed)) {
        await finishTurn({
          status: "succeeded",
          result: { summary: result.reply, certificate, artifactIds: [], partial: result.budgetExceeded },
        });
        await store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.succeeded", payload: { partial: result.budgetExceeded } });
      } else {
        await finishTurn({ status: "failed", error: result.reply, result: { summary: result.reply, certificate, artifactIds: [] } });
        await store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.failed", payload: { reason: result.reply, certificate } });
      }
    } catch (err) {
      if (err instanceof LeaseLostError) return;
      if (err instanceof CheckpointWriteError) {
        await store.updateTask(task.id, { status: "paused", error: err.message }).catch(() => {});
        await store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.needs_input", payload: { reason: "persistence_failed", message: err.message } }).catch(() => {});
        return;
      }
      await store.updateTask(task.id, { status: "failed", error: errorMessage(err) }).catch(() => {});
      await store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.failed", payload: { reason: errorMessage(err) } });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async finalize(task: Task, status: "cancelled"): Promise<void> {
    await this.store.updateTask(task.id, { status });
    await this.store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.cancelled", payload: {} });
  }

  // 本机工具授权：必须注册 Companion 且具备对应能力 + 授权范围；云端默认拒绝。
  private checkHostAuthorization(userId: string, name: string, args: Record<string, unknown>): { ok: boolean; reason?: string } {
    const hostTools: Record<string, "host.terminal" | "host.fs.read" | "host.fs.write" | "ingest.qq" | "ingest.wechat"> = {
      run_terminal: "host.terminal", read_file: "host.fs.read", write_file: "host.fs.write",
      sync_group_notices: "ingest.qq", list_groups: "ingest.qq",
    };
    const cap = hostTools[name];
    if (!cap) return { ok: true }; // 云工具不受此限
    if (!this.companion) return { ok: false, reason: `本机能力 ${name} 需 Local Companion（云端默认禁用）` };
    const reg = this.companion.resolve(userId);
    if (!reg) return { ok: false, reason: `本机能力 ${name} 需 Local Companion（云端默认禁用）` };
    if (!reg.capabilities.includes(cap)) return { ok: false, reason: `Companion 未授权能力 ${cap}` };
    if (name === "run_terminal") return checkTerminal(reg.grantedScopes, String(args.command ?? ""));
    if (name === "read_file") return checkFsPath(reg.grantedScopes, String(args.path ?? ""), false);
    if (name === "write_file") return checkFsPath(reg.grantedScopes, String(args.path ?? ""), true);
    if (name === "sync_group_notices") return checkGroup(reg.grantedScopes, args.group ? String(args.group) : undefined);
    return { ok: true };
  }
}

// Per-tool Timeout：Runtime 强制，超时抛错（转 tool_transient 观测）。
function withTimeout<T>(p: Promise<T>, ms: number, tool: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`工具 ${tool} 超时（${ms}ms）`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
