// Deno 原生 Web API 冒烟；无网络/环境变量权限，不代表 Sites 平台集成测试。
import { createSitesApp } from "./sites-app.ts";
import { createCloudAgentsClient } from "./cloud-agents.ts";
import { publicCloudEvent, readCloudEvents } from "./cloud-events.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
Deno.test("未提供平台适配器时不能创建收费任务", async () => {
  const app = createSitesApp();
  const response = await app(new Request("https://example.com/functions/v1/app/runs", {
    method: "POST", headers: { Origin: "https://example.com", "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "test_1234", notice: "校园通知" }),
  }));
  assert(response.status === 503, "配置缺失必须返回 503");
  assert((await response.json()).error === "sites_not_configured", "必须说明尚未配置");
});
Deno.test("health 不把配置状态当作真实部署验收", async () => {
  const response = await createSitesApp()(new Request("https://example.com/functions/v1/app/health"));
  const body = await response.json();
  assert(body.configured === false && body.deploymentVerified === false, "不得虚报部署完成");
});
Deno.test("REST 适配器在 Deno 无 DOM 环境中正确构造请求", async () => {
  let calls = 0;
  const client = createCloudAgentsClient({ accessToken: "fixture-only", fetch: async (input, init) => {
    calls++;
    assert(String(input) === "https://api.qoder.com/api/v1/cloud/sessions", "请求地址错误");
    assert(init?.redirect === "error", "不得跟随重定向发送 PAT");
    const body = JSON.parse(String(init?.body));
    assert(body.agent.version === 2 && body.environment_id === "env_test", "配置版本必须固定");
    return Response.json({ id: "sess_test", status: "idle", archived_at: null, environment_variables: { SECRET: "private" } });
  } });
  const session = await client.createSession({ id: "agent_test", version: 2 }, "env_test");
  assert(session.id === "sess_test" && calls === 1 && !("environment_variables" in session), "只能返回安全视图");
});
Deno.test("原生 ReadableStream 能跨 UTF-8 字节解析 SSE", async () => {
  const bytes = new TextEncoder().encode('id: evt_test\r\nevent: agent.message\r\ndata: {"id":"evt_test","type":"agent.message","content":[{"type":"text","text":"校园通知"}]}\r\n\r\n');
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, ++offset));
  } });
  const events = [];
  for await (const event of readCloudEvents(body)) events.push(event);
  assert(events.length === 1 && JSON.stringify(events[0]).includes("校园通知"), "UTF-8 消息丢失");
  assert(!body.locked, "reader 必须释放");
});
Deno.test("公开事件不泄露工具参数及思考原文", () => {
  const events = [
    { type: "agent.tool_use", id: "evt_a", name: "Write", input: "private-secret" },
    { type: "agent.thinking", id: "evt_b", reasoning_content: "private-secret" },
    { type: "session.error", id: "evt_c", error: { message: "private-secret" } },
  ];
  assert(!JSON.stringify(events.map(publicCloudEvent)).includes("private-secret"), "事件未正确过滤");
});
