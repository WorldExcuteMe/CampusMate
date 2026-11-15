import { describe, it, expect, vi } from "vitest";
import { createHandler, MAX_TOOLS, supabaseAuthorizer, type HandlerOptions } from "../../../functions/handler";
import { AGENT_TOOLS } from "../agent/tools";

const provider = { id: "builtin-deepseek", name: "测试模型", baseUrl: "https://model.example/v1", protocol: "openai", model: "fixed-model", apiKey: "test-server-secret" };
const message = [{ role: "user", content: "fixture" }];
const tools = [{ type: "function", function: { name: "create_daily_task", parameters: { type: "object", properties: {} } } }];
function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`https://campus.example/functions/v1/app${path}`, {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function fixture(overrides: Partial<HandlerOptions> = {}) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ choices: [{ message: { content: "ok" } }], model: "fixed-model" }));
  return { fetcher, handler: createHandler({ providers: () => [provider], authorize: async () => "user-a", fetch: fetcher, ...overrides }) };
}

describe("production/local AI handler", () => {
  it.each([{ toolset: AGENT_TOOLS }, { toolset: AGENT_TOOLS.filter(t => t.function.name !== "sync_group_notices") }])("forwards the actual Agent toolset without invalid_tools", async ({ toolset }) => {
    const { handler, fetcher } = fixture();
    expect(toolset.length).toBeGreaterThan(16);
    expect((await handler(request("/llm", { messages: message, tools: toolset }))).status).toBe(200);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body)).tools).toEqual(toolset);
  });
  it("accepts the bounded 128 tools but rejects overflow, duplicates and malformed definitions", async () => {
    const { handler, fetcher } = fixture();
    const toolset = Array.from({ length: MAX_TOOLS }, (_, i) => ({ ...tools[0], function: { ...tools[0].function, name: `tool_${i}` } }));
    expect((await handler(request("/llm", { messages: message, tools: toolset }))).status).toBe(200);
    fetcher.mockClear();
    for (const invalid of [[...toolset, tools[0]], [tools[0], tools[0]], [{ ...tools[0], function: { name: "bad name", parameters: {} } }], [{ ...tools[0], function: { name: "bad", parameters: [] } }]]) {
      expect((await handler(request("/llm", { messages: message, tools: invalid }))).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed without an authorization verifier", async () => {
    const handler = createHandler({ providers: () => [provider] });
    expect((await handler(request("/providers"))).status).toBe(401);
  });
  it("verifies bearer tokens against Supabase, not just JWT contents", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "verified-user" }));
    const auth = supabaseAuthorizer("https://fixture.supabase.co", "public-anon", fetcher);
    expect(await auth(request("/providers"))).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    const req = request("/providers"); req.headers.set("Authorization", "Bearer fixture-token");
    expect(await auth(req)).toBe("verified-user");
    expect(fetcher).toHaveBeenCalledWith("https://fixture.supabase.co/auth/v1/user", expect.objectContaining({ headers: { apikey: "public-anon", Authorization: "Bearer fixture-token" } }));
    fetcher.mockImplementation(async () => Response.json({}, { status: 401 }));
    expect(await auth(req)).toBeNull();
  });
  it("returns a secret-free read-only production catalog", async () => {
    const { handler } = fixture();
    const response = await handler(request("/providers"));
    const body = await response.text();
    expect(body).not.toContain(provider.apiKey);
    expect(JSON.parse(body)).toMatchObject({ mutable: false, providers: [{ hasKey: true }] });
    expect((await handler(request("/providers", provider))).status).toBe(405);
  });
  it("forwards tool definitions and tool results, but keeps model/token limits server-owned", async () => {
    const { handler, fetcher } = fixture();
    const messages = [...message, { role: "tool", content: "result", tool_call_id: "call-1" }];
    const response = await handler(request("/llm", { messages, tools, model: "expensive-override", max_tokens: 999999, responseFormat: { type: "json_object" } }));
    expect(response.status).toBe(200);
    const init = fetcher.mock.calls[0][1]!;
    expect(JSON.parse(String(init.body))).toMatchObject({ tools, messages, model: "fixed-model", max_tokens: 2048, response_format: { type: "json_object" } });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-server-secret");
  });
  it("rejects malformed JSON and remains usable", async () => {
    const { handler } = fixture();
    const invalid = request("/llm", {});
    const malformed = new Request(invalid.url, { method: "POST", headers: invalid.headers, body: "{" });
    expect((await handler(malformed)).status).toBe(400);
    expect((await handler(request("/llm", { messages: message }))).status).toBe(200);
  });
  it("bounds request size and validates tools/messages", async () => {
    const { handler, fetcher } = fixture();
    expect((await handler(request("/llm", { messages: [{ role: "user", content: "x".repeat(256001) }] }))).status).toBe(413);
    expect((await handler(request("/llm", { messages: [] }))).status).toBe(400);
    expect((await handler(request("/llm", { messages: message, tools: [{}] }))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes upstream failures and handles timeout", async () => {
    const { handler, fetcher } = fixture();
    fetcher.mockImplementation(async () => Response.json({ error: provider.apiKey }, { status: 401 }));
    const res = await handler(request("/llm", { messages: message }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(provider.apiKey);
    fetcher.mockImplementation(async () => { const e = new Error("secret"); e.name = "TimeoutError"; throw e; });
    expect((await handler(request("/llm", { messages: message }))).status).toBe(504);
  });
  it("rate limits paid calls per verified identity", async () => {
    const { handler } = fixture({ requestsPerMinute: 1 });
    expect((await handler(request("/llm", { messages: message }))).status).toBe(200);
    expect((await handler(request("/llm", { messages: message }))).status).toBe(429);
  });
  it("rejects untrusted origins and non-public/unsupported providers", async () => {
    const { handler } = fixture({ saveProvider: vi.fn(), removeProvider: vi.fn() });
    const origin = request("/providers"); origin.headers.set("Origin", "https://untrusted.example");
    expect((await handler(origin)).status).toBe(403);
    for (const patch of [{ baseUrl: "http://127.0.0.1:8000" }, { protocol: "anthropic" }, { baseUrl: "https://user:pass@model.example" }]) {
      expect((await handler(request("/providers", { ...provider, id: "custom", ...patch }))).status).toBe(400);
    }
  });
  it("allows local provider editing without returning the key", async () => {
    const save = vi.fn();
    const { handler } = fixture({ saveProvider: save, removeProvider: vi.fn() });
    const res = await handler(request("/providers", { ...provider, id: "custom" }));
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: provider.apiKey }));
    expect(await res.text()).not.toContain(provider.apiKey);
  });
});
