import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/auth", () => ({ useRepository: () => ({getProfile:async()=>({id:"alice",major:"计算机",grade:"大二",interests:[],skills:[],goals:[]})}), useAuth: () => ({ session: { user: { id: "alice" } } }) }));
vi.mock("@/app/config", () => ({ repository: { getProfile: async () => ({ id: "alice", major: "计算机", grade: "大二", interests: [], skills: [], goals: [] }) }, supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } } }));
import { SessionsProvider } from "@/lib/agent/sessions-context";
import { AgentChatPage } from "./AgentChatPage";
import { newSession, saveSessions, loadSessions } from "@/lib/agent/sessions";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });
it("用户选择high后提交真实task请求，模型和窗口显示使用后端数据", async () => {
  localStorage.setItem("campusmate.onboarded", "1");
  vi.stubEnv("VITE_BACKEND_URL", "http://backend.test");
  Element.prototype.scrollIntoView = vi.fn();
  const bodies: Record<string, unknown>[] = [];
  const task = { id: "t1", status: "succeeded", usage: { tokens: 200 }, result: { summary: "策划结果", artifactIds: [] }, promptUsage: { inputTokens: 100, contextLimit: 64000, outputReserve: 2000, source: "reported" }, modelRuntime: { actualModel: "actual-gemma" }, modelConfig: { modelId: "configured-gemma" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (url.endsWith("/v1/providers")) body = { providers: [{ id: "custom", displayName: "Gemma", modelId: "configured-gemma", hasKey: true, isDefault: true, capabilities: { reasoning: "reasoning_effort" } }] };
    else if (url.endsWith("/v1/sessions")) body = { session: { id: JSON.parse(init!.body as string).id } };
    else if (url.endsWith("/v1/tasks")) { bodies.push(JSON.parse(init!.body as string)); body = { taskId: "t1", status: "queued" }; }
    else if (url.includes("/events?")) body = { events: [] };
    else if (url.includes("/tasks") && url.includes("/sessions/")) body = { tasks: [task] };
    else body = { task };
    return { ok: true, text: async () => JSON.stringify(body) };
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  await screen.findByText("Gemma");
  fireEvent.change(screen.getByRole("combobox", { name: "思考强度" }), { target: { value: "high" } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "帮我制定竞赛策划书" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await screen.findByText("策划结果");
  expect(bodies[0]).toEqual(expect.objectContaining({ providerId: "custom", reasoning: "high", intent: "帮我制定竞赛策划书" }));
  expect(bodies[0].sessionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(bodies[0]).not.toHaveProperty("history");
  await waitFor(() => expect(screen.getByText(/最近返回：actual-gemma/)).toBeVisible());
  expect(screen.getByText(/窗口输入 100 \/ 64,000/)).toBeVisible();
});
it("刷新后从后端会话关联重新读取事件及结果，不新建任务或重复计量", async () => {
  localStorage.setItem("campusmate.onboarded", "1"); vi.stubEnv("VITE_BACKEND_URL", "http://backend.test"); Element.prototype.scrollIntoView = vi.fn();
  const s = { ...newSession(), backendId: crypto.randomUUID(), currentTaskId: "restored", messages: [{ role: "user" as const, content: "推荐竞赛", turnId: "turn-restored" }] };
  saveSessions([s], "alice");
  const task = { id: "restored", userId: "alice", title: "推荐竞赛", turnId: "turn-restored", status: "succeeded", usage: { tokens: 12, toolCalls: 1, wallMs: 1000, costUsd: 0 }, result: { summary: "恢复后的结果", artifactIds: [] } };
  const requests: { url: string; method?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method }); let body: unknown;
    if (url.endsWith("/providers")) body = { providers: [] };
    else if (url.includes("/sessions/") && url.endsWith("/tasks")) body = { tasks: [{ ...task, status: "running", result: undefined }] };
    else if (url.includes("/events?")) body = { events: [{ id: 1, taskId: "restored", seq: 1, type: "tool.called", payload: { name: "web_search", callInstanceId: "c1" }, createdAt: 1 }, { id: 2, taskId: "restored", seq: 2, type: "tool.result", payload: { name: "web_search", callInstanceId: "c1", ok: true, summary: "返回2条结果", sourceUrls: ["https://school.example/news"] }, createdAt: 2 }] };
    else body = { task };
    return { ok: true, text: async () => JSON.stringify(body) };
  }));
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  expect(await screen.findByText("恢复后的结果")).toBeVisible();
  expect(screen.getByText("检索公开资料")).toBeVisible();
  expect(screen.getByRole("link", { name: /school.example/ })).toHaveAttribute("href", "https://school.example/news");
  await waitFor(() => expect(loadSessions("alice")[0].tokens).toBe(12));
  expect(screen.getAllByText("恢复后的结果")).toHaveLength(1);
  expect(requests.some((r) => r.method === "POST")).toBe(false);
  view.unmount();
});
it("现有浏览器开发路径也显示真实工具等待及结果，并标明恢复边界", async () => {
  localStorage.setItem("campusmate.onboarded", "1"); vi.stubEnv("VITE_BACKEND_URL", ""); Element.prototype.scrollIntoView = vi.fn();
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let round = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    let body: unknown;
    if (url === "/api/providers") body = { providers: [{ id: "builtin-deepseek", name: "Gemma", model: "configured-gemma", hasKey: true, isDefault: true }] };
    else if (url === "/api/llm") body = { model: "actual-gemma", choices: [{ message: round++ === 0 ? { content: "", tool_calls: [{ id: "local-call", type: "function", function: { name: "web_search", arguments: '{"query":"竞赛"}' } }] } : { content: "本地检索结果", tool_calls: [] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    else { await gate; body = { results: [] }; }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  await screen.findByText("Gemma");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "帮我搜索竞赛" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect((await screen.findAllByText("检索公开资料")).length).toBeGreaterThan(0);
  expect(screen.getAllByText("正在执行").length).toBeGreaterThan(0);
  release();
  expect(await screen.findByText("本地检索结果")).toBeVisible();
  expect(screen.getByText(/浏览器开发记录/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "恢复任务" })).toBeNull();
});
