// Backend API（Node http，零框架依赖）。JWT 校验 + owner 隔离 + CORS。
// 不在请求内跑 Agent Loop：提交即写 queued 返回 taskId，Worker 异步认领。
import http from "node:http";
import { SessionManagementError, publicConversation, validateLegacyMessages } from '../core/session-management.ts';
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR } from '../../../shared/tool-protocol.ts';
import { imageLimitError } from '../../../shared/attachments.ts';
import { SessionFeed } from '../runtime/session-feed.ts';
import type { TaskStore } from "../runtime/store.ts";
import type { ApprovalStore } from "../runtime/approval.ts";
import type { CapabilityRegistry } from "../core/capability.ts";
import type { CompanionRegistry } from "../core/companion.ts";
import type { PersonalContextStore } from "../core/personal-context.ts";
import type { OpportunityStore } from "../core/opportunity-store.ts";
import { previewImport, detectConflicts } from "../core/schedule-import.ts";
import { validDate, validTime, validateTerm, validateScheme, scheduleKey, weekday, teachingWeek, occursInWeek } from "../../../shared/calendar.ts";
import { onboarding, intelligentInbox, opportunityDiscovery, weeklyPlanning } from "../core/workflows.ts";
import { buildManifest } from "../core/manifest.ts";
import { DEFAULT_BUDGET } from "../core/types.ts";
import { verifySupabaseJwt, bearerToken } from "./jwt.ts";
import { errorMessage } from "../core/errors.ts";
import type { Budget } from "../core/types.ts";
import type { SessionStore, ArtifactStore } from "../core/storage-contracts.ts";
import { SessionConflict } from "../runtime/store.ts";
import { randomUUID } from "node:crypto";
import { documentErrors, type DocumentAst } from "../../../shared/document.ts";
import { requireUuid } from "../runtime/postgres-shared.ts";
import { ProviderService, ProviderError } from "../core/providers.ts";
import { parseBudget } from "../core/budget.ts";
import { DocumentService } from "../core/document-service.ts";
import { DocumentRenderUnavailable, type DocumentFormat } from "../core/document-renderer.ts";

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
  sessionStore?: SessionStore;
  sessionFeed?: SessionFeed;
  providers?: ProviderService;
  artifactStore?: ArtifactStore;
  documents?: DocumentService;
}


function taskView(task: import("../core/types.ts").Task) {
  // Historical false-success records remain unchanged for audit, but must not be
  // presented as completed or re-executed automatically by clients.
  if (hasRawToolMarkup(task.result?.summary ?? '')) task = { ...task, status: 'failed', error: TOOL_PROTOCOL_ERROR, result: { ...task.result!, summary: TOOL_PROTOCOL_ERROR, partial: true, completion: { state: 'partial', reason: 'tool_protocol_error' } } };
  const { id, userId, title, sessionId, turnId, turnSeq, status, usage, budget, result, error, promptUsage, modelConfig, modelRuntime, cancelRequested, createdAt, updatedAt } = task;
  return { id, userId, title, sessionId, turnId, turnSeq, status, usage, budget, result, error, promptUsage, modelConfig, modelRuntime, cancelRequested, createdAt, updatedAt, historyRevision: task.historyRevision };
}

