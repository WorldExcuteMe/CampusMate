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
import type { Budget } from "../core/types.ts";

export interface ApiDeps {
  store: TaskStore;
  jwtSecret: string;
  corsOrigin?: string;
  storeKind?: string;
  maxBodyBytes?: number;
  approvals?: ApprovalStore;
  capabilityRegistry?: CapabilityRegistry;
  companion?: CompanionRegistry;
  personalContext?: PersonalContextStore;
  opportunityStore?: OpportunityStore;
}

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

class ApiInputError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0, failed = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) { failed = true; chunks.length = 0; reject(new ApiInputError(413, "request_too_large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!failed) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
    req.on("aborted", () => reject(new ApiInputError(400, "request_aborted")));
  });
}
async function readObject(req: http.IncomingMessage, maxBytes: number): Promise<Record<string, any>> {
  let value: unknown;
  const raw = await readBody(req, maxBytes);
  try { value = JSON.parse(raw || "{}"); } catch { throw new ApiInputError(400, "invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiInputError(400, "invalid_request");
  return value as Record<string, any>;
}
function boundedBudget(value: unknown): Budget {
  const budget = { ...DEFAULT_BUDGET };
  if (value === undefined) return budget;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiInputError(400, "invalid_budget");
  for (const key of Object.keys(budget) as (keyof Budget)[]) {
    const limit = (value as Record<string, unknown>)[key];
    if (limit === undefined) continue;
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) throw new ApiInputError(400, "invalid_budget");
    budget[key] = Math.min(limit, budget[key]);
  }
  return budget;
}

export function createApiServer(deps: ApiDeps): http.Server {
  const { store, jwtSecret } = deps;
  const cors = deps.corsOrigin ?? "*";
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/v1/health") {
        return json(res, 200, { ok: true, store: deps.storeKind ?? "memory" });
      }

      // 以下端点需 JWT（SSE EventSource 无法设 header，支持 ?token= query）。
      const token = bearerToken(req.headers.authorization) ?? (req.method === "GET" && /^\/v1\/tasks\/[^/]+\/stream$/.test(path) ? url.searchParams.get("token") ?? "" : "");
      const claims = verifySupabaseJwt(token, jwtSecret);
      if (!claims) return json(res, 401, { error: "unauthorized" });
      const uid = claims.sub;

      if (req.method === "POST" && path === "/v1/tasks") {
        const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
        if (!body.title || typeof body.title !== "string") return json(res, 400, { error: "title required" });
        if (body.intent !== undefined && typeof body.intent !== "string") return json(res, 400, { error: "invalid_intent" });
        if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.sessionId))) {
          return json(res, 400, { error: "invalid_session_id" });
        }
        const images = Array.isArray(body.images) ? body.images.filter((x: unknown) => typeof x === "string").slice(0, 4) : undefined;
        const task = await store.createTask({
          userId: uid, title: body.title, intent: body.intent, sessionId: body.sessionId,
          images, priority: body.priority, budget: boundedBudget(body.budget),
        });
        return json(res, 201, { taskId: task.id, status: task.status });
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
          // SSE：实时推送任务事件 + 状态，终态关闭。JWT 经 query ?token= 或 Authorization。
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": cors });
          let seq = Number(url.searchParams.get("after") ?? 0);
          let closed = false;
          let ticking = false;
          let timer: ReturnType<typeof setInterval> | undefined;
          const cleanup = () => { closed = true; if (timer) clearInterval(timer); };
          res.once("close", cleanup);
          const send = (event: string, data: unknown) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
          const tick = async () => {
            if (closed || ticking) return;
            ticking = true;
            try {
              const evs = await store.listEvents(id, seq);
              if (closed) return;
              for (const e of evs) { send("task_event", e); seq = e.seq; }
              const t = await store.getTask(id);
              if (t) send("task_status", { id: t.id, status: t.status, usage: t.usage, result: t.result });
              if (t && ["succeeded", "failed", "cancelled", "needs_input", "paused"].includes(t.status)) {
                send("close", { status: t.status }); cleanup(); res.end();
              }
            } catch {
              send("stream_error", { error: "stream_unavailable" }); cleanup(); res.end();
            } finally { ticking = false; }
          };
          await tick();
          if (!closed) timer = setInterval(() => { void tick(); }, 1000);
          return;
        }
        if (req.method === "POST" && sub === "/cancel") {
          const ok = await store.requestCancel(id, uid);
          return json(res, 200, { ok });
        }
        if (req.method === "POST" && sub === "/resume") {
          if (!["needs_input", "paused", "failed"].includes(task.status)) return json(res, 409, { error: `cannot resume from ${task.status}` });
          const t = await store.updateTask(id, { status: "queued" });
          return json(res, 200, { task: t });
        }
      }

      // 个人上下文：学期 / 课表 / 导入（owner 隔离）
      if (deps.personalContext) {
        const pc = deps.personalContext;
        if (req.method === "GET" && path === "/v1/terms") return json(res, 200, { terms: await pc.listTerms(uid) });
        if (req.method === "POST" && path === "/v1/terms") {
          const b = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          const term = await pc.createTerm({ userId: uid, institutionId: b.institutionId ?? "", name: b.name ?? "学期", startDate: b.startDate, endDate: b.endDate, totalWeeks: b.totalWeeks ?? 20, timezone: b.timezone ?? "Asia/Shanghai" });
          return json(res, 201, { term });
        }
        if (req.method === "GET" && path === "/v1/schedules") {
          const termId = url.searchParams.get("termId") ?? "";
          return json(res, 200, { schedules: await pc.listSchedules(uid, termId), exceptions: await pc.listExceptions(uid, termId) });
        }
        if (req.method === "POST" && path === "/v1/schedules/import") {
          const b = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
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
          const b = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
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
        const b = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
        const wf = path.slice("/v1/workflows/".length);
        if (wf === "onboarding") {
          if (![b.university, b.major, b.grade].every((v) => typeof v === "string") || !b.term || !b.schedule || typeof b.schedule.data !== "string" || !["csv", "ics", "xlsx"].includes(b.schedule.format)) throw new ApiInputError(400, "invalid_onboarding");
          return json(res, 200, await onboarding(deps.personalContext, { ...b, userId: uid, university: b.university, major: b.major, grade: b.grade, term: b.term, schedule: b.schedule }));
        }
        if (wf === "inbox") {
          if (![b.title, b.rawText, b.category].every((v) => typeof v === "string")) throw new ApiInputError(400, "invalid_inbox");
          return json(res, 200, intelligentInbox({ ...b, userId: uid, title: b.title, rawText: b.rawText, category: b.category }));
        }
        if (wf === "opportunities") {
          if (!b.profile || !Array.isArray(b.profile.skills) || !Array.isArray(b.profile.interests) || !Array.isArray(b.opportunities)) throw new ApiInputError(400, "invalid_opportunities");
          return json(res, 200, opportunityDiscovery({ ...b, profile: b.profile, opportunities: b.opportunities }));
        }
        if (wf === "weekly-plan") {
          if (typeof b.goal !== "string" || !Array.isArray(b.schedules) || !Array.isArray(b.tasks) || !Number.isInteger(b.week) || b.week < 1) throw new ApiInputError(400, "invalid_weekly_plan");
          return json(res, 200, weeklyPlanning({ ...b, userId: uid, goal: b.goal, schedules: b.schedules, tasks: b.tasks, week: b.week }));
        }
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
          const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          if (body.decision !== "approved" && body.decision !== "rejected") return json(res, 400, { error: "decision must be approved|rejected" });
          const a = await deps.approvals.decide(apMatch[1], uid, body.decision);
          if (!a) return json(res, 404, { error: "approval not found or forbidden" });
          return json(res, 200, { approval: a });
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, err instanceof ApiInputError ? err.status : 500, { error: err instanceof ApiInputError ? err.message : "internal_error" });
    }
  });
}
