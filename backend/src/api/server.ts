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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

      if (req.method === "POST" && path === "/v1/tasks") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.title || typeof body.title !== "string") return json(res, 400, { error: "title required" });
        const images = Array.isArray(body.images) ? body.images.filter((x: unknown) => typeof x === "string").slice(0, 4) : undefined;
        const task = await store.createTask({
          userId: uid, title: body.title, intent: body.intent, sessionId: body.sessionId,
          images, priority: body.priority, budget: body.budget as Budget | undefined,
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
          const send = (event: string, data: unknown) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
          const tick = async () => {
            if (closed) return;
            const evs = await store.listEvents(id, seq);
            for (const e of evs) { send("task_event", e); seq = e.seq; }
            const t = await store.getTask(id);
            if (t) send("task_status", { status: t.status, usage: t.usage, result: t.result });
            if (t && ["succeeded", "failed", "cancelled", "needs_input", "paused"].includes(t.status)) { send("close", { status: t.status }); closed = true; res.end(); return; }
          };
          await tick();
          const timer = setInterval(() => { void tick(); }, 1000);
          req.on("close", () => { closed = true; clearInterval(timer); });
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
      return json(res, 500, { error: errorMessage(err) });
    }
  });
}