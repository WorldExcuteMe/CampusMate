import { afterEach, describe, it, expect, vi } from "vitest";
import { BrowserProvider } from "../llm/browser";
import { ProxyProvider, llmChat } from "../llm/proxy";
import { configureAiAuth } from "../llm/transport";
import { ruleExtract } from "../llm/mock";

const req = { task: "inbox.extract", input: { rawText: "程序设计大赛通知", sourceUrl: null, sourceType: "text" as const } };
const provider = { id: "custom", name: "custom", hasKey: true, protocol: "openai", baseUrl: "https://example.com", model: "test" };
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); configureAiAuth(async () => null); });
function fixture(content: string) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).endsWith("/providers")
    ? Response.json({ providers: [provider], mutable: false })
    : Response.json({ choices: [{ message: { content } }], model: "test-model", usage: { prompt_tokens: 7, completion_tokens: 4 } }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
describe("browser AI adapter", () => {
  it("uses configured server extraction instead of hard-wired Mock", async () => {
    const fetcher = fixture(JSON.stringify(ruleExtract(req.input.rawText, null)));
    localStorage.setItem("campusmate.providerId", "custom");
    const result = await new BrowserProvider().extractNotice(req);
    expect(result).toMatchObject({ mock: false, provider: "server-proxy", model: "test-model" });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({ providerId: "custom" });
  });
  it("marks invalid structured output as Mock while retaining actual token usage", async () => {
    fixture('{"category":"daily"}');
    expect(await new ProxyProvider("custom").extractNotice(req)).toMatchObject({ mock: true, provider: "mock-fallback", model: "rule-based-mock", tokenUsage: { input: 7, output: 4 } });
  });
  it("falls back explicitly when the server is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await new BrowserProvider().extractNotice(req)).toMatchObject({ mock: true, provider: "mock" });
  });
  it("forwards the current auth token and tools to the canonical Function endpoint", async () => {
    const fetcher = fixture("ok");
    configureAiAuth(async () => "current-user-token");
    const tools = [{ type: "function" as const, function: { name: "test", description: "fixture", parameters: {} } }];
    await llmChat({ messages: [{ role: "user", content: "hi" }], tools });
    expect(fetcher.mock.calls[0][0]).toBe("/api/llm");
    const init = fetcher.mock.calls[0][1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer current-user-token");
    expect(JSON.parse(String(init.body)).tools).toEqual(tools);
  });
});
