import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/auth", () => ({ useAuth: () => ({ session: { user: { id: "alice" } } }) }));
vi.mock("@/app/config", () => ({ repository: { getProfile: async () => ({ id: "alice", major: "计算机", grade: "大二", interests: [], skills: [], goals: [] }) }, supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } } }));
import { SessionsProvider } from "@/lib/agent/sessions-context";
import { AgentChatPage } from "./AgentChatPage";
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