function json(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

class ApiInputError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status=status; } }
async function readObject(req: http.IncomingMessage, maxBytes: number): Promise<Record<string, any>> {
  const raw = await new Promise<string>((resolve,reject)=>{
    let size=0,failed=false;const chunks:Buffer[]=[];
    req.on("data",(chunk:Buffer)=>{if(failed)return;size+=chunk.length;if(size>maxBytes){failed=true;chunks.length=0;reject(new ApiInputError(413,"request_too_large"));return;}chunks.push(chunk);});
    req.on("end",()=>{if(!failed)resolve(Buffer.concat(chunks).toString("utf8"));});req.on("error",reject);req.on("aborted",()=>reject(new ApiInputError(400,"request_aborted")));
  });
  let value:unknown;try{value=JSON.parse(raw||"{}");}catch{throw new ApiInputError(400,"invalid_json");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new ApiInputError(400,"invalid_request");return value as Record<string,any>;
}
function boundedInitialBudget(value: unknown): Budget {
  if(!value || typeof value !== "object" || Array.isArray(value)) throw new ApiInputError(400,"invalid_budget");
  const normalized:Record<string,number>={};
  for(const key of Object.keys(DEFAULT_BUDGET) as (keyof Budget)[]){const n=(value as Record<string,unknown>)[key];if(n===undefined)continue;if(typeof n!=="number"||!Number.isFinite(n)||n<=0)throw new ApiInputError(400,"invalid_budget");normalized[key]=Math.min(n,DEFAULT_BUDGET[key]);}
  return parseBudget(normalized,DEFAULT_BUDGET);
}
export function createApiServer(deps: ApiDeps): http.Server {
  const { store, jwtSecret } = deps;
  const sessionFeed = deps.sessionFeed ?? (deps.sessionStore ? new SessionFeed(deps.sessionStore,store) : undefined);
  const sessionTasks = (owner: string, id: string, limit?: number) => store.listTasksBySession ? store.listTasksBySession(owner,id,limit) : store.listTasksByUser(owner).then(rows=>rows.filter(t=>t.sessionId===id).sort((a,b)=>b.createdAt-a.createdAt).slice(0,limit));
  const documents = deps.documents ?? (deps.artifactStore ? new DocumentService(deps.artifactStore) : undefined);
  const cors = deps.corsOrigin ?? "*";
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", cors);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Owner");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
      if (path.startsWith('/v1/sessions') && req.headers['x-session-owner'] && req.headers['x-session-owner'] !== uid) return json(res, 403, { error: '会话身份已切换，请重新操作' });

      if (deps.providers) {
        if (path === "/v1/providers" && req.method === "GET") return json(res, 200, { providers: await deps.providers.list(uid) });
        if (path === "/v1/providers" && req.method === "POST") return json(res, 200, { provider: await deps.providers.save(uid, await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024)) });
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
        const feedMatch = path.match(/^\/v1\/sessions\/([^/]+)\/history\/(page|changes)$/);
        if (feedMatch && req.method==='GET') {
          const id=feedMatch[1]; requireUuid(id);
          if (feedMatch[2]==='changes' && !url.searchParams.has('after')) return json(res,400,{error:'增量同步缺少after游标'});
          if (feedMatch[2]==='page' && (url.searchParams.has('after') || url.searchParams.has('next'))) return json(res,400,{error:'分页参数无效'});
          const page=await sessionFeed!.read(uid,id,Object.fromEntries(['limit','before','after','next'].filter(k=>url.searchParams.has(k)).map(k=>[k,url.searchParams.get(k)!])));
          const parent=await sessions.get(uid,id);if(!parent || parent.deletedAt)return json(res,404,{error:'会话不存在或已删除'});
          return json(res,200,{...page,session:parent,items:page.items.map(item=>({...item,task:item.task?taskView(item.task):undefined}))});
        }
        if (req.method === "POST" && path === "/v1/sessions") {
          const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          if (body.id !== undefined) requireUuid(body.id);
          const session = await sessions.create({ userId: uid, id: body.id, title: typeof body.title === "string" ? body.title.slice(0, 160) : undefined, mode: body.mode === "daily" ? "daily" : "auto" });
          return json(res, 201, { session });
        }
        if (req.method === "GET" && path === "/v1/sessions") return json(res, 200, { sessions: await sessions.list(uid) });
        const manageMatch = path.match(/^\/v1\/sessions\/([^/]+)(\/(history|import))?$/);
        if (manageMatch) {
          const id = manageMatch[1]; requireUuid(id);
          if (!manageMatch[2] && req.method === 'PATCH') { const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024); return json(res, 200, { session: await sessions.patch(uid, id, { expectedRevision: body.expectedRevision, ...(body.title !== undefined ? { title: body.title } : {}), ...(body.mode !== undefined ? { mode: body.mode } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) }) }); }
          if (!manageMatch[2] && req.method === 'DELETE') { const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024); return json(res, 200, { session: await sessions.remove(uid, id, body.expectedRevision) }); }
          if (manageMatch[3] === 'import' && req.method === 'POST') { const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024); await sessions.importLegacy(uid, id, validateLegacyMessages(body.messages)); return json(res, 200, { ok: true }); }
          if (manageMatch[3] === 'history' && req.method === 'GET') {
            const parent = await sessions.get(uid, id); if (!parent || parent.deletedAt) return json(res, 404, { error: 'session not found' });
            const tasks = (await sessionTasks(uid,id)).sort((a, b) => (a.turnSeq ?? 0) - (b.turnSeq ?? 0) || a.createdAt - b.createdAt);
            return json(res, 200, { session: parent, messages: publicConversation(tasks, await sessions.listMessages(uid, id), await sessions.legacyHistory(uid, id)), tasks: tasks.map(taskView) });
          }
        }
        const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)\/(messages|tasks)$/);
        if (req.method === "GET" && sessionMatch) {
          requireUuid(sessionMatch[1]);
          const parent = await sessions.get(uid, sessionMatch[1]); if (!parent || parent.deletedAt) return json(res, 404, { error: "session not found" });
          if (sessionMatch[2] === "tasks") return json(res, 200, { tasks: (await sessionTasks(uid,sessionMatch[1],40)).map(taskView) });
          const after = Number(url.searchParams.get("afterSeq") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) return json(res, 400, { error: "invalid afterSeq" });
          // Opaque model continuation stays on the server, not in browser history.
          return json(res, 200, { messages: (await sessions.listMessages(uid, sessionMatch[1], after)).map(({ reasoning_content: _privateReasoning, reasoning_source: _providerScope, ...message }) => message) });
        }
      }

      if (req.method === "POST" && path === "/v1/tasks") {
        const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
        if (!body.title || typeof body.title !== "string") return json(res, 400, { error: "title required" });
        if (body.intent !== undefined && typeof body.intent !== "string") return json(res, 400, { error: "invalid_intent" });
        // Validate before provider lookup/task creation: accepting a prefix would
        // make the saved turn differ from the user's submitted attachments.
        if (body.images !== undefined && (!Array.isArray(body.images) || body.images.some((image: unknown) => typeof image !== 'string' || !image.trim()))) return json(res, 400, { error: '图片列表格式无效，请重新添加图片；不会忽略无效附件。' });
        const images: string[] | undefined = body.images;
        const imageError = imageLimitError(images?.length ?? 0);
        if (imageError) return json(res, 400, { error: imageError });
        if (body.sessionId !== undefined) {
          requireUuid(body.sessionId);
          if (deps.sessionStore) { const parent = await deps.sessionStore.get(uid, body.sessionId); if (!parent || parent.deletedAt) return json(res, 404, { error: "session not found" }); }
        }
        if (body.turnId !== undefined) requireUuid(body.turnId);
        if (body.providerId !== undefined && typeof body.providerId !== "string") return json(res, 400, { error: "providerId must be a string" });
        const prior = body.sessionId && body.turnId ? store.findSessionTurn ? await store.findSessionTurn(uid,body.sessionId,body.turnId) : (await sessionTasks(uid,body.sessionId)).find(t=>t.turnId===body.turnId) : undefined;
        const requestedProvider = body.providerId === "builtin-deepseek" ? "builtin" : body.providerId;
        const sameSelection = prior && (!requestedProvider || prior.modelConfig?.providerId === requestedProvider);
        const selectedConfig = sameSelection ? prior.modelConfig : deps.providers && (requestedProvider !== undefined || (await deps.providers.list(uid)).length > 0) ? await deps.providers.snapshot(uid, requestedProvider) : undefined;
        const modelConfig = selectedConfig ? structuredClone(selectedConfig) : undefined;
        if (body.reasoning !== undefined && !["auto", "low", "medium", "high"].includes(body.reasoning)) return json(res, 400, { error: "reasoning must be auto|low|medium|high" });
        if (modelConfig && (!sameSelection || body.reasoning !== undefined)) modelConfig.reasoningPreference = body.reasoning ?? "auto";
        const input = {
          userId: uid, title: body.title, intent: body.intent, sessionId: body.sessionId,
          images, priority: body.priority, budget: body.budget === undefined ? undefined : boundedInitialBudget(body.budget),
          modelConfig,
        };
        const accepted = body.sessionId && deps.sessionStore && store.createSessionTask
          ? await store.createSessionTask({ ...input, sessionId: body.sessionId, turnId: body.turnId ?? randomUUID() }, deps.sessionStore)
          : { task: await store.createTask(input), deduped: false };
        return json(res, 201, { taskId: accepted.task.id, sessionId: accepted.task.sessionId, turnId: accepted.task.turnId, status: accepted.task.status, deduped: accepted.deduped });
      }

      const artifactMatch = path.match(/^\/v1\/artifacts\/([^/]+)(\/download)?$/);
      if (req.method === "GET" && artifactMatch && deps.artifactStore) {
        const artifact = await deps.artifactStore.get(uid, artifactMatch[1]);
        if (!artifact) return json(res, 404, { error: "产物不存在" });
        if (!artifactMatch[2]) return json(res, 200, { artifact, availableFormats: artifact.kind === "document" ? documents!.formats(artifact.inline as DocumentAst) : [] });
        if (artifact.kind !== "document" || documentErrors(artifact.inline).length) return json(res, 422, { error: "文档格式无效，无法导出" });
        const format = (url.searchParams.get("format") ?? "md") as DocumentFormat;
        if (!["md", "docx", "pdf"].includes(format)) return json(res, 400, { error: "支持MD、DOCX或PDF" });
        const exported = await documents!.export(uid, artifact.id, format), file = documents!.file(exported), content = file.bytes;
        const filename = (artifact.inline as DocumentAst).title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").slice(0, 100) + "." + format;
        res.writeHead(200, { "Content-Type": file.mime, "Content-Disposition": `attachment; filename="campusmate-document.${format}"; filename*=UTF-8''${encodeURIComponent(filename)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "X-Artifact-Sha256": artifact.sha256, "X-File-Sha256": file.sha256, "X-Document-Revision": String(artifact.revision), "Access-Control-Expose-Headers": "Content-Disposition, X-Artifact-Sha256, X-File-Sha256, X-Document-Revision" });
        res.end(content); return;
      }
      const artifactList = path.match(/^\/v1\/tasks\/([^/]+)\/artifacts$/);
      if (req.method === "GET" && artifactList && deps.artifactStore) { const task = await store.getTask(artifactList[1]); if (!task || task.userId !== uid) return json(res, 404, { error: "任务不存在" }); return json(res, 200, { artifacts: (await deps.artifactStore.listByTask(uid, task.id)).map(({ inline: _inline, ...metadata }) => metadata) }); }

      const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)(\/events|\/cancel|\/resume|\/stream)?$/);
      if (taskMatch) {
        const id = taskMatch[1];
        const sub = taskMatch[2];
        const task = await store.getTask(id, { includeImages: false });
        if (!task) return json(res, 404, { error: "task not found" });
        if (task.userId !== uid) return json(res, 403, { error: "forbidden" }); // 跨用户隔离

        if (req.method === "GET" && !sub) return json(res, 200, { task: taskView(task) });
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
              const current = await store.getTask(id, { includeImages: false });
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
          const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
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
          const b: any = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          const input = { userId: uid, institutionId: String(b.institutionId ?? ""), name: String(b.name ?? "学期"), startDate: b.startDate, endDate: b.endDate, totalWeeks: b.totalWeeks ?? 20, timezone: b.timezone ?? "Asia/Shanghai", weekAnchor: b.weekAnchor || undefined };
          try { validateTerm(input); } catch (e) { return json(res, 400, { error: errorMessage(e) }); }
          const term = await pc.createTerm(input);
          return json(res, 201, { term });
        }
        if (req.method === "GET" && path === "/v1/schedules") {
          const termId = url.searchParams.get("termId") ?? "";
          if (!(await pc.listTerms(uid)).some((t) => t.id === termId)) return json(res, 404, { error: "学期不存在" });
          return json(res, 200, { schedules: await pc.listSchedules(uid, termId), exceptions: await pc.listExceptions(uid, termId), schemes: await pc.listTimeSchemes(uid, termId) });
        }
        if (req.method === "POST" && path === "/v1/schedules/exceptions") {
          const b: any = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          const term = (await pc.listTerms(uid)).find((t) => t.id === b.termId);
          if (!term) return json(res, 404, { error: "学期不存在" });
          if (!validDate(b.date) || b.date < term.startDate || b.date > term.endDate || !["reschedule", "makeup", "cancel", "holiday", "room_change"].includes(b.kind)) return json(res, 400, { error: "例外类型或日期无效" });
          if (b.kind !== "holiday" && !(await pc.listSchedules(uid, term.id)).some((s) => s.id === b.scheduleId)) return json(res, 400, { error: "请选择本学期课程" });
          if (b.kind === "reschedule" && (!validDate(b.sourceDate) || b.sourceDate < term.startDate || b.sourceDate > term.endDate)) return json(res, 400, { error: "调课须指定有效源日期，date表示目标日期" });
          if (b.kind === "reschedule") { const source = (await pc.listSchedules(uid, term.id)).find((s) => s.id === b.scheduleId)!; if (source.weekday !== weekday(b.sourceDate) || !occursInWeek(source, teachingWeek(term, b.sourceDate))) return json(res, 400, { error: "源日期不在该课程正常上课规则内，请核对教学周" }); }
          if ((b.startTime || b.endTime) && (!validTime(b.startTime) || !validTime(b.endTime) || b.endTime <= b.startTime)) return json(res, 400, { error: "例外起止时间无效" });
          const exception = await pc.addException({ userId: uid, termId: term.id, scheduleId: b.scheduleId, kind: b.kind, date: b.date, sourceDate: b.sourceDate, startTime: b.startTime, endTime: b.endTime, classroom: b.classroom, note: b.note });
          return json(res, 201, { exception });
        }
        if (req.method === "POST" && path === "/v1/timetable-schemes") {
          const b: any = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          const term = (await pc.listTerms(uid)).find((t) => t.id === b.termId);
          if (!term) return json(res, 404, { error: "学期不存在" });
          const input = { userId: uid, termId: term.id, institutionId: term.institutionId, campus: String(b.campus ?? ""), name: String(b.name ?? ""), effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo, periods: b.periods };
          try { validateScheme(input); } catch (e) { return json(res, 400, { error: errorMessage(e) }); }
          return json(res, 201, { scheme: await pc.saveTimeScheme(input) });
        }
        if (req.method === "POST" && path === "/v1/schedules/import") {
          const b: any = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          if (b.confirm === true) {
            if (typeof b.jobId !== "string") return json(res, 400, { error: "请先上传并预览，再确认jobId" });
            const job = await pc.getImportJob(uid, b.jobId);
            if (!job) return json(res, 404, { error: "导入预览不存在" });
            if (!job.preview?.schedules.length || (job.errorCount && b.allowPartial !== true)) return json(res, 422, { error: "请修复错误，或明确选择仅导入有效行" });
            const saved = await pc.confirmImportJob(uid, job.id, b.allowPartial === true);
            return json(res, 200, { confirmed: true, saved: saved.length, preview: job.preview, jobId: job.id });
          }
          const term = (await pc.listTerms(uid)).find((t) => t.id === b.termId);
          if (!term) return json(res, 404, { error: "请先创建或选择学期" });
          if (!["csv", "ics", "xlsx"].includes(b.format) || typeof b.data !== "string" || b.data.length > 3000000) return json(res, 400, { error: "支持不超过2MB的CSV/ICS/XLSX文件" });
          if (b.format === "xlsx" && (b.encoding !== "base64" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data))) return json(res, 400, { error: "XLSX须使用base64编码" });
          const data = b.format === "xlsx" ? Buffer.from(b.data, "base64") : b.data;
          const preview = previewImport(b.format, data, term.startDate, term.totalWeeks, term.timezone);
          const existing = await pc.listSchedules(uid, term.id);
          const existingKeys = new Set(existing.map(scheduleKey));
          const fresh = preview.schedules.filter((s) => !existingKeys.has(scheduleKey(s)));
          preview.duplicates += preview.schedules.length - fresh.length; preview.schedules = fresh;
          preview.conflicts = detectConflicts([...preview.schedules, ...existing]).filter((c) => preview.schedules.includes(c.a) || preview.schedules.includes(c.b));
          const job = await pc.createImportJob({ userId: uid, termId: term.id, format: b.format, status: "previewed", sourceName: String(b.sourceName ?? "课表").slice(0, 200), previewCount: preview.schedules.length, errorCount: preview.errors.length, version: 1, createdAt: Date.now(), preview });
          return json(res, 200, { confirmed: false, preview, jobId: job.id });
        }
      }

      // 机会雷达（owner 隔离）：Agent 经 save_opportunity 写入，前端 Radar 读取。
      if (deps.opportunityStore) {
        const os = deps.opportunityStore;
        if (req.method === "GET" && path === "/v1/opportunities") return json(res, 200, { opportunities: await os.listByUser(uid) });
        if (req.method === "POST" && path === "/v1/opportunities") {
          const b: any = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
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
        const b: any = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
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
          const body = await readObject(req, deps.maxBodyBytes ?? 8 * 1024 * 1024);
          if (body.decision !== "approved" && body.decision !== "rejected") return json(res, 400, { error: "decision must be approved|rejected" });
          const a = await deps.approvals.decide(apMatch[1], uid, body.decision);
          if (!a) return json(res, 404, { error: "approval not found or forbidden" });
          return json(res, 200, { approval: a });
        }
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof SessionManagementError) return json(res, err.status, { error: err.message });
      if (err instanceof DocumentRenderUnavailable) return json(res, 503, { error: err.message });
      if (err instanceof ProviderError) return json(res, err.status, { error: err.message });
      if (err instanceof ApiInputError) return json(res, err.status, { error: err.message });
      if (err instanceof SessionConflict) return json(res, 409, { error: err.message });
      if (err instanceof SyntaxError || (err instanceof Error && err.message === "Invalid UUID")) return json(res, 400, { error: "invalid input" });
      if (err instanceof Error && /预算.*(范围|对象)/.test(err.message)) return json(res, 400, { error: err.message });
      if (err instanceof Error && err.message === "Session owner forbidden") return json(res, 403, { error: "forbidden" });
      return json(res, 500, { error: errorMessage(err) });
    }
  });
}
