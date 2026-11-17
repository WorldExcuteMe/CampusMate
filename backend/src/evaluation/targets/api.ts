// API Target：HTTP API + Worker + InMemoryStore + 脚本化/真实模型。
// api-memory：完整运行时契约（JWT/任务状态机/事件/幂等/审批/独立 Evaluator），模型脚本回放，零真实网络。
// live：同一套运行时，真实 Provider（backend/.env 的 LLM_API_KEY）与真实工具，数据写内存库，
//       不污染云端 Postgres；用于验证「真实模型端到端能力」而不需要任何浏览器/Computer Use。
// 多轮/会话：与人类聊天一致，走 POST /v1/sessions + 每轮 POST /v1/tasks(sessionId,turnId)，Worker 注入历史/身份。
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { buildContext, createApiServer, type AppContext } from "../../app-context.ts";
import { Worker } from "../../runtime/worker.ts";
import { CLOUD_TOOLS, executeCloudTool } from "../../core/cloud-tools.ts";
import { CAMPUS_SYSTEM } from "../../core/system-prompt.ts";
import { signJwt } from "../../api/jwt.ts";
import { errorMessage, LlmTransportError } from "../../core/errors.ts";
import type { LlmTransport } from "../../core/llm.ts";
import type { Task, TaskStatus } from "../../core/types.ts";
import { businessSnapshot, caseSystemPrompt, seedCaseContext, safeCaseId, userIdForCase } from "./shared.ts";
import { createTraceCollector, isToolResultOk, previewToolResult } from "../trace.ts";
import { mergeTurnObservations } from "./turns.ts";
import type {
  EvalCase, EvalObservation, EvalRunCaseOptions, EvalTarget, EvalTurnObservation, ScriptStep,
  TargetDescription, TargetOptions, TraceToolCall,
} from "../types.ts";
import { ScriptedTransport } from "./scripted.ts";

type ApiMode = "script" | "live";

const EXTERNAL_TOOLS = new Set(["web_search", "web_fetch"]);
const TERMINAL: TaskStatus[] = ["succeeded", "failed", "cancelled", "needs_input", "paused"];
const JWT_SECRET = "campusmate-eval-hs256-secret";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// live 通道 env：保留模型密钥/代理配置，移除真实数据库，强制内存存储（评测数据不外溢）。
function liveEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test" };
  for (const key of ["DATABASE_URL", "DATABASE_PROXY_URL", "DATABASE_SSL_CA_FILE", "SUPABASE_PROJECT_REF", "SUPABASE_DB_PASSWORD", "PORT"]) delete env[key];
  return env;
}

interface TurnRequest {
  prompt: string;
  images?: string[];
  script?: ScriptStep[];
  turn: number;
}

export class ApiTarget implements EvalTarget {
  readonly kind: "api-memory" | "live";
  private readonly mode: ApiMode;
  private ctx?: AppContext;
  private server?: http.Server;
  private abort?: AbortController;
  private baseUrl = "";
  private options?: TargetOptions;
  private envSnapshot: Record<string, string | undefined> = {};
  // 单轮：intent → case；多轮：sessionId+intent → case（同一 prompt 在不同轮/会话可复现）。
  private readonly cases = new Map<string, EvalCase>();
  private readonly scripts = new Map<string, ScriptStep[]>();
  private readonly toolRecords = new Map<string, TraceToolCall[]>();
  private readonly workerErrors: string[] = [];

  constructor(mode: ApiMode) {
    this.mode = mode;
    this.kind = mode === "live" ? "live" : "api-memory";
  }

