import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ resume: vi.fn(async () => ({})), cancel: vi.fn(async () => true), decide: vi.fn(async () => {}), get: vi.fn(async () => ({ id: "t1", userId: "u", title: "策划书", status: "queued", usage: { tokens: 0 } })), approvals: vi.fn(async () => [{ id: "a1", taskId: "t1", toolName: "propose_verification", risk: "写入公共核验", status: "pending" }]) }));
vi.mock("@/lib/agent/api-client", () => ({ resumeTask: api.resume, cancelTask: api.cancel, decideApproval: api.decide, getTask: api.get, listApprovals: api.approvals }));
import { TaskWorkspace } from "./TaskWorkspace";
import { newSession, type ChatSession } from "@/lib/agent/sessions";
const session = (reason: string): ChatSession => ({ ...newSession(), currentTaskId: "t1", taskViews: { t1: { task: { id: "t1", userId: "u", title: "策划书", status: reason === "approval_pending" ? "needs_input" : "paused", usage: { tokens: 5, toolCalls: 1, wallMs: 1000, costUsd: 0 }, budget: { tokens: 200000, toolCalls: 1, wallMs: 600000, costUsd: 0.5 }, result: { summary: "部分草稿", artifactIds: [], partial: true, completion: { state: "partial", reason } } }, events: [], lastSeq: 0 } } });
const mount = (s: ChatSession, onTask = vi.fn()) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TaskWorkspace session={s} onSelect={() => {}} onTask={onTask} onRefresh={() => {}} onContinue={() => {}} /></QueryClientProvider>);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('失败后已确认的成功重试明确标为恢复，检索降质也展示提醒', () => {
  const s = session(''); const view = s.taskViews!.t1; view.task.status = 'succeeded';
  view.events = [
    { seq: 1, type: 'tool.called', taskId: 't1', payload: { name: 'save_opportunity', callInstanceId: 'bad' } },
    { seq: 2, type: 'tool.result', taskId: 't1', payload: { name: 'save_opportunity', callInstanceId: 'bad', ok: false, summary: '参数错误' } },
    { seq: 3, type: 'tool.recovered', taskId: 't1', payload: { callInstanceId: 'bad', recoveredBy: 'good' } },
    { seq: 4, type: 'tool.called', taskId: 't1', payload: { name: 'web_search', callInstanceId: 'search' } },
    { seq: 5, type: 'tool.result', taskId: 't1', payload: { name: 'web_search', callInstanceId: 'search', ok: true, warning: true, summary: '检索匹配不足，暂无可用结果；请换关键词或核对官网' } },
  ].map(e => ({ ...e, id: e.seq, createdAt: 1000 + e.seq }));
  mount(s);
  expect(screen.getByText(/首次失败，后续同一操作已重试成功/)).toBeVisible();
  expect(screen.getByText(/检索匹配不足/)).toBeVisible();
  expect(screen.queryByText('参数错误')).toBeNull();
});
it("预算暂停有独立说明，明确修改后调用恢复API", async () => {
  const changed = vi.fn(); mount(session("budget_exceeded"), changed);
  expect(screen.getByText("需要调整预算")).toBeVisible();
  expect(screen.queryByText(/等待审批/)).toBeNull();
  fireEvent.change(screen.getByLabelText("工具次数"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "调整预算并恢复" }));
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith("t1", expect.objectContaining({ toolCalls: 4 })));
  await waitFor(() => expect(changed).toHaveBeenCalled());
});
it("审批读取真实pending记录，批准后才请求恢复", async () => {
  mount(session("approval_pending"));
  fireEvent.click(await screen.findByRole("button", { name: "批准并继续" }));
  await waitFor(() => expect(api.decide).toHaveBeenCalledWith("a1", "approved"));
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith("t1"));
});
