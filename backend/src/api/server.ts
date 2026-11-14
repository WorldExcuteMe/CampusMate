// Backend API（Node http，零框架依赖）。JWT 校验 + owner 隔离 + CORS。
// 不在请求内跑 Agent Loop：提交即写 queued 返回 taskId，Worker 异步认领。
import http from "node:http";
import type { TaskStore } from "../runtime/store.ts";
import type { ApprovalStore } from "../runtime/approval.ts";
import type { CapabilityRegistry } from "../core/capability.ts";
import type { CompanionRegistry } from "../core/companion.ts";
import type { PersonalContextStore } from "../core/personal-context.ts";
import type { OpportunityStore } from "../core/opportunity-store.ts";
import { previewImport } from "../core/schedule-import.ts";
import { onboarding, intelligentInbox, opportunityDiscovery, weeklyPlanning } from "../core/workflows.ts";
import { buildManifest } from "../core/manifest.ts";
import { DEFAULT_BUDGET } from "../core/types.ts";
import { verifySupabaseJwt, bearerToken } from "./jwt.ts";
import { errorMessage } from "../core/errors.ts";
import type { Budget } from "../core/types.ts";
import type { SessionStore } from "../core/storage-contracts.ts";
import { SessionConflict } from "../runtime/store.ts";
import { randomUUID } from "node:crypto";
import { requireUuid } from "../runtime/postgres-shared.ts";
import { ProviderService, ProviderError } from "../core/providers.ts";
import { parseBudget } from "../core/budget.ts";

export interface ApiDeps {
  store: TaskStore;
  jwtSecret: string;
  corsOrigin?: string;
  storeKind?: string;
  approvals?: ApprovalStore;
  capabilityRegistry?: CapabilityRegistry;
  companion?: CompanionRegistry;
  personalContext?: PersonalContextStore;
  opportunityStore?: OpportunityStore;
  sessionStore?: SessionStore;
  providers?: ProviderService;
}


function taskView(task: import("../core/types.ts").Task) {
  const { id, userId, title, sessionId, turnId, turnSeq, status, usage, budget, result, error, promptUsage, modelConfig, modelRuntime, cancelRequested, createdAt, updatedAt } = task;
  return { id, userId, title, sessionId, turnId, turnSeq, status, usage, budget, result, error, promptUsage, modelConfig, modelRuntime, cancelRequested, createdAt, updatedAt };
}

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