  async setup(options: TargetOptions): Promise<void> {
    this.options = options;
    this.envSnapshot = options.env ?? (this.mode === "live" ? liveEnv() : { NODE_ENV: "test" });
    this.ctx = buildContext(this.envSnapshot);
    this.abort = new AbortController();
    this.server = createApiServer({
      store: this.ctx.store, jwtSecret: JWT_SECRET, storeKind: "memory",
      approvals: this.ctx.approvals, capabilityRegistry: this.ctx.capabilityRegistry, companion: this.ctx.companion,
      personalContext: this.ctx.personalContext, opportunityStore: this.ctx.opportunityStore,
      sessionStore: this.ctx.sessionStore, providers: this.ctx.providers,
      artifactStore: this.ctx.artifactStore, documents: this.ctx.documents,
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server!.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    // 一个 Worker 一次只执行一个任务（tick 内串行）；并发由多个 Worker 提供。
    const workerCount = Math.max(2, options.concurrency);
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker({
        store: this.ctx.store,
        tools: CLOUD_TOOLS,
        resolveTransport: (task) => this.transportFor(task),
        buildSystem: (task) => { const c = this.resolveCase(task); return c ? caseSystemPrompt(c) : CAMPUS_SYSTEM; },
        executeTool: (task, name, args) => this.executeTool(task, name, args),
        approvals: this.ctx.approvals,
        companion: this.ctx.companion,
        evidenceStore: this.ctx.evidenceStore,
        capabilityRegistry: this.ctx.capabilityRegistry,
        memoryStore: this.ctx.memoryStore,
        sessionStore: this.ctx.sessionStore,
        personalContext: this.ctx.personalContext,
        artifactStore: this.ctx.artifactStore,
        workerId: `eval-${this.kind}-${i}`,
        concurrency: 1,
      });
      void worker.run({ signal: this.abort.signal, pollMs: 50 }).catch((error) => { this.workerErrors.push(errorMessage(error)); });
    }
  }

  private key(sessionId: string | undefined, intent: string): string {
    return `${sessionId ?? ""}\n${intent}`;
  }

  private resolveCase(task: Pick<Task, "sessionId" | "intent">): EvalCase | undefined {
    return this.cases.get(this.key(task.sessionId, task.intent)) ?? this.cases.get(this.key(undefined, task.intent));
  }

  private async transportFor(task: Task): Promise<LlmTransport> {
    if (this.mode === "live") return this.ctx!.providers.transport(task);
    const c = this.resolveCase(task);
    if (!c) throw new LlmTransportError("评测脚本缺失：未找到该任务对应用例");
    const script = this.scripts.get(this.key(task.sessionId, task.intent));
    if (!script?.length) throw new LlmTransportError(`用例 ${c.id} 该轮没有 script，不能用于 api-memory 通道；请改用 live 通道或补充 turns[].script`);
    return new ScriptedTransport(script, c.id, c.simulate?.transportError);
  }

  private async executeTool(task: Task, name: string, args: Record<string, unknown>): Promise<string> {
    const ctx = this.ctx!;
    const c = this.resolveCase(task);
    const startedAt = Date.now();
    let out: string;
    try {
      const stub = c?.toolStubs?.[name];
      if (stub) {
        if (stub.delayMs) await sleep(stub.delayMs);
        out = stub.error ? JSON.stringify({ error: stub.error }) : JSON.stringify(stub.ok ?? {});
      } else if (this.options?.offlineTools && EXTERNAL_TOOLS.has(name)) {
        out = JSON.stringify({ error: `离线评测禁止真实网络：${name} 未提供 toolStubs 夹具` });
      } else {
        out = await executeCloudTool(name, args, {
          taskId: task.id, userId: task.userId, intent: task.intent,
          campusRecords: ctx.campusRecords, evidenceStore: ctx.evidenceStore, opportunityStore: ctx.opportunityStore,
          artifactStore: ctx.artifactStore, documents: ctx.documents, businessStore: ctx.businessStore,
        });
      }
    } catch (error) {
      out = JSON.stringify({ error: errorMessage(error) });
    }
    const record: TraceToolCall = {
      seq: 0, name, args, ok: isToolResultOk(out), approvalPending: false,
      resultPreview: previewToolResult(out), durationMs: Date.now() - startedAt,
    };
    const records = this.toolRecords.get(task.id) ?? [];
    records.push(record);
    this.toolRecords.set(task.id, records);
    return out;
  }

  async run(c: EvalCase, runOptions: EvalRunCaseOptions): Promise<EvalObservation> {
    if (!this.ctx) throw new Error("ApiTarget 未 setup");
    if (c.turns?.length) return this.runMultiTurn(c, runOptions);
    return this.runSingle(c, runOptions);
  }

  private async runSingle(c: EvalCase, runOptions: EvalRunCaseOptions): Promise<EvalObservation> {
    const ctx = this.ctx!;
    const now = this.options?.now;
    const startedAt = now ? now() : Date.now();
    const userId = userIdForCase(c.id);
    const existing = this.cases.get(this.key(undefined, c.prompt));
    if (existing && existing.id !== c.id) throw new Error(`跨套件 prompt 重复：${existing.id} / ${c.id}（脚本化模型按 prompt 路由，必须唯一）`);
    await seedCaseContext(ctx, c, userId);
    const token = signJwt({ sub: userId, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const deadline = Date.now() + runOptions.timeoutMs;
    // 单轮也可显式启用真实 session（更接近人类聊天入口）。
    const sessionId = this.options?.useSession ? await this.createSession(c, token) : undefined;
    const turn = await this.runTurn(c, {
      userId, token, deadline, signal: runOptions.signal, turn: 1,
      prompt: c.prompt, ...(c.images ? { images: c.images } : {}), ...(c.script ? { script: c.script } : {}),
      ...(sessionId ? { sessionId, turnId: randomUUID() } : {}),
    });
    if (sessionId) {
      const messageCount = await this.sessionMessageCount(sessionId, token);
      turn.trace = { ...turn.trace, session: { id: sessionId, ...(messageCount !== undefined ? { messageCount } : {}) } };
    }
    const finishedAt = now ? now() : Date.now();
    return {
      case: c, target: this.kind, status: turn.status, reply: turn.reply,
      toolCalls: turn.toolCalls, trace: turn.trace, business: turn.business,
      usage: turn.usage, durationMs: finishedAt - startedAt, mock: turn.mock,
      ...(turn.error ? { error: turn.error } : {}),
    };
  }

  private async runMultiTurn(c: EvalCase, runOptions: EvalRunCaseOptions): Promise<EvalObservation> {
    const ctx = this.ctx!;
    const now = this.options?.now;
    const startedAt = now ? now() : Date.now();
    const userId = userIdForCase(c.id);
    await seedCaseContext(ctx, c, userId);
    const token = signJwt({ sub: userId, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const deadline = Date.now() + runOptions.timeoutMs;
    const sessionId = await this.createSession(c, token);
    const sessions = new Map<string, string>([[c.turns![0].sessionKey ?? "default", sessionId]]);
    const turns: EvalTurnObservation[] = [];
    for (let i = 0; i < c.turns!.length; i++) {
      const spec = c.turns![i];
      const sessionKey = spec.sessionKey ?? "default";
      if (!sessions.has(sessionKey)) sessions.set(sessionKey, await this.createSession(c, token));
      const activeSessionId = sessions.get(sessionKey)!;
      if (this.mode === "script" && !spec.script?.length) throw new Error(`用例 ${c.id} 第 ${i + 1} 轮没有 turns[].script，不能用于 api-memory 通道`);
      try {
        turns.push(await this.runTurn(c, {
          userId, token, deadline, signal: runOptions.signal, turn: i + 1,
          prompt: spec.prompt, ...(spec.images ? { images: spec.images } : {}),
          ...(spec.script ? { script: spec.script } : {}),
          sessionId: activeSessionId, turnId: randomUUID(),
        }));
      } catch (error) {
        turns.push({
          turn: i + 1, prompt: spec.prompt, status: "error", reply: "", toolCalls: [],
          trace: {
            caseId: c.id, target: this.kind, startedAt: now ? now() : Date.now(), finishedAt: now ? now() : Date.now(),
            events: [], llm: { requests: 0, rounds: [], models: [], telemetry: [] }, tools: [], steps: [],
            finalStatus: "error", finalOutput: "", error: errorMessage(error),
          },
          business: await businessSnapshot(ctx, userId, `${c.id}-turn-${i + 1}`),
          usage: { tokens: 0, toolCalls: 0, wallMs: 0, costUsd: 0 }, durationMs: 0, mock: false,
          error: errorMessage(error),
        });
        break;
      }
      if (["paused", "needs_input"].includes(turns.at(-1)?.status ?? "") && (c.turns![i + 1]?.sessionKey ?? "default") === sessionKey) break;
      if (runOptions.signal?.aborted) break;
    }
    const finishedAt = now ? now() : Date.now();
    const messageCount = await this.sessionMessageCount(sessionId, token);
    const merged = mergeTurnObservations(c, this.kind, turns, {
      startedAt, finishedAt, session: { id: sessionId, ...(messageCount !== undefined ? { messageCount } : {}) },
    });
    return merged;
  }

  // 单轮任务提交 + 等待终态 + 采集该轮结构化观测。
  private async runTurn(c: EvalCase, input: {
    userId: string; token: string; deadline: number; signal?: AbortSignal; turn: number; prompt: string;
    images?: string[]; script?: ScriptStep[]; sessionId?: string; turnId?: string;
  }): Promise<EvalTurnObservation> {
    const ctx = this.ctx!;
    const now = this.options?.now;
    const startedAt = now ? now() : Date.now();
    this.cases.set(this.key(input.sessionId, input.prompt), c);
    if (input.script?.length) this.scripts.set(this.key(input.sessionId, input.prompt), input.script);
    const created = await this.http("POST", "/v1/tasks", input.token, {
      title: `${c.id}${input.turn > 1 ? ` T${input.turn}` : ""}`,
      intent: input.prompt,
      ...(input.images ? { images: input.images } : {}),
      ...(c.budget ? { budget: c.budget } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId, turnId: input.turnId ?? randomUUID() } : {}),
      ...(this.options?.reasoning ? { reasoning: this.options.reasoning } : {}),
      ...(this.options?.providerId ? { providerId: this.options.providerId } : {}),
    });
    if (created.status >= 300 || typeof created.body.taskId !== "string") {
      throw new Error(`提交评测任务失败（HTTP ${created.status}）：${JSON.stringify(created.body).slice(0, 300)}`);
    }
    const taskId = created.body.taskId as string;
    let task: Task | null = null;
    let error: string | undefined;
    let timedOut = false;
    while (true) {
      if (input.signal?.aborted) { await this.cancel(taskId, input.token); error = "评测被取消"; break; }
      const poll = await this.http("GET", `/v1/tasks/${taskId}`, input.token);
      task = poll.body.task as Task;
      if (task && TERMINAL.includes(task.status)) break;
      if (Date.now() > input.deadline) {
        timedOut = true;
        await this.cancel(taskId, input.token);
        await sleep(200);
        const after = await this.http("GET", `/v1/tasks/${taskId}`, input.token);
        task = after.body.task as Task;
        error = `评测超时（第 ${input.turn} 轮）`;
        break;
      }
      await sleep(80);
    }
    if (!task) throw new Error(`评测任务状态不可读：${taskId}`);
    const eventsResponse = await this.http("GET", `/v1/tasks/${taskId}/events`, input.token);
    const events = Array.isArray(eventsResponse.body.events) ? eventsResponse.body.events as Array<{ seq: number; type: string; payload: Record<string, unknown>; createdAt: number }> : [];
    const business = await businessSnapshot(ctx, input.userId, taskId);
    // Verify the actual authenticated download route; persist the received
    // bytes so live deliverables remain inspectable after the memory DB ends.
    for (const artifact of business.artifacts.filter(item => item.kind === "document-export" && item.sourceArtifactId && item.format)) {
      try {
        const response = await fetch(`${this.baseUrl}/v1/artifacts/${encodeURIComponent(artifact.sourceArtifactId!)}/download?format=${artifact.format}`, { headers: { Authorization: `Bearer ${input.token}` }, signal: AbortSignal.timeout(15000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        const stored = await ctx.artifactStore.get(input.userId, artifact.id);
        const expected = stored && ctx.documents.file(stored);
        artifact.downloadVerified = Boolean(response.ok && expected && createHash("sha256").update(bytes).digest("hex") === expected.sha256);
        if (artifact.downloadVerified && this.options?.artifactsDir) {
          const directory = path.join(this.options.artifactsDir, safeCaseId(c.id));
          await fs.mkdir(directory, { recursive: true });
          const file = path.join(directory, `turn-${input.turn}-${artifact.id}.${artifact.format}`);
          await fs.writeFile(file, bytes); artifact.evidencePath = file;
        }
      } catch { artifact.downloadVerified = false; }
    }
    const collector = createTraceCollector(c.id, this.kind);
    for (const event of events) collector.addEvent(event.type, event.payload ?? {}, event.createdAt);
    const requests = events.filter((e) => e.type === "llm.request");
    const responses = events.filter((e) => e.type === "llm.response");
    for (let i = 0; i < requests.length; i++) {
      const response = responses[i];
      collector.addLlmRound({
        round: Number(requests[i].payload.round ?? i + 1),
        turn: input.turn,
        ...(typeof requests[i].payload.stage === "string" ? { stage: requests[i].payload.stage as string } : {}),
        toolCalls: Number(response?.payload.toolCalls ?? 0),
        ...(response?.payload.telemetry !== undefined ? { telemetry: response.payload.telemetry } : {}),
      });
    }
    collector.addModel(task.modelRuntime?.actualModel);
    for (const record of this.toolRecords.get(taskId) ?? []) {
      const { seq: _seq, ...tool } = record;
      collector.addTool(tool);
    }
    const reply = task.result?.summary ?? task.error ?? "";
    const status: TaskStatus | "error" = timedOut ? "error" : task.status;
    const traceError = error ?? (task.status === "failed" ? task.error : undefined);
    const finishedAt = now ? now() : Date.now();
    const trace = collector.build({
      startedAt, finishedAt, finalStatus: status, finalOutput: reply,
      ...(task.result?.certificate ? { certificate: task.result.certificate } : {}),
      ...(traceError ? { error: traceError } : {}),
    });
    if (input.sessionId) trace.session = { id: input.sessionId };
    const observation: EvalTurnObservation = {
      turn: input.turn, prompt: input.prompt, taskId, status, reply: reply || "",
      toolCalls: trace.tools, trace, business,
      usage: task.usage, durationMs: finishedAt - startedAt, mock: false,
      ...(traceError ? { error: traceError } : {}),
    };
    if (this.options?.artifactsDir) {
      const directory = path.join(path.dirname(this.options.artifactsDir), "turn-results", safeCaseId(c.id));
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${input.turn}.json`), JSON.stringify(observation, null, 2));
    }
    return observation;
  }

  private async createSession(c: EvalCase, token: string): Promise<string> {
    const created = await this.http("POST", "/v1/sessions", token, { title: `${c.id}`.slice(0, 160), mode: "auto" });
    if (created.status >= 300 || typeof created.body?.session?.id !== "string") {
      throw new Error(`创建评测会话失败（HTTP ${created.status}）：${JSON.stringify(created.body).slice(0, 300)}`);
    }
    return created.body.session.id as string;
  }

  private async sessionMessageCount(sessionId: string, token: string): Promise<number | undefined> {
    try {
      const response = await this.http("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/messages?afterSeq=0`, token);
      return Array.isArray(response.body?.messages) ? response.body.messages.length : undefined;
    } catch { return undefined; }
  }

  private async cancel(taskId: string, token: string): Promise<void> {
    try { await this.http("POST", `/v1/tasks/${taskId}/cancel`, token, {}); } catch { /* 取消失败不掩盖原始错误 */ }
  }

  private async http(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(this.baseUrl + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let parsed: any = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 500) }; }
    return { status: response.status, body: parsed };
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    for (const end of [this.server]) {
      if (!end) continue;
      try { end.closeAllConnections?.(); } catch { /* ignore */ }
      await new Promise<void>((resolve) => end.close(() => resolve()));
    }
    this.server = undefined;
    await this.ctx?.dispose();
    this.ctx = undefined;
    this.cases.clear();
    this.scripts.clear();
    this.toolRecords.clear();
  }

  describe(): TargetDescription {
    const model = this.modelInfo();
    const live = this.mode === "live";
    const entry: string[] = [];
    if (this.options?.reasoning) entry.push(`reasoning=${this.options.reasoning}`);
    if (this.options?.providerId) entry.push(`provider=${this.options.providerId}`);
    if (this.options?.useSession) entry.push("单轮也使用真实 session");
    return {
      kind: this.kind,
      label: live ? "Live runtime（真实模型 + 真实工具 + 内存库）" : "API runtime（HTTP+Worker+内存库+脚本模型）",
      realModel: live,
      durableStore: false,
      networkTools: live && !this.options?.offlineTools,
      supportsBusinessFacts: true,
      model,
      notes: [
        live
          ? "真实 Provider/真实网络工具；业务数据写内存库，不写云端数据库"
          : "完整 HTTP/JWT/Worker/状态机/事件/幂等/审批/执行期 Evaluator 契约；模型输出脚本回放，零真实网络",
        "多轮用例与人类聊天一致：创建真实 session、逐轮提交 task(sessionId,turnId)，Worker 注入历史/身份",
        ...(entry.length ? [`入口对齐：${entry.join("，")}`] : []),
        "每用例独立 owner id，数据互不污染；同一进程内串行/并发由多个 Worker 提供",
        "不覆盖浏览器 UI 交互；UI/视觉验收仍属独立 E2E 范围",
        ...(this.workerErrors.length ? [`Worker 运行期错误：${this.workerErrors.slice(0, 2).join("；")}`] : []),
      ],
    };
  }

  private modelInfo(): TargetDescription["model"] {
    if (this.mode !== "live") return { real: false, providerId: "scripted", modelId: "scripted-model" };
    const modelId = typeof this.envSnapshot.LLM_MODEL === "string" ? this.envSnapshot.LLM_MODEL.trim() : undefined;
    let baseUrlHost: string | undefined;
    try { baseUrlHost = this.envSnapshot.LLM_BASE_URL ? new URL(this.envSnapshot.LLM_BASE_URL).host : undefined; } catch { baseUrlHost = undefined; }
    return {
      real: true, providerId: this.options?.providerId ?? "builtin",
      ...(modelId ? { modelId } : {}),
      ...(this.envSnapshot.LLM_DISPLAY_NAME ? { displayName: this.envSnapshot.LLM_DISPLAY_NAME } : {}),
      ...(baseUrlHost ? { baseUrlHost } : {}),
    };
  }
}

// 供 CLI 复用：从 case 推导安全文件名。
export { safeCaseId };
