// @vitest-environment node
// 全部 HTTP/SSE 均为契约 fixture，不能用这些结果宣称真实黄金流通过。
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const argv = process.argv;
const exitCode = process.exitCode;
const token = "fixture-cloud-pat";
const markdown = "# 校园通知\n\n这是测试文档。\n";
const artifact = { id: "evt_artifact", type: "agent.artifact_delivered", file_id: "file_doc", original_filename: "campusmate-notice.md", size: Buffer.byteLength(markdown) };
const events = [
  { id: "evt_write", type: "agent.tool_use", name: "Write" },
  { id: "evt_written", type: "agent.tool_result", tool_use_id: "evt_write", is_error: false },
  { id: "evt_read", type: "agent.tool_use", name: "Read" },
  { id: "evt_read_result", type: "agent.tool_result", tool_use_id: "evt_read", is_error: false },
  { id: "evt_deliver", type: "agent.tool_use", name: "DeliverArtifacts" },
  { id: "evt_delivered", type: "agent.tool_result", tool_use_id: "evt_deliver", is_error: false },
  artifact,
  { id: "evt_idle", type: "session.status_idle", stop_reason: { type: "end_turn" } },
];
function sse(items: unknown[]) {
  return new Response(items.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
function fixture(options: { stream?: unknown[]; url?: string; bytes?: string; sendStatus?: number; reconnect?: boolean } = {}) {
  let streams = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/files/file_doc/content")) return Response.json({ url: options.url ?? "https://storage.qoder.com/files/doc?signature=fixture", expires_at: "2035-01-01T00:00:00Z" });
    if (url.startsWith("https://storage.qoder.com/")) return new Response(options.bytes ?? markdown);
    if (url.endsWith("/environments")) return Response.json({ id: "env_test" });
    if (url.endsWith("/agents")) return Response.json({ id: "agent_test", version: 3 });
    if (url.endsWith("/sessions")) return Response.json({ id: "sess_test", status: "idle", archived_at: null });
    if (url.endsWith("/events") && init?.method === "POST") return Response.json({ data: [{ id: "evt_user", type: "user.message" }] }, { status: options.sendStatus ?? 200 });
    if (url.endsWith("/events/stream")) {
      streams++;
      if (options.reconnect && streams === 1) return sse([events[0]]);
      return sse(options.stream ?? events);
    }
    if (url.endsWith("/cancel")) return Response.json({ id: "sess_test", status: "canceling" });
    throw new Error(`不应访问的 fixture 路由：${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  return { fetcher, log, error };
}
async function run() {
  // 使用变量导入 Node ESM 探针；不将其纳入浏览器构建图。
  const script = "../../../scripts/probe-cloud-agents.mjs";
  await import(script);
}
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("QODER_ACCESS_TOKEN", token);
  vi.stubEnv("QODER_API_BASE_URL", "https://api.qoder.com");
  process.argv = [argv[0], "probe-cloud-agents.mjs", "--run"];
  process.exitCode = undefined;
});
afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("只有成功工具结果、交付事件和下载内容齐全才记为通过", async () => {
  const { fetcher, log, error } = fixture();
  await run();
  expect(error).not.toHaveBeenCalled();
  const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(report).toMatchObject({ status: "artifact_verified", sitesVerified: false, contentQualityVerified: false, agentVersion: 3, bytes: Buffer.byteLength(markdown) });
  expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
  const download = fetcher.mock.calls.find(([url]) => String(url).startsWith("https://storage.qoder.com/"));
  expect(download?.[1]?.headers).toBeUndefined();
  expect(download?.[1]?.redirect).toBe("error");
  expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  expect(JSON.stringify(log.mock.calls)).not.toContain("signature=");
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(false);
});

it.each([
  { reason: "工具失败", stream: events.map(event => event.id === "evt_written" ? { ...event, is_error: true } : event), code: "cloud_tool_evidence_incomplete" },
  { reason: "只有调用没有工具结果", stream: events.filter(event => event.type !== "agent.tool_result"), code: "cloud_tool_evidence_incomplete" },
  { reason: "没有产物", stream: events.filter(event => event.type !== "agent.artifact_delivered"), code: "cloud_artifact_missing" },
  { reason: "等待审批而非完成", stream: events.map(event => event.id === "evt_idle" ? { ...event, stop_reason: { type: "requires_action" } } : event), code: "cloud_turn_not_completed" },
  { reason: "会话终止", stream: [{ id: "evt_terminated", type: "session.status_terminated" }], code: "cloud_session_terminated" },
])("$reason 时不通过，并显式取消本次会话", async ({ stream, code }) => {
  const { fetcher, error } = fixture({ stream });
  await run();
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ status: "blocked", error: code });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/cancel"))).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("/files/file_doc/content"))).toBe(false);
});

it("断线后仅重连 SSE，携带已完整处理的游标且不重复发消息", async () => {
  const { fetcher, log } = fixture({ reconnect: true });
  await run();
  const streams = fetcher.mock.calls.filter(([url]) => String(url).endsWith("/events/stream"));
  expect(streams).toHaveLength(2);
  expect(new Headers(streams[1][1]?.headers).get("Last-Event-ID")).toBe("evt_write");
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/events"))).toHaveLength(1);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: "artifact_verified", connections: 2, eventCount: 9 });
});

it("遇到限流不重新提交收费任务", async () => {
  const { fetcher, error } = fixture({ sendStatus: 429 });
  await run();
  expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ status: "blocked", error: "cloud_http_429" });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/events"))).toHaveLength(1);
});

it("未确认的产物域名不发起下载", async () => {
  const { fetcher, error } = fixture({ url: "https://evil.example/report" });
  await run();
  expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ error: "cloud_artifact_host_unverified" });
  expect(fetcher.mock.calls.some(([url]) => String(url).startsWith("https://evil.example"))).toBe(false);
});

it("下载内容与产物元数据不一致时不通过", async () => {
  const { error } = fixture({ bytes: "# 截断内容" });
  await run();
  expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ error: "cloud_artifact_invalid" });
});