export function createApiServer(deps: ApiDeps): http.Server {
  const { store, jwtSecret } = deps;
  const cors = deps.corsOrigin ?? "*";
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/v1/health") {
        return json(res, 200, { ok: true, store: deps.storeKind ?? "memory" });
      }

      // 以下端点需 JWT（SSE EventSource 无法设 header，支持 ?token= query）。
      const token = bearerToken(req.headers.authorization) ?? url.searchParams.get("token") ?? "";
      const claims = verifySupabaseJwt(token, jwtSecret);
      if (!claims) return json(res, 401, { error: "unauthorized" });
      const uid = claims.sub;

      if (deps.providers) {
        if (path === "/v1/providers" && req.method === "GET") return json(res, 200, { providers: await deps.providers.list(uid) });
        if (path === "/v1/providers" && req.method === "POST") return json(res, 200, { provider: await deps.providers.save(uid, JSON.parse((await readBody(req)) || "{}")) });
        const providerMatch = path.match(/^\/v1\/providers\/([a-z0-9_-]+)(\/(test|default))?$/i);
        if (providerMatch) {
          const id = providerMatch[1];
          if (req.method === "DELETE" && !providerMatch[2]) return json(res, 200, { ok: await deps.providers.remove(uid, id) });
          if (req.method === "POST" && providerMatch[3] === "test") return json(res, 200, await deps.providers.test(uid, id));
          if (req.method === "POST" && providerMatch[3] === "default") { await deps.providers.setDefault(uid, id); return json(res, 200, { ok: true }); }
        }
      }

      if (deps.sessionStore) {
        const sessions = deps.sessionStore;
        if (req.method === "POST" && path === "/v1/sessions") {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (body.id !== undefined) requireUuid(body.id);
          const session = await sessions.create({ userId: uid, id: body.id, title: typeof body.title === "string" ? body.title.slice(0, 160) : undefined, mode: body.mode === "daily" ? "daily" : "auto" });
          return json(res, 201, { session });
        }
        if (req.method === "GET" && path === "/v1/sessions") return json(res, 200, { sessions: await sessions.list(uid) });
        const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)\/(messages|tasks)$/);
        if (req.method === "GET" && sessionMatch) {
          requireUuid(sessionMatch[1]);
          if (!await sessions.get(uid, sessionMatch[1])) return json(res, 404, { error: "session not found" });
          if (sessionMatch[2] === "tasks") return json(res, 200, { tasks: (await store.listTasksByUser(uid)).filter((t) => t.sessionId === sessionMatch[1]).sort((a, b) => (b.turnSeq ?? 0) - (a.turnSeq ?? 0) || b.createdAt - a.createdAt).slice(0, 40).map(taskView) });
          const after = Number(url.searchParams.get("afterSeq") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) return json(res, 400, { error: "invalid afterSeq" });
          return json(res, 200, { messages: await sessions.listMessages(uid, sessionMatch[1], after) });
        }
      }

      if (req.method === "POST" && path === "/v1/tasks") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.title || typeof body.title !== "string") return json(res, 400, { error: "title required" });
        if (body.sessionId !== undefined) {
          requireUuid(body.sessionId);
          if (!deps.sessionStore || !await deps.sessionStore.get(uid, body.sessionId)) return json(res, 404, { error: "session not found" });
        }
        if (body.turnId !== undefined) requireUuid(body.turnId);
        if (body.providerId !== undefined && typeof body.providerId !== "string") return json(res, 400, { error: "providerId must be a string" });
        const prior = body.sessionId && body.turnId ? (await store.listTasksByUser(uid)).find((t) => t.sessionId === body.sessionId && t.turnId === body.turnId) : undefined;
        const requestedProvider = body.providerId === "builtin-deepseek" ? "builtin" : body.providerId;
        const sameSelection = prior && (!requestedProvider || prior.modelConfig?.providerId === requestedProvider);
        const selectedConfig = sameSelection ? prior.modelConfig : deps.providers && (requestedProvider !== undefined || (await deps.providers.list(uid)).length > 0) ? await deps.providers.snapshot(uid, requestedProvider) : undefined;
        const modelConfig = selectedConfig ? structuredClone(selectedConfig) : undefined;
        if (body.reasoning !== undefined && !["auto", "low", "medium", "high"].includes(body.reasoning)) return json(res, 400, { error: "reasoning must be auto|low|medium|high" });
        if (modelConfig && (!sameSelection || body.reasoning !== undefined)) modelConfig.reasoningPreference = body.reasoning ?? "auto";
        const images = Array.isArray(body.images) ? body.images.filter((x: unknown) => typeof x === "string").slice(0, 4) : undefined;
        const input = {
          userId: uid, title: body.title, intent: body.intent, sessionId: body.sessionId,
          images, priority: body.priority, budget: body.budget === undefined ? undefined : parseBudget(body.budget, DEFAULT_BUDGET),
          modelConfig,
        };
        const accepted = body.sessionId && deps.sessionStore && store.createSessionTask
          ? await store.createSessionTask({ ...input, sessionId: body.sessionId, turnId: body.turnId ?? randomUUID() }, deps.sessionStore)
          : { task: await store.createTask(input), deduped: false };
        return json(res, 201, { taskId: accepted.task.id, sessionId: accepted.task.sessionId, turnId: accepted.task.turnId, status: accepted.task.status, deduped: accepted.deduped });
      }

      const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)(\/events|\/cancel|\/resume|\/stream)?$/);
      if (taskMatch) {
        const id = taskMatch[1];
        const sub = taskMatch[2];
        const task = await store.getTask(id);
        if (!task) return json(res, 404, { error: "task not found" });
        if (task.userId !== uid) return json(res, 403, { error: "forbidden" }); // 跨用户隔离

        if (req.method === "GET" && !sub) return json(res, 200, { task });
        if (req.method === "GET" && sub === "/events") {
          const after = Number(url.searchParams.get("after") ?? 0);
          return json(res, 200, { events: await store.listEvents(id, after) });
        }
        if (req.method === "GET" && sub === "/stream") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": cors });
          const cursor = Math.max(Number(url.searchParams.get("after") ?? 0), Number(req.headers["last-event-id"] ?? 0));
          let seq = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
          let closed = false, lastStatus = "", timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => { closed = true; if (timer) clearTimeout(timer); };
          res.on("close", cleanup); req.on("aborted", cleanup);
          const send = (event: string, data: unknown, id?: number) => { if (!closed) res.write((id === undefined ? "" : "id: " + id + "\n") + "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n"); };
          const tick = async () => {
            if (closed) return;
            try {
              const events = await store.listEvents(id, seq);
              for (const event of events) { send("task_event", event, event.seq); seq = event.seq; }
              const current = await store.getTask(id);
              if (!current) { cleanup(); res.end(); return; }
              const snapshot = JSON.stringify(taskView(current));
              if (snapshot !== lastStatus) { send("task_status", taskView(current)); lastStatus = snapshot; }
              if (["succeeded", "failed", "cancelled", "needs_input", "paused"].includes(current.status)) {
                for (const event of await store.listEvents(id, seq)) { send("task_event", event, event.seq); seq = event.seq; }
                send("close", { status: current.status }); cleanup(); res.end(); return;
              }
              if (!closed) timer = setTimeout(() => { void tick(); }, 1000);
            } catch { send("stream_error", { error: "事件暂不可用，请重新连接" }); cleanup(); res.end(); }
          };
          await tick();
          return;
        }
        if (req.method === "POST" && sub === "/cancel") {
          const ok = await store.requestCancel(id, uid);
          return json(res, 200, { ok });
        }
        if (req.method === "POST" && sub === "/resume") {
          if (!["needs_input", "paused", "failed"].includes(task.status)) return json(res, 409, { error: `cannot resume from ${task.status}` });
          const body = JSON.parse((await readBody(req)) || "{}");
          if (task.result?.completion?.reason === "budget_exceeded" && !body.budget) return json(res, 409, { error: "请先调整任务预算，再恢复继续" });
          const budget = body.budget ? parseBudget(body.budget, task.budget) : undefined;
          const t = store.resumeSessionTask ? await store.resumeSessionTask(id, uid, budget) : await store.updateTask(id, { status: "queued", ...(budget ? { budget } : {}) });
          return json(res, 200, { task: t });
        }
      }

      // 个人上下文：学期 / 课表 / 导入（owner 隔离）
      if (deps.personalContext) {
        const pc = deps.personalContext;
        if (req.method === "GET" && path === "/v1/terms") return json(res, 200, { terms: await pc.listTerms(uid) });
        if (req.method === "POST" && path === "/v1/terms") {
          const b = JSON.parse((await readBody(req)) || "{}");
          const term = await pc.createTerm({ userId: uid, institutionId: b.institutionId ?? "", name: b.name ?? "学期", startDate: b.startDate, endDate: b.endDate, totalWeeks: b.totalWeeks ?? 20, timezone: b.timezone ?? "Asia/Shanghai" });
          return json(res, 201, { term });
        }
        if (req.method === "GET" && path === "/v1/schedules") {
          const termId = url.searchParams.get("termId") ?? "";
          return json(res, 200, { schedules: await pc.listSchedules(uid, termId), exceptions: await pc.listExceptions(uid, termId) });
        }
        if (req.method === "POST" && path === "/v1/schedules/import") {
          const b = JSON.parse((await readBody(req)) || "{}");
          const preview = previewImport(b.format ?? "csv", b.data ?? "", b.termStart ?? "2026-09-01", b.totalWeeks ?? 20);
          if (b.confirm && b.termId) {
            const saved = await pc.saveSchedules(uid, b.termId, preview.schedules.map((s) => ({ ...s, courseId: "" })));
            return json(res, 200, { confirmed: true, saved: saved.length, preview });
          }
          return json(res, 200, { confirmed: false, preview });
        }
      }

      // 机会雷达（owner 隔离）：Agent 经 save_opportunity 写入，前端 Radar 读取。
      if (deps.opportunityStore) {
        const os = deps.opportunityStore;
        if (req.method === "GET" && path === "/v1/opportunities") return json(res, 200, { opportunities: await os.listByUser(uid) });
        if (req.method === "POST" && path === "/v1/opportunities") {
          const b = JSON.parse((await readBody(req)) || "{}");
          if (!b.title) return json(res, 400, { error: "title required" });
          const rec = await os.create({ userId: uid, title: String(b.title), type: b.type, organizer: b.organizer, description: b.description, conditions: b.conditions, deadline: b.deadline ?? null, sourceUrl: b.sourceUrl, sourceType: b.sourceType });
          return json(res, 201, { opportunity: rec });
        }
        const oppMatch = path.match(/^\/v1\/opportunities\/([^/]+)$/);
        if (req.method === "GET" && oppMatch) {
          const rec = await os.get(uid, oppMatch[1]);
          return rec ? json(res, 200, { opportunity: rec }) : json(res, 404, { error: "not found" });
        }
      }

      // 个性化工作流（owner 隔离）
      if (deps.personalContext && req.method === "POST" && path.startsWith("/v1/workflows/")) {
        const b = JSON.parse((await readBody(req)) || "{}");
        const wf = path.slice("/v1/workflows/".length);
        if (wf === "onboarding") return json(res, 200, await onboarding(deps.personalContext, { ...b, userId: uid }));
        if (wf === "inbox") return json(res, 200, intelligentInbox({ ...b, userId: uid }));
        if (wf === "opportunities") return json(res, 200, opportunityDiscovery(b));
        if (wf === "weekly-plan") return json(res, 200, weeklyPlanning({ ...b, userId: uid }));
        return json(res, 404, { error: `unknown workflow ${wf}` });
      }

      // 能力 Manifest（owner）：当前用户可用能力 + 健康。
      if (req.method === "GET" && path === "/v1/capabilities" && deps.capabilityRegistry) {
        const manifest = buildManifest({ registry: deps.capabilityRegistry, companion: deps.companion, userId: uid, taskId: "preview", budget: DEFAULT_BUDGET });
        return json(res, 200, { manifest });
      }

      // 审批：列表（owner）+ 决策（owner）
      if (deps.approvals) {
        if (req.method === "GET" && path === "/v1/approvals") {
          return json(res, 200, { approvals: await deps.approvals.listPendingByUser(uid) });
        }
        const apMatch = path.match(/^\/v1\/approvals\/([^/]+)$/);
        if (req.method === "POST" && apMatch) {
          const body = JSON.parse((await readBody(req)) || "{}");
          if (body.decision !== "approved" && body.decision !== "rejected") return json(res, 400, { error: "decision must be approved|rejected" });
          const a = await deps.approvals.decide(apMatch[1], uid, body.decision);
          if (!a) return json(res, 404, { error: "approval not found or forbidden" });
          return json(res, 200, { approval: a });
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof ProviderError) return json(res, err.status, { error: err.message });
      if (err instanceof SessionConflict) return json(res, 409, { error: err.message });
      if (err instanceof SyntaxError || (err instanceof Error && err.message === "Invalid UUID")) return json(res, 400, { error: "invalid input" });
      if (err instanceof Error && /预算.*(范围|对象)/.test(err.message)) return json(res, 400, { error: err.message });
      if (err instanceof Error && err.message === "Session owner forbidden") return json(res, 403, { error: "forbidden" });
      return json(res, 500, { error: errorMessage(err) });
    }
  });
}
