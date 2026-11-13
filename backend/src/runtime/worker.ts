// Durable Worker：认领(lease)→执行 agent-loop→事件/检查点→心跳续 lease→Evaluator→终态。
// at-least-once + 幂等键 ⇒ 副作用 exactly-once。崩溃后 lease 过期被重认领，从 checkpoint 续跑。
import { randomUUID } from "node:crypto";
import type { AcceptanceCriterion, CompletionCertificate, Task, ToolDef, ToolInvocation } from "../core/types.ts";
import type { LlmTransport } from "../core/llm.ts";
import { runAgentLoop, type AgentLoopResult } from "../core/agent-loop.ts";
import { errorMessage } from "../core/errors.ts";
import type { CompanionRegistry } from "../core/companion.ts";
import { checkFsPath, checkTerminal, checkGroup } from "../core/companion.ts";
import type { EvidenceStore } from "../core/evidence.ts";
import { Evaluator, buildEvaluationInput } from "../core/evaluator.ts";
import type { CapabilityRegistry } from "../core/capability.ts";
import { buildManifest } from "../core/manifest.ts";
import { manifestTools } from "../core/tool-registry.ts";
import type { MemoryStore } from "../core/memory.ts";
import { buildContext, retrieveRelevantMemory, taskContextSummary } from "../core/context-builder.ts";
import type { CompanionServer } from "../core/companion-server.ts";
import type { TaskStore } from "./store.ts";
import type { ApprovalStore } from "./approval.ts";
import { requiresApproval } from "./approval.ts";
import { idempotencyKey, sha256, canonicalArgs } from "./idempotency.ts";
import { canMarkSucceeded } from "./state-machine.ts";

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
      if (task.cancelRequested) { await this.finalize(task, "cancelled"); return; }

      // 恢复：从最新 checkpoint 还原 messages/repeat/usage。
      const cp = await store.latestCheckpoint(task.id);
      // 清理审批暂停哨兵：resume 后让模型重新发起工具调用（审批已决），不重放旧 pending 结果。
      const resumeMessages = cp?.state.messages.filter((m) => !(m.role === "tool" && m.content.includes("__approval_pending__")));
      const repeat = cp ? new Map(Object.entries(cp.state.repeat)) : undefined;

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
        const isHostTool = ["run_terminal", "read_file", "write_file", "sync_group_notices", "list_groups"].includes(name);
        let out: string;
        if (isHostTool && this.companionServer) {
          try { const r = await this.companionServer.invoke(task.userId, name, args); out = JSON.stringify(r ?? { ok: true }); }
          catch (e) { out = JSON.stringify({ error: errorMessage(e) }); }
        } else {
          out = await this.executeTool(task, name, args);
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
      if (this.memoryStore) {
        const relevantMemory = await retrieveRelevantMemory(this.memoryStore, task.userId, task.id);
        const taskContext = taskContextSummary(task, []);
        const composed = buildContext({ layers: { stableInstructions: this.buildSystem(task), taskContext, userProfile: "", relevantMemory, toolSchemas: taskTools }, history: [], user: task.intent, cap: 200000 });
        system = composed.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      }

      const result = await runAgentLoop({
        system,
        user: task.intent,
        resumeMessages,
        repeat,
        deps: {
          transport: this.transport,
          tools: taskTools,
          budget: task.budget,
          executeTool: wrappedExecuteTool,
          hooks: {
            now: this.now,
            onEvent: (type, payload) => { void store.appendEvent({ taskId: task.id, userId: task.userId, type, payload }); },
            onCheckpoint: (state) => {
              void store.renewLease(task.id, this.workerId, this.leaseTtlMs, this.now());
              void store.writeCheckpoint({ taskId: task.id, userId: task.userId, eventSeq: 0, state });
            },
          },
        },
      });

      // 协作式取消：执行后检查标志。
      const fresh = await store.getTask(task.id);
      if (fresh?.cancelRequested) { await this.finalize(task, "cancelled"); return; }

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
        await store.updateTask(task.id, {
          status: "succeeded",
          result: { summary: result.reply, certificate, artifactIds: [], partial: result.budgetExceeded },
        });
        await store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.succeeded", payload: { partial: result.budgetExceeded } });
      } else {
        await store.updateTask(task.id, { status: "failed", error: result.reply, result: { summary: result.reply, certificate, artifactIds: [] } });
        await store.appendEvent({ taskId: task.id, userId: task.userId, type: "task.failed", payload: { reason: result.reply, certificate } });
      }
    } catch (err) {
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