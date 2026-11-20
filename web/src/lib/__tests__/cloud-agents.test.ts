// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCloudAgentsClient } from "../../../functions/cloud-agents";
import { readCloudEvents } from "../../../functions/cloud-events";

const token = "fixture-server-secret";
const session = { id: "sess_test", status: "idle", archived_at: null };
const agent = { id: "agent_test", version: 2 };
function fixture(body: unknown = session) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
  return { fetcher, client: createCloudAgentsClient({ accessToken: token, fetch: fetcher }) };
}
function stream(text: string, chunkSize = 3) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset += chunkSize));
  } });
}
async function collect(body: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of readCloudEvents(body)) events.push(event);
  return events;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Cloud Agents 服务端契约（非真实云端证据）", () => {
  it("拒绝浏览器环境和缺失的密钥", () => {
    expect(() => createCloudAgentsClient({ accessToken: "" })).toThrow("cloud_token_missing_or_invalid");
    expect(() => createCloudAgentsClient({ accessToken: "bad\r\ntoken" })).toThrow("cloud_token_missing_or_invalid");
    vi.stubGlobal("document", {});
    expect(() => createCloudAgentsClient({ accessToken: token })).toThrow("cloud_server_only");
  });
  it("兼容没有 DOM 但提供 window 的 Deno 环境", () => {
    vi.stubGlobal("window", {});
    expect(() => createCloudAgentsClient({ accessToken: token })).not.toThrow();
  });
  it.each(["http://api.qoder.com", "https://api.qoder.com:8443", "https://user:pass@api.qoder.com", "https://api.qoder.com/path", "https://api.qoder.com?key=secret", "https://api.qoder.com#fragment", "https://evil.example", "https://api.qoder.com.evil.example", "https://127.0.0.1", "not-a-url"])("不向未确认地址发送凭据：%s", baseUrl => {
    expect(() => createCloudAgentsClient({ accessToken: token, baseUrl })).toThrow();
  });
  it.each([0, -1, 30_001, NaN, 1.2])("限制单次请求期限：%s", requestTimeoutMs => {
    expect(() => createCloudAgentsClient({ accessToken: token, requestTimeoutMs })).toThrow("cloud_invalid_input");
  });
  it("列表请求使用 Bearer、不跟随重定向，并正确编码分页游标", async () => {
    const { client, fetcher } = fixture({ data: [{ id: "env_test", name: "test", credentials: token }], next_page: "next" });
    expect(await client.listEnvironments("cursor+/=&")).toEqual({ data: [{ id: "env_test", name: "test" }], next_page: "next" });
    expect(fetcher).toHaveBeenCalledWith("https://api.qoder.com/api/v1/cloud/environments?limit=20&page=cursor%2B%2F%3D%26", expect.objectContaining({
      method: "GET", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }));
  });
  it("创建 Environment 和最小工具集 Agent，不开放 Bash 和网络工具", async () => {
    const { client, fetcher } = fixture({ id: "env_test" });
    expect(await client.createEnvironment()).toEqual({ id: "env_test" });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ name: "campusmate-p0" });
    fetcher.mockResolvedValueOnce(Response.json(agent));
    expect(await client.createNoticeAgent()).toEqual(agent);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({
      model: "ultimate", tools: [{ type: "agent_toolset_20260401", enabled_tools: ["Read", "Write", "DeliverArtifacts"] }],
    });
  });
  it("Session 固定 Agent 版本，返回视图不泄露运行环境", async () => {
    const { client, fetcher } = fixture({ ...session, environment_variables: { SECRET: token }, vault_ids: ["private"] });
    expect(await client.createSession(agent, "env_test")).toEqual(session);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ agent: { ...agent, type: "agent" }, environment_id: "env_test" });
    expect(await client.getSession("sess_test")).toEqual(session);
  });
  it.each(["idle", "running", "rescheduling", "terminated"])("识别真实 Session 状态 %s", async status => {
    expect(await fixture({ ...session, status }).client.getSession("sess_test")).toMatchObject({ status });
  });
  it("不把 canceling 当作持久状态", async () => {
    await expect(fixture({ ...session, status: "canceling" }).client.getSession("sess_test")).rejects.toThrow("cloud_invalid_response");
  });
  it("按官方 events 数组发送中文消息", async () => {
    const event = { id: "evt_sent", type: "user.message" };
    const { client, fetcher } = fixture({ data: [event] });
    expect(await client.sendMessage("sess_test", "整理校园通知")).toEqual([event]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ events: [{ type: "user.message", content: [{ type: "text", text: "整理校园通知" }] }] });
  });
  it("非法 ID、空文本和超大 UTF-8 通知不产生请求", async () => {
    const { client, fetcher } = fixture();
    for (const value of ["", "sess_a/../b", "sess_a?query=1", "sess_a\r\nsecret"]) {
      await expect(client.getSession(value)).rejects.toThrow("cloud_invalid_input");
    }
    for (const text of [" ", "通".repeat(30_000)]) await expect(client.sendMessage("sess_test", text)).rejects.toThrow("cloud_invalid_input");
    await expect(client.createSession({ ...agent, version: 0 }, "env_test")).rejects.toThrow("cloud_invalid_input");
    await expect(client.listEvents("sess_test", "\n")).rejects.toThrow("cloud_invalid_input");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403, 409, 429, 500, 503])("保留 HTTP %s 语义但不泄露上游错误或重发消息", async status => {
    const { client, fetcher } = fixture();
    fetcher.mockResolvedValue(new Response(token, { status, headers: { "Retry-After": "12" } }));
    await expect(client.sendMessage("sess_test", "通知")).rejects.toMatchObject({ message: `cloud_http_${status}`, status, retryAfter: 12 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("网络错误正文不进入异常", async () => {
    const { client, fetcher } = fixture();
    fetcher.mockRejectedValue(new Error(token));
    await expect(client.getSession("sess_test")).rejects.toMatchObject({ message: "cloud_unavailable" });
  });
  it("网络请求超时与调用方取消可区分", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) { reject(init.signal.reason); return; }
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = createCloudAgentsClient({ accessToken: token, fetch: fetcher, requestTimeoutMs: 10 });
    await expect(client.getSession("sess_test")).rejects.toMatchObject({ message: "cloud_request_timeout", status: 504 });
    await expect(client.streamEvents("sess_test", undefined, AbortSignal.abort())).rejects.toMatchObject({ message: "cloud_request_aborted", status: 499 });
  });
  it("响应头已返回时，JSON 正文读取仍受超时约束", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
    } })));
    const client = createCloudAgentsClient({ accessToken: token, fetch: fetcher, requestTimeoutMs: 10 });
    await expect(client.getSession("sess_test")).rejects.toThrow("cloud_request_timeout");
  });
  it("畸形与超大上游 JSON 安全失败", async () => {
    const { client, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(new Response("<html>secret</html>"));
    await expect(client.getSession("sess_test")).rejects.toThrow("cloud_invalid_response");
    fetcher.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(client.getSession("sess_test")).rejects.toThrow("cloud_invalid_response");
  });
  it("历史分页保留未知事件，不伪造 thinking 文本", async () => {
    const events = [{ id: "evt_think", type: "agent.thinking" }, { id: "evt_future", type: "future.event" }];
    const { client, fetcher } = fixture({ data: events, next_page: null });
    expect(await client.listEvents("sess_test", "next+/=")).toEqual({ data: events, next_page: null });
    expect(String(fetcher.mock.calls[0][0])).toContain("limit=100&order=asc&page=next%2B%2F%3D");
  });
  it("SSE 使用 Last-Event-ID，取消 body 不取消 Session", async () => {
    const cancel = vi.fn();
    const { client, fetcher } = fixture();
    fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
    const response = await client.streamEvents("sess_test", "evt_last");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Last-Event-ID")).toBe("evt_last");
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("拒绝伪装为 SSE 的 JSON", async () => {
    await expect(fixture().client.streamEvents("sess_test")).rejects.toThrow("cloud_invalid_response");
  });
  it("显式取消只调用 cancel，不删除 Session", async () => {
    const { client, fetcher } = fixture({ ...session, status: "canceling" });
    await client.cancelSession("sess_test");
    expect(String(fetcher.mock.calls[0][0])).toMatch(/\/sessions\/sess_test\/cancel$/);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
  });
  it("获取产物限时链接，不自动附带凭据下载", async () => {
    const link = { url: "https://storage.qoder.com/files/report?signature=fixture", expires_at: "2026-12-01T00:00:00Z" };
    const { client, fetcher } = fixture(link);
    expect(await client.getDownloadLink("file_test")).toEqual(link);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toMatch(/\/files\/file_test\/content$/);
  });
  it.each(["http://storage.qoder.com/report", "javascript:alert(1)", "https://user:pass@storage.qoder.com/file"])("拒绝不安全产物链接：%s", async url => {
    await expect(fixture({ url, expires_at: "2026-12-01T00:00:00Z" }).client.getDownloadLink("file_test")).rejects.toThrow("cloud_invalid_response");
  });
});

describe("Cloud Agents SSE 增量解析", () => {
  it.each(["\n", "\r\n", "\r"])("处理逐字节 UTF-8、注释与 %j 换行", async newline => {
    const text = [": ping", "id: evt_1", "event: agent.message", 'data: {"id":"evt_1",', 'data: "type":"agent.message","content":[{"type":"text","text":"通知中文"}]}', "", ""].join(newline);
    expect(await collect(stream(text, 1))).toEqual([{ id: "evt_1", type: "agent.message", content: [{ type: "text", text: "通知中文" }] }]);
  });
  it("heartbeat 不携带上一条事件游标", async () => {
    const text = 'id: evt_1\nevent: agent.thinking\ndata: {"id":"evt_1","type":"agent.thinking"}\n\nevent: heartbeat\ndata: {}\n\n';
    expect(await collect(stream(text))).toEqual([{ id: "evt_1", type: "agent.thinking" }, { type: "heartbeat" }]);
  });
  it("未结束的帧不提交，允许断线后重放", async () => {
    expect(await collect(stream('id: evt_1\nevent: agent.message\ndata: {"id":"evt_1","type":"agent.message"}\n'))).toEqual([]);
  });
  it("保留产物真实元数据和未来事件", async () => {
    const artifact = { id: "evt_artifact", type: "agent.artifact_delivered", file_id: "file_test", original_filename: "通知.md", size: 42 };
    expect(await collect(stream(`data: ${JSON.stringify(artifact)}\n\n`))).toEqual([artifact]);
  });
  it.each([
    'data: not-json\n\n', 'data: []\n\n',
    'id: evt_a\nevent: agent.message\ndata: {"id":"evt_b","type":"agent.message"}\n\n',
    'event: agent.message\ndata: {"id":"evt_a","type":"session.status_idle"}\n\n',
    'data: {"type":"agent.message"}\n\n',
  ])("畸形帧安全失败且不提交错误游标", async text => {
    await expect(collect(stream(text))).rejects.toThrow("cloud_stream_invalid");
  });
  it("限制未换行帧大小", async () => {
    await expect(collect(stream(`data: ${"x".repeat(256 * 1024)}`, 4096))).rejects.toThrow("cloud_stream_too_large");
  });
  it("消费方提前结束时释放 reader 和订阅", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
    }, cancel });
    for await (const event of readCloudEvents(body)) { expect(event.type).toBe("heartbeat"); break; }
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("流读取失败不泄露底层错误", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(token)); } });
    await expect(collect(body)).rejects.toThrow("cloud_stream_interrupted");
    expect(body.locked).toBe(false);
  });
});

describe("技术探针的本地预检", () => {
  const script = fileURLToPath(new URL("../../../scripts/probe-cloud-agents.mjs", import.meta.url));
  it("无 PAT 时退出并明确没有执行真实调用", () => {
    const result = spawnSync(process.execPath, [script, "--check"], {
      encoding: "utf8", env: { ...process.env, QODER_ACCESS_TOKEN: "", QODER_PAT: "" }, timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr.trim())).toMatchObject({ liveAttempted: false, sitesVerified: false, status: "blocked", error: "cloud_token_missing_or_invalid" });
  });
  it("帮助命令不要求密钥或触发网络", () => {
    const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--run");
  });
  it("未知参数不创建资源", () => {
    const result = spawnSync(process.execPath, [script, "--publish"], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr.trim())).toEqual({ status: "blocked", error: "invalid_arguments" });
  });
});
