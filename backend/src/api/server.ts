// Backend API（Node http，零框架依赖）。JWT 校验 + owner 隔离 + CORS。
// 不在请求内跑 Agent Loop：提交即写 queued 返回 taskId，Worker 异步认领。
import http from "node:http";
import type { TaskStore } from "../runtime/store.ts";
import type { ApprovalStore } from "../runtime/approval.ts";
import type { CapabilityRegistry } from "../core/capability.ts";
import type { CompanionRegistry } from "../core/companion.ts";
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
        const task = await store.createTask({
          userId: uid, title: body.title, intent: body.intent, sessionId: body.sessionId,
          priority: body.priority, budget: body.budget as Budget | undefined,
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
            if (t && ["succeeded", "failed", "cancelled"].includes(t.status)) { send("close", { status: t.status }); closed = true; res.end(); return; }
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