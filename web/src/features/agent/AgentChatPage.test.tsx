import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from 'sonner';
vi.mock('@/lib/agent/draft-persistence', async original => ({ ...await original<object>(), createDraftPersistence: (await import('@/test-utils/draft-persistence')).uiDraftPersistence }));
import { resetUIDrafts, uiDraftPersistence } from '@/test-utils/draft-persistence';
vi.mock("@/app/auth", () => ({ useRepository: () => ({getProfile:async()=>({id:"alice",major:"计算机",grade:"大二",interests:[],skills:[],goals:[]})}), useAuth: () => ({ session: { user: { id: "alice" } } }) }));
vi.mock("@/app/config", () => ({ repository: { getProfile: async () => ({ id: "alice", major: "计算机", grade: "大二", interests: [], skills: [], goals: [] }) }, supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } } }));
import { SessionsProvider } from "@/lib/agent/sessions-context";
import { AgentChatPage } from "./AgentChatPage";
import { newSession, saveSessions, loadSessions } from "@/lib/agent/sessions";
afterEach(() => { cleanup(); resetUIDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });
it.each(['reasoning_effort', 'deepseek_thinking'])("用户选择high后提交真实task请求，模型和窗口显示使用后端数据 (%s)", async (reasoningProtocol) => {
  localStorage.setItem("campusmate.onboarded", "1");
  vi.stubEnv("VITE_BACKEND_URL", "http://backend.test");
  Element.prototype.scrollIntoView = vi.fn();
  const bodies: Record<string, unknown>[] = [];
  const task = { id: "t1", status: "succeeded", usage: { tokens: 200 }, result: { summary: "策划结果", artifactIds: [] }, promptUsage: { inputTokens: 100, contextLimit: 64000, outputReserve: 2000, source: "reported" }, modelRuntime: { actualModel: "actual-gemma" }, modelConfig: { modelId: "configured-gemma" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown;
    if (url.endsWith("/v1/providers")) body = { providers: [{ id: "custom", displayName: "Gemma", modelId: "configured-gemma", hasKey: true, isDefault: true, capabilities: { reasoning: reasoningProtocol, ...(reasoningProtocol === 'deepseek_thinking' ? { thinking: false } : {}) } }] };
    else if (url.endsWith("/v1/sessions")) body = { session: { id: JSON.parse(init!.body as string).id } };
    else if (url.endsWith("/v1/tasks")) { bodies.push(JSON.parse(init!.body as string)); body = { taskId: "t1", status: "queued" }; }
    else if (url.includes("/events?")) body = { events: [] };
    else if (url.includes("/tasks") && url.includes("/sessions/")) body = { tasks: [task] };
    else body = { task };
    return { ok: true, text: async () => JSON.stringify(body) };
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  await screen.findByText("Gemma");
  expect(screen.getByRole('combobox', { name: '思考强度' })).toBeEnabled();
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
it("业务工具结束后刷新通知、待办和画像缓存，失败任务也同步已提交的部分结果", async () => {
  localStorage.setItem("campusmate.onboarded", "1"); vi.stubEnv("VITE_BACKEND_URL", "http://backend.test"); Element.prototype.scrollIntoView = vi.fn();
  const session = { ...newSession(), backendId: "business-session", currentTaskId: "business-task" }; saveSessions([session], "alice");
  const task = { id: "business-task", status: "failed", usage: { tokens: 2 }, result: { summary: "部分保存，后续步骤未完成", partial: true, artifactIds: [] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, text: async () => JSON.stringify(url.endsWith("/v1/providers") ? { providers: [] } : url.includes("/events?") ? { events: [{ id: 1, taskId: task.id, seq: 1, type: "tool.result", payload: { name: "create_daily_task", ok: true }, createdAt: 1 }] } : url.includes("/sessions/") ? { tasks: [task] } : { task }) })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(<QueryClientProvider client={client}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  await screen.findByText("部分保存，后续步骤未完成");
  for (const name of ["inbox", "tasks", "profile"]) await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: [name] }));
  const count = invalidate.mock.calls.length;
  view.rerender(<QueryClientProvider client={client}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  expect(invalidate.mock.calls.length).toBe(count);
});

it('编辑消息作为新turn提交，保留原消息、已有任务和输入框草稿', async () => {
  localStorage.setItem('campusmate.onboarded', '1'); vi.stubEnv('VITE_BACKEND_URL', 'http://backend.test'); Element.prototype.scrollIntoView = vi.fn();
  const original = { role: 'user' as const, content: '原始请求', turnId: 'original-turn' };
  saveSessions([{ ...newSession(), backendId: 'edit-session', messages: [original, { role: 'assistant', content: '原始回复', taskId: 'old-task' }] }], 'alice');
  const bodies: any[] = [];
  const task = { id: 'edited-task', userId: 'alice', title: '修改后的请求', status: 'succeeded', usage: { tokens: 2 }, result: { summary: '修改后回复', artifactIds: [] } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const data = url.endsWith('/v1/providers') ? { providers: [{ id: 'builtin', displayName: '测试模型', modelId: 'fixture', hasKey: true }] } : url.endsWith('/v1/sessions') ? { session: { id: 'edit-session' } } : url.endsWith('/v1/tasks') ? (bodies.push(JSON.parse(String(init?.body))), { taskId: task.id, status: 'queued' }) : url.includes('/events?') ? { events: [] } : url.includes('/sessions/') ? { tasks: [] } : { task };
    return { ok: true, text: async () => JSON.stringify(data) };
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  await screen.findByText('测试模型');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '尚未发送的草稿' } });
  fireEvent.click(screen.getByRole('button', { name: '编辑第 1 条消息' }));
  fireEvent.change(screen.getByRole('textbox', { name: '编辑消息内容' }), { target: { value: '修改后的请求' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并重发' }));
  await screen.findByText('修改后回复');
  expect(bodies).toHaveLength(1); expect(bodies[0].intent).toBe('修改后的请求'); expect(bodies[0].turnId).not.toBe('original-turn');
  expect(screen.getByRole('textbox')).toHaveValue('尚未发送的草稿');
  expect(screen.getByText('原始请求')).toBeVisible(); expect(screen.getByText('原始回复')).toBeVisible();
  const saved = loadSessions('alice')[0]; expect(saved.messages[0]).toEqual(original); expect(saved.messages.find(m => m.content === '修改后的请求')?.editedFrom).toBe(1);
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

it.each(['picker', 'drop', 'paste'])('图片超限在%s入口明确提示，整批不添加且保留已有文字', async entry => {
  localStorage.setItem('campusmate.onboarded', '1'); vi.stubEnv('VITE_BACKEND_URL', ''); Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ providers: [] }) })));
  const error = vi.spyOn(toast, 'error').mockReturnValue('fixture-toast');
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  const input = screen.getByRole('textbox'); await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: '保留我的文字' } });
  const files = Array.from({ length: 6 }, (_, i) => new File(['image'], `${i}.png`, { type: 'image/png' }));
  if (entry === 'picker') fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files } });
  else if (entry === 'paste') fireEvent.paste(input, { clipboardData: { files } });
  else fireEvent.drop(input, { dataTransfer: { files } });
  await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/最多 4 张图片.*6 张/)));
  expect(input).toHaveValue('保留我的文字'); expect(view.container.querySelectorAll('img')).toHaveLength(0);
  expect(screen.getByText(/每条消息最多 4 张图片 · 最多8个附件/)).toBeVisible();
});

it('旧版6图草稿发送前被拦截，未发起模型请求且原稿完整保留', async () => {
  localStorage.setItem('campusmate.onboarded', '1'); vi.stubEnv('VITE_BACKEND_URL', ''); Element.prototype.scrollIntoView = vi.fn();
  const session = newSession(); saveSessions([session], 'alice');
  const draft = { text: '必须看全6张', attachments: Array.from({ length: 6 }, (_, i) => ({ id: `legacy-${i}`, name: `${i}.png`, kind: 'image' as const, status: 'ready' as const, dataUrl: 'data:image/png;base64,Zml4dHVyZQ==' })) };
  await uiDraftPersistence().write('alice', session.id, draft, 0, 'seed', 'seed');
  const fetcher = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ providers: [] }) })); vi.stubGlobal('fetch', fetcher);
  const error = vi.spyOn(toast, 'error').mockReturnValue('fixture-toast');
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SessionsProvider><AgentChatPage /></SessionsProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(draft.text));
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(error).toHaveBeenCalledWith(expect.stringMatching(/最多 4 张图片.*6 张/));
  expect(screen.getByRole('textbox')).toHaveValue(draft.text); expect(view.container.querySelectorAll('img')).toHaveLength(6);
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes('/llm') && !String(url).includes('/tasks'))).toBe(true);
  expect((await uiDraftPersistence().read('alice', session.id)).current.draft).toEqual(draft);
});
