// @vitest-environment node
// 持久化平台未接入：以下内存存储仅为契约 fixture，不能部署或作为 Sites DB 验收证据。
import { describe, expect, it, vi } from "vitest";
import { createSitesApp, type SitesAppOptions, type SitesRun, type SitesRunStore } from "../../../functions/sites-app";
import { createCloudAgentsClient, CloudAgentError } from "../../../functions/cloud-agents";
import { publicCloudEvent } from "../../../functions/cloud-events";

const origin = "https://campus.example";
const runId = "request_1234";
const notice = "校园通知：周五18点在201教室集合";
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/functions/v1/app${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function fixture(patch: Partial<SitesAppOptions> = {}) {
  const rows = new Map<string, SitesRun>();
  let owner: string | null = "owner-a";
  const runs: SitesRunStore = {
    reserve: vi.fn<SitesRunStore["reserve"]>(async run => {
      const key = `${run.owner}:${run.id}`;
      const existing = rows.get(key);
      if (existing) return existing.noticeHash === run.noticeHash ? { kind: "exists", run: { ...existing } } : { kind: "conflict" };
      rows.set(key, { ...run });
      return { kind: "created", run: { ...run } };
    }),
    get: vi.fn(async (owner, id) => { const row = rows.get(`${owner}:${id}`); return row ? { ...row } : null; }),
    transition: vi.fn(async (owner, id, from, patch) => {
      const row = rows.get(`${owner}:${id}`);
      if (!row || row.state !== from) return false;
      rows.set(`${owner}:${id}`, { ...row, ...patch }); return true;
    }),
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  const client = createCloudAgentsClient({ accessToken: "fixture-pat", fetch: fetcher });
  vi.spyOn(client, "createSession").mockResolvedValue({ id: "sess_test", status: "idle", archived_at: null });
  vi.spyOn(client, "sendMessage").mockResolvedValue([{ id: "evt_sent", type: "user.message", content: [{ type: "text", text: notice }] }]);
  vi.spyOn(client, "getSession").mockResolvedValue({ id: "sess_test", status: "running", archived_at: null });
  vi.spyOn(client, "cancelSession").mockResolvedValue();
  vi.spyOn(client, "listEvents").mockResolvedValue({ data: [], next_page: null });
  vi.spyOn(client, "getDownloadLink").mockResolvedValue({ url: "https://storage.qoder.com/doc?signature=fixture", expires_at: "2035-01-01T00:00:00Z" });
  const authorize = vi.fn(async () => owner ? { id: owner } : null);
  const allowRequest = vi.fn(async () => true);
  const options: SitesAppOptions = { authorize, runs, allowRequest, client, origin, agent: { id: "agent_test", version: 2 }, environmentId: "env_test", ...patch };
  return { rows, runs, client, fetcher, authorize, allowRequest, options, handler: createSitesApp(options),
    setOwner: (value: string | null) => { owner = value; } };
}
async function create(f: ReturnType<typeof fixture>) {
  const response = await f.handler(request("/runs", { requestId: runId, notice }));
  expect(response.status).toBe(201);
}

describe("Sites Edge 默认拒绝与身份边界", () => {
  it.each(["/functions/v1/app", "/app", `/functions/v1/app-d${"a".repeat(32)}`, `/app-d${"b".repeat(32)}`])("适配官方函数入口前缀 %s 并保留业务子路由", async prefix => {
    const f = fixture();
    const response = await f.handler(new Request(`${origin}${prefix}/me`, { headers: { Origin: origin } }));
    expect(await response.json()).toEqual({ user: { id: "owner-a" } });
  });
  it.each(["/app-unknown", "/functions/v1/app-secret", `/app-d${"z".repeat(32)}`])("不猜测任意物理入口 %s", async prefix => {
    expect((await fixture().handler(new Request(`${origin}${prefix}/health`))).status).toBe(404);
  });
  it("未配置的平台仅提供明确未就绪的 health", async () => {
    const handler = createSitesApp();
    expect(await (await handler(request("/health"))).json()).toEqual({ runtime: "cloud", configured: false, deploymentVerified: false });
    expect((await handler(request("/runs", { requestId: runId, notice }))).status).toBe(503);
  });
  it.each(["authorize", "runs", "allowRequest", "client", "agent", "environmentId", "origin"] as const)("缺少 %s 不调用 Cloud Agents", async key => {
    const f = fixture({ [key]: undefined });
    expect((await f.handler(request("/runs", { requestId: runId, notice }))).status).toBe(503);
    expect(f.client.createSession).not.toHaveBeenCalled();
  });
  it("伪造用户头不能代替平台认证", async () => {
    const f = fixture(); f.setOwner(null);
    const response = await f.handler(request("/runs", { requestId: runId, notice }, { "X-Session-Owner": "owner-a", "X-Qoder-User-Id": "owner-a" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "login_required" });
    expect(f.runs.reserve).not.toHaveBeenCalled();
  });
  it("身份由可信 adapter 决定，异常不泄露细节", async () => {
    const f = fixture();
    expect(await (await f.handler(request("/me"))).json()).toEqual({ user: { id: "owner-a" } });
    f.authorize.mockRejectedValueOnce(new Error("private-identity-secret"));
    const response = await f.handler(request("/me"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-identity-secret");
  });
  it.each(["https://evil.example", "null", ""])("拒绝跨站和缺少 Origin 的写请求 %s", async value => {
    const f = fixture();
    const req = request("/runs", { requestId: runId, notice }, { Origin: value });
    if (!value) req.headers.delete("Origin");
    expect((await f.handler(req)).status).toBe(403);
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it("跨站 GET 同样拒绝，不能以 Referer/Host 更换可信站点", async () => {
    const f = fixture();
    expect((await f.handler(request("/me", undefined, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect((await f.handler(request("/me", undefined, { Origin: "https://evil.example", Host: "evil.example" }))).status).toBe(403);
  });
  it("全局请求额度不足时不产生存储和收费调用", async () => {
    const f = fixture(); f.allowRequest.mockResolvedValue(false);
    const response = await f.handler(request("/runs", { requestId: runId, notice }));
    expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("60");
    expect(f.runs.reserve).not.toHaveBeenCalled();
  });
  it("持久化原子配额拒绝后不创建 Session", async () => {
    const f = fixture(); vi.mocked(f.runs.reserve).mockResolvedValueOnce({ kind: "limited" });
    expect((await f.handler(request("/runs", { requestId: runId, notice }))).status).toBe(429);
    expect(f.client.createSession).not.toHaveBeenCalled();
  });
  it("体积、类型、未知字段校验在任何云端写前完成", async () => {
    const f = fixture();
    for (const body of [{ requestId: runId, notice, owner: "attacker" }, { requestId: runId, notice, agent: "agent_attacker" }, { requestId: "../escape", notice }, { requestId: runId, notice: " " }]) {
      expect((await f.handler(request("/runs", body))).status).toBe(400);
    }
    expect((await f.handler(request("/runs", { requestId: runId, notice: "中".repeat(30_000) }))).status).toBe(413);
    expect((await f.handler(request("/runs", {}, { "Content-Type": "text/plain" }))).status).toBe(415);
    const malformed = new Request(`${origin}/functions/v1/app/runs`, { method: "POST", body: "{", headers: { Origin: origin, "Content-Type": "application/json" } });
    expect((await f.handler(malformed)).status).toBe(400);
    expect(f.runs.reserve).not.toHaveBeenCalled();
  });
});

describe("Sites Run 持久化边界与幂等契约", () => {
  it("创建和发消息分为两次短请求，响应不暴露账号级 Session ID", async () => {
    const f = fixture(); await create(f);
    expect(f.client.createSession).toHaveBeenCalledWith({ id: "agent_test", version: 2 }, "env_test");
    expect(f.client.sendMessage).not.toHaveBeenCalled();
    const sent = await f.handler(request(`/runs/${runId}/message`, { notice }));
    expect(sent.status).toBe(202);
    expect(f.client.sendMessage).toHaveBeenCalledWith("sess_test", notice);
    const snapshot = await f.handler(request(`/runs/${runId}`));
    expect(await snapshot.json()).toEqual({ run: { id: runId, state: "submitted" }, session: { status: "running", archived: false } });
    expect(f.rows.get(`owner-a:${runId}`)).not.toHaveProperty("notice");
  });
  it("并发创建同 requestId 只创建一次；异正文冲突", async () => {
    const f = fixture();
    const responses = await Promise.all([1, 2, 3].map(() => f.handler(request("/runs", { requestId: runId, notice }))));
    expect(responses.map(r => r.status).sort()).toEqual([200, 200, 201]);
    expect(f.client.createSession).toHaveBeenCalledOnce();
    expect((await f.handler(request("/runs", { requestId: runId, notice: "另一份通知" }))).status).toBe(409);
  });
  it("多个 Edge 实例共享同一存储时也只创建一个 Session", async () => {
    const f = fixture();
    const second = createSitesApp(f.options);
    const results = await Promise.all([f.handler, second].map(handler => handler(request("/runs", { requestId: runId, notice }))));
    expect(results.map(result => result.status).sort()).toEqual([200, 201]);
    expect(f.client.createSession).toHaveBeenCalledOnce();
  });
  it("创建响应丢失后重复请求不能再次创建", async () => {
    const f = fixture(); vi.mocked(f.client.createSession).mockRejectedValueOnce(new CloudAgentError("timeout", 504));
    expect((await f.handler(request("/runs", { requestId: runId, notice }))).status).toBe(504);
    expect(f.rows.get(`owner-a:${runId}`)?.state).toBe("uncertain");
    const replay = await f.handler(request("/runs", { requestId: runId, notice }));
    expect(await replay.json()).toMatchObject({ run: { state: "uncertain" }, deduped: true });
    expect(f.client.createSession).toHaveBeenCalledOnce();
  });
  it("并发发送由 CAS 保证一次执行，后续重试不会重新发送", async () => {
    const f = fixture(); await create(f);
    await Promise.all([1, 2, 3].map(() => f.handler(request(`/runs/${runId}/message`, { notice }))));
    expect(f.client.sendMessage).toHaveBeenCalledOnce();
    const replay = await f.handler(request(`/runs/${runId}/message`, { notice }));
    expect(await replay.json()).toMatchObject({ deduped: true });
    expect(f.client.sendMessage).toHaveBeenCalledOnce();
  });
  it("网络中断后状态不确定，重试不能再次收费调用", async () => {
    const f = fixture(); await create(f);
    vi.mocked(f.client.sendMessage).mockRejectedValueOnce(new CloudAgentError("contains-private-key", 504));
    const first = await f.handler(request(`/runs/${runId}/message`, { notice }));
    expect(first.status).toBe(504); expect(await first.text()).not.toContain("private-key");
    expect(f.rows.get(`owner-a:${runId}`)?.state).toBe("uncertain");
    expect((await f.handler(request(`/runs/${runId}/message`, { notice }))).status).toBe(409);
    expect(f.client.sendMessage).toHaveBeenCalledOnce();
  });
  it("平台接收后保存 submitted 失败，不会重发；保留可核查状态", async () => {
    const f = fixture(); await create(f);
    const transition = vi.mocked(f.runs.transition).getMockImplementation()!;
    vi.mocked(f.runs.transition).mockImplementation(async (owner, id, from, patch) => {
      if (patch.state === "submitted") throw new Error("db-secret");
      return transition(owner, id, from, patch);
    });
    expect((await f.handler(request(`/runs/${runId}/message`, { notice }))).status).toBe(503);
    expect(f.rows.get(`owner-a:${runId}`)?.state).toBe("uncertain");
    expect((await f.handler(request(`/runs/${runId}/message`, { notice }))).status).toBe(409);
    expect(f.client.sendMessage).toHaveBeenCalledOnce();
  });
  it("创建 Session 后绑定失败仍保留 Session ID 供对账", async () => {
    const f = fixture(); vi.mocked(f.runs.transition).mockRejectedValueOnce(new Error("db temporarily down"));
    expect((await f.handler(request("/runs", { requestId: runId, notice }))).status).toBe(503);
    expect(f.rows.get(`owner-a:${runId}`)).toMatchObject({ state: "uncertain", sessionId: "sess_test" });
    await f.handler(request("/runs", { requestId: runId, notice }));
    expect(f.client.createSession).toHaveBeenCalledOnce();
  });
  it("存储创建失败直接拒绝，绝不回退内存或绕过 DB", async () => {
    const f = fixture(); vi.mocked(f.runs.reserve).mockRejectedValueOnce(new Error("database password"));
    const response = await f.handler(request("/runs", { requestId: runId, notice }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("password");
    expect(f.client.createSession).not.toHaveBeenCalled();
  });
  it("发送阶段不能替换原始通知", async () => {
    const f = fixture(); await create(f);
    expect((await f.handler(request(`/runs/${runId}/message`, { notice: "替换通知" }))).status).toBe(409);
    expect(f.client.sendMessage).not.toHaveBeenCalled();
  });
  it("取消先封住发送；取消请求失败可重试但不会发送消息", async () => {
    const f = fixture(); await create(f);
    vi.mocked(f.client.cancelSession).mockRejectedValueOnce(new CloudAgentError("timeout", 504));
    expect((await f.handler(request(`/runs/${runId}/cancel`, {}))).status).toBe(504);
    expect((await f.handler(request(`/runs/${runId}/message`, { notice }))).status).toBe(409);
    expect((await f.handler(request(`/runs/${runId}/cancel`, {}))).status).toBe(202);
    expect(f.client.sendMessage).not.toHaveBeenCalled();
  });
  it("发送中的会话不能与取消竞争", async () => {
    const f = fixture(); await create(f);
    await f.runs.transition("owner-a", runId, "ready", { state: "sending" });
    expect((await f.handler(request(`/runs/${runId}/cancel`, {}))).status).toBe(409);
    expect(f.client.cancelSession).not.toHaveBeenCalled();
  });
  it("不同用户同 requestId 独立，未持有会话时所有路径均 404", async () => {
    const f = fixture(); await create(f); f.setOwner("owner-b");
    for (const suffix of ["", "/events", "/stream", "/artifacts/file_secret"]) expect((await f.handler(request(`/runs/${runId}${suffix}`))).status).toBe(404);
    for (const operation of ["message", "cancel"]) expect((await f.handler(request(`/runs/${runId}/${operation}`, { notice }))).status).toBe(404);
    expect(f.client.getSession).not.toHaveBeenCalled(); expect(f.client.listEvents).not.toHaveBeenCalled();
    await create(f);
    expect(f.client.createSession).toHaveBeenCalledTimes(2);
  });
  it("适配器意外返回另一个用户数据也不泄露", async () => {
    const f = fixture(); await create(f);
    vi.mocked(f.runs.get).mockResolvedValueOnce({ ...f.rows.get(`owner-a:${runId}`)!, owner: "owner-b" });
    expect((await f.handler(request(`/runs/${runId}`))).status).toBe(404);
    expect(f.client.getSession).not.toHaveBeenCalled();
  });
});

describe("Sites 事件订阅与产物隔离", () => {
  it("历史消息和状态允许读取，工具参数/结果、思考原文和未知字段被剔除", async () => {
    const f = fixture(); await create(f);
    vi.mocked(f.client.listEvents).mockResolvedValueOnce({ data: [
      { id: "evt_tool", type: "agent.tool_use", name: "Write", input: { secret: "private" } },
      { id: "evt_result", type: "agent.tool_result", tool_use_id: "evt_tool", is_error: false, content: "private" },
      { id: "evt_think", type: "agent.thinking", reasoning_content: "private" },
      { id: "evt_error", type: "session.error", error: { message: "private" } },
      { id: "evt_future", type: "future.type", token: "private" },
    ], next_page: "cursor-next" });
    const response = await f.handler(request(`/runs/${runId}/events?page=cursor-one`));
    const body = await response.text(); expect(body).not.toContain("private");
    expect(JSON.parse(body).nextPage).toBe("cursor-next");
    expect(f.client.listEvents).toHaveBeenCalledWith("sess_test", "cursor-one");
  });
  it("不能把其他会话的 fileId 兑换为账号级下载链接", async () => {
    const f = fixture(); await create(f);
    expect((await f.handler(request(`/runs/${runId}/artifacts/file_other`))).status).toBe(404);
    expect(f.client.getDownloadLink).not.toHaveBeenCalled();
    vi.mocked(f.client.listEvents).mockResolvedValueOnce({ data: [{ id: "evt_file", type: "agent.artifact_delivered", file_id: "file_owned" }], next_page: null });
    expect((await f.handler(request(`/runs/${runId}/artifacts/file_owned?page=own-page`))).status).toBe(200);
    expect(f.client.getDownloadLink).toHaveBeenCalledWith("file_owned");
    expect(f.client.listEvents).toHaveBeenLastCalledWith("sess_test", "own-page");
  });
  it("SSE 使用独立下游头、游标重连；从不转发上游凭据", async () => {
    const f = fixture(); await create(f);
    const raw = new Response('id: evt_t\nevent: agent.tool_use\ndata: {"id":"evt_t","type":"agent.tool_use","name":"Write","input":"private"}\n\n', { headers: { "Set-Cookie": "private", Authorization: "private" } });
    const stream = vi.spyOn(f.client, "streamEvents").mockResolvedValueOnce(raw);
    const response = await f.handler(request(`/runs/${runId}/stream`, undefined, { "Last-Event-ID": "evt_before" }));
    expect(stream).toHaveBeenCalledWith("sess_test", "evt_before", expect.any(AbortSignal));
    expect(response.headers.get("Set-Cookie")).toBeNull(); expect(response.headers.get("Authorization")).toBeNull();
    const text = await response.text(); expect(text).toContain("id: evt_t\n"); expect(text).not.toContain("private");
    expect(f.client.cancelSession).not.toHaveBeenCalled();
  });
  it("断流发送无 ID 的可重连信号，不泄露错误、不重发任务", async () => {
    const f = fixture(); await create(f);
    vi.spyOn(f.client, "streamEvents").mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-pat")); } })));
    const response = await f.handler(request(`/runs/${runId}/stream`));
    expect(await response.text()).toBe('event: stream_interrupted\ndata: {"reconnect":true}\n\n');
    expect(f.client.sendMessage).not.toHaveBeenCalled();
  });
  it("浏览器取消订阅释放上游，但不取消运行中的任务", async () => {
    const f = fixture(); await create(f);
    let aborted = false;
    vi.spyOn(f.client, "streamEvents").mockImplementationOnce(async (_sessionId, _lastId, signal) => new Response(new ReadableStream({ start(controller) {
      signal!.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
      controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
    } })));
    const response = await f.handler(request(`/runs/${runId}/stream`));
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); reader.releaseLock();
    expect(aborted).toBe(true); expect(f.client.cancelSession).not.toHaveBeenCalled();
  });
  it("拒绝畸形游标和不属于本站的路径", async () => {
    const f = fixture(); await create(f);
    expect((await f.handler(request(`/runs/${runId}/stream`, undefined, { "Last-Event-ID": "not-an-event" }))).status).toBe(400);
    expect((await f.handler(request(`/runs/${runId}/events?page=%00`))).status).toBe(400);
    expect((await f.handler(new Request(`${origin}/api/runs/${runId}`))).status).toBe(404);
  });
  it("上游凭据过期不误导用户重新登录，限流保留等待提示", async () => {
    const f = fixture(); await create(f);
    vi.mocked(f.client.getSession).mockRejectedValueOnce(new CloudAgentError("private-pat", 401));
    expect(await (await f.handler(request(`/runs/${runId}`))).json()).toEqual({ error: "cloud_unavailable" });
    vi.mocked(f.client.getSession).mockRejectedValueOnce(new CloudAgentError("private-pat", 429, 15));
    const response = await f.handler(request(`/runs/${runId}`)); expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("15");
  });
  it("有界正文明确标记截断，不把预览当作完整回复", () => {
    const view = publicCloudEvent({ type: "agent.message", content: [{ type: "text", text: "x".repeat(16_001) }] });
    expect(view.contentTruncated).toBe(true);
    expect((view.content as { text: string }[])[0].text).toHaveLength(16_000);
  });
  it("视图丢弃未知多模态块和危险产物标识", () => {
    expect(publicCloudEvent({ type: "agent.message", content: [{ type: "text", text: "正文", secret: "private" }, { type: "image", data: "private" }] })).toEqual({ type: "agent.message", content: [{ type: "text", text: "正文" }] });
    expect(publicCloudEvent({ type: "agent.artifact_delivered", file_id: "file_../escape", size: -1 })).not.toHaveProperty("file_id");
    expect(publicCloudEvent({ type: "agent.artifact_delivered", size: -1 })).not.toHaveProperty("size");
  });
});
