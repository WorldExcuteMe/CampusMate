import { CloudAgentError, type CloudAgent, type createCloudAgentsClient } from "./cloud-agents.ts";
import { publicCloudEvent, readCloudEvents } from "./cloud-events.ts";
import { beijingTimeContext } from "./current-time.ts";

type Client = ReturnType<typeof createCloudAgentsClient>;
export type RunState = "creating" | "ready" | "sending" | "submitted" | "uncertain" | "cancelled";
export interface SitesRun {
  id: string;
  owner: string;
  noticeHash: string;
  state: RunState;
  sessionId?: string;
}
export interface SitesRunStore {
  // 必须由持久化事务实现：(owner,id) 唯一、同键异正文 conflict、配额检查和插入原子化。
  // creating/sending/uncertain 不能因租约过期自动重放，须先人工或平台凭证对账。
  reserve(run: SitesRun): Promise<{ kind: "created" | "exists"; run: SitesRun } | { kind: "conflict" | "limited" }>;
  get(owner: string, id: string): Promise<SitesRun | null>;
  // owner + id + 旧 state 的原子比较并更新；失败必须返回 false，不能覆盖别人的更新。
  transition(owner: string, id: string, from: RunState, patch: { state: RunState; sessionId?: string }): Promise<boolean>;
}
export interface SitesBinding {
  agent: CloudAgent;
  environmentId: string;
}
export interface SitesAppOptions {
  // 不提供猜测的平台身份头或开发绕过。返回值必须来自已验证的平台身份。
  authorize?: (request: Request) => Promise<{ id: string } | null>;
  runs?: SitesRunStore;
  // 必须为跨实例额度实现；创建次数/并发预算也须在 reserve 中检查，不能只靠内存 Map。
  allowRequest?: (owner: string, action: "read" | "write" | "stream") => Promise<boolean>;
  // 每次使用时解析，确保运行路由读取当前请求的平台 PAT 而不是冷启动时的值。
  client?: Client | (() => Client);
  // 固定的管理预置资源；与 binding 至少提供一个。
  agent?: CloudAgent;
  environmentId?: string;
  // 只读取已持久化的绑定，绝不在此触发云资源初始化。
  binding?: () => Promise<SitesBinding | null>;
  // 首次使用时显式初始化；返回 Response 时直接用作 HTTP 响应。
  initialize?: () => Promise<Response | void>;
  origin?: string;
}
class AppError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
const validId = (id: string) => /^[A-Za-z0-9_-]{8,100}$/.test(id);
const runView = (run: SitesRun) => ({ id: run.id, state: run.state });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
});
function checked(run: SitesRun | null, owner: string, id: string): SitesRun {
  // 防御错误的适配器实现；不存在与跨用户均返回 404。
  if (!run || run.owner !== owner || run.id !== id) throw new AppError(404, "run_not_found");
  return run;
}
async function input(request: Request, fields: string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("Content-Type") ?? "")) throw new AppError(415, "json_required");
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, "body_required");
  let text = "", size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(408, "body_timeout")), 5000); });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > 70 * 1024) throw new AppError(413, "body_too_large");
      text += decoder.decode(value, { stream: true });
    }
    const data = JSON.parse(text + decoder.decode());
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(key => !fields.includes(key))) throw new AppError(400, "invalid_body");
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "invalid_body");
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function noticeHash(data: Record<string, unknown>): Promise<string> {
  if (typeof data.notice !== "string" || !data.notice.trim()) throw new AppError(400, "notice_required");
  const bytes = new TextEncoder().encode(data.notice);
  if (bytes.byteLength > 64 * 1024) throw new AppError(413, "notice_too_large");
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
function nextPage(url: URL): string | undefined {
  const page = url.searchParams.get("page") ?? undefined;
  if (page !== undefined && (!page || page.length > 2048 || /[\r\n\0]/.test(page))) throw new AppError(400, "invalid_cursor");
  return page;
}

// 平台无关接入层，不自动绑定现有 Supabase runtime，也不创建进程内的假 Sites DB。
export function createSitesApp(options: SitesAppOptions = {}) {
  let trustedOrigin: string | undefined;
  try {
    const url = new URL(options.origin ?? "");
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) trustedOrigin = url.origin;
  } catch { /* 缺少配置时所有受保护路由拒绝访问。 */ }
  const fixedBinding = Boolean(options.agent && /^agent_[A-Za-z0-9_-]{1,160}$/.test(options.agent.id) &&
    Number.isInteger(options.agent.version) && options.agent.version > 0 &&
    /^env_[A-Za-z0-9_-]{1,160}$/.test(options.environmentId ?? ""));
  const configured = Boolean(trustedOrigin && options.authorize && options.runs && options.allowRequest && options.client &&
    (fixedBinding || typeof options.binding === "function"));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // 官方 Gateway 会把 app 替换为版本化函数名；Provider 也可能去掉 /functions/v1。
    const routeMatch = /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/.exec(url.pathname);
    if (!routeMatch) return json(404, { error: "not_found" });
    const route = routeMatch[1] || "/";
    if (route === "/health" && request.method === "GET") {
      return json(200, { runtime: "cloud", configured, deploymentVerified: false });
    }
    if (!configured) return json(503, { error: "sites_not_configured" });
    const runs = options.runs!;
    const getClient = (): Client => typeof options.client === "function" ? options.client() : options.client!;
    const resolveBinding = async (): Promise<SitesBinding | null> =>
      options.binding ? await options.binding()
        : fixedBinding ? { agent: options.agent!, environmentId: options.environmentId! }
        : null;
    const origin = request.headers.get("Origin");
    if (origin && origin !== trustedOrigin || request.headers.get("Sec-Fetch-Site") === "cross-site" ||
        request.method !== "GET" && origin !== trustedOrigin) return json(403, { error: "origin_not_allowed" });
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    try {
      const identity = await options.authorize!(request);
      if (!identity || typeof identity.id !== "string" || !identity.id.trim() || identity.id.length > 200) return json(401, { error: "login_required" });
      const owner = identity.id;
      const action = route.endsWith("/stream") ? "stream" : request.method === "GET" ? "read" : "write";
      if (!await options.allowRequest!(owner, action)) return json(429, { error: "rate_limit_exceeded" }, { "Retry-After": "60" });
      if (route === "/me" && request.method === "GET") return json(200, { user: { id: owner } });

      if (route === "/initialize" && request.method === "POST") {
        if (!options.initialize) return json(503, { error: "sites_initialization_unavailable" });
        const response = await options.initialize();
        return response ?? json(200, { ready: true });
      }

      if (route === "/runs" && request.method === "POST") {
        const data = await input(request, ["requestId", "notice"]);
        if (typeof data.requestId !== "string" || !validId(data.requestId)) throw new AppError(400, "invalid_request_id");
        const hash = await noticeHash(data);
        // runs 只读取已持久化的绑定；未初始化时明确返回 409，绝不在此创建云资源。
        const binding = await resolveBinding();
        if (!binding) return json(409, { error: "sites_not_initialized" });
        const reserved = await runs.reserve({ owner, id: data.requestId, noticeHash: hash, state: "creating" });
        if (reserved.kind === "limited") return json(429, { error: "run_limit_exceeded" });
        if (reserved.kind === "conflict") return json(409, { error: "request_conflict" });
        if (!("run" in reserved)) throw new AppError(503, "store_unavailable");
        const run = checked(reserved.run, owner, data.requestId);
        if (run.noticeHash !== hash) return json(409, { error: "request_conflict" });
        if (reserved.kind === "exists") return json(200, { run: runView(run), deduped: true });
        let createdSessionId: string | undefined;
        try {
          // 单次请求仅创建 Session；Agent/Environment 来自持久化绑定，不向访客开放管理 API。
          const session = await getClient().createSession(binding.agent, binding.environmentId);
          createdSessionId = session.id;
          if (!await runs.transition(owner, run.id, "creating", { state: "ready", sessionId: session.id })) throw new AppError(503, "run_reconciliation_required");
          return json(201, { run: { id: run.id, state: "ready" } });
        } catch (error) {
          // 即使响应或持久化失败，也不重复创建。保留不确定记录以便控制台对账。
          await runs.transition(owner, run.id, "creating", { state: "uncertain", ...(createdSessionId ? { sessionId: createdSessionId } : {}) });
          throw error;
        }
      }
      const match = /^\/runs\/([A-Za-z0-9_-]{8,100})(?:\/(message|events|stream|cancel|artifacts)(?:\/(file_[A-Za-z0-9_-]{1,160}))?)?$/.exec(route);
      if (!match) return json(404, { error: "not_found" });
      const [, runId, operation, fileId] = match;
      if (fileId && operation !== "artifacts") return json(404, { error: "not_found" });
      const run = checked(await runs.get(owner, runId), owner, runId);
      if (!operation && request.method === "GET") {
        const session = run.sessionId ? await getClient().getSession(run.sessionId) : undefined;
        return json(200, { run: runView(run), ...(session ? { session: { status: session.status, archived: session.archived_at !== null } } : {}) });
      }
      if (!run.sessionId) return json(409, { error: "run_reconciliation_required", run: runView(run) });
      const client = getClient();
      if (operation === "message" && request.method === "POST") {
        const data = await input(request, ["notice"]);
        if (await noticeHash(data) !== run.noticeHash) return json(409, { error: "request_conflict" });
        if (run.state === "submitted") return json(200, { run: runView(run), deduped: true });
        if (run.state !== "ready" || !await runs.transition(owner, runId, "ready", { state: "sending" })) return json(409, { error: "run_reconciliation_required" });
        try {
          const events = await client.sendMessage(run.sessionId, `${beijingTimeContext()}\n\n【通知原文】\n${data.notice as string}`);
          if (!await runs.transition(owner, runId, "sending", { state: "submitted" })) throw new AppError(503, "run_reconciliation_required");
          return json(202, { run: { id: runId, state: "submitted" }, events: events.map(publicCloudEvent) });
        } catch (error) {
          await runs.transition(owner, runId, "sending", { state: "uncertain" });
          throw error;
        }
      }
      if (operation === "cancel" && request.method === "POST") {
        if (["creating", "sending"].includes(run.state)) return json(409, { error: "run_reconciliation_required" });
        if (run.state !== "cancelled" && !await runs.transition(owner, runId, run.state, { state: "cancelled" })) return json(409, { error: "run_reconciliation_required" });
        // 先封住发送入口；取消失败可以再次显式取消，不重新发送消息。
        await client.cancelSession(run.sessionId);
        return json(202, { run: { id: runId, state: "cancelled" }, cancelRequested: true });
      }
      if (operation === "events" && request.method === "GET") {
        const page = await client.listEvents(run.sessionId, nextPage(url));
        return json(200, { events: page.data.map(publicCloudEvent), nextPage: page.next_page });
      }
      if (operation === "artifacts" && fileId && request.method === "GET") {
        // File API 是账号级权限，必须在当前用户 Session 的真实交付事件中找到 file_id。
        // 仅查询指定的一页，不在 Edge 中遍历历史；页面从事件流/历史响应保留该页游标。
        const page = await client.listEvents(run.sessionId, nextPage(url));
        if (!page.data.some(event => event.type === "agent.artifact_delivered" && event.file_id === fileId)) return json(404, { error: "artifact_not_found" });
        return json(200, await client.getDownloadLink(fileId));
      }
      if (operation === "stream" && request.method === "GET") {
        const lastId = request.headers.get("Last-Event-ID") ?? undefined;
        if (lastId !== undefined && !/^evt_[A-Za-z0-9_-]{1,160}$/.test(lastId)) throw new AppError(400, "invalid_cursor");
        const controller = new AbortController();
        const upstream = await client.streamEvents(run.sessionId, lastId, AbortSignal.any([request.signal, controller.signal]));
        const iterator = readCloudEvents(upstream.body!);
        const encoder = new TextEncoder();
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(output) {
            try {
              const { value, done } = await iterator.next();
              if (cancelled) return;
              if (done) { output.close(); return; }
              const event = publicCloudEvent(value);
              output.enqueue(encoder.encode(`${event.id ? `id: ${event.id}
` : ""}event: cloud_event
data: ${JSON.stringify(event)}

`));
            } catch {
              if (cancelled) return;
              // 不输出底层错误；不给失败帧设置 id，浏览器从上一条完整帧继续。
              output.enqueue(encoder.encode('event: stream_interrupted\ndata: {"reconnect":true}\n\n'));
              output.close();
            }
          },
          async cancel() {
            cancelled = true;
            controller.abort();
            // 尚未首次 pull 的 generator 不会运行 finally，需要显式释放上游 body。
            if (!upstream.body!.locked) await upstream.body!.cancel().catch(() => {});
            await iterator.return(undefined);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" } });
      }
      return json(405, { error: "method_not_allowed" });
    } catch (error) {
      if (error instanceof AppError) return json(error.status, { error: error.message });
      if (error instanceof CloudAgentError) {
        // 平台 PAT 按请求读取；缺失时明确要求服务端配置，而不是让用户重新登录。
        if (error.message === "cloud_token_missing_or_invalid") return json(503, { error: "ai_not_configured" });
        const status = error.status === 429 ? 429 : error.status === 409 ? 409 : error.status === 504 ? 504 : 502;
        const code = status === 429 ? "cloud_rate_limited" : status === 409 ? "cloud_busy" : status === 504 ? "cloud_timeout" : "cloud_unavailable";
        return json(status, { error: code }, error.retryAfter === undefined ? {} : { "Retry-After": String(error.retryAfter) });
      }
      return json(503, { error: "sites_dependency_unavailable" });
    }
  };
}
