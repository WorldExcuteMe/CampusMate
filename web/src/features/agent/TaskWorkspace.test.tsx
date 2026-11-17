import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ resume: vi.fn(async () => ({})), cancel: vi.fn(async () => true), decide: vi.fn(async () => {}), get: vi.fn(async () => ({ id: "t1", userId: "u", title: "策划书", status: "queued", usage: { tokens: 0 } })), approvals: vi.fn(async () => [{ id: "a1", taskId: "t1", toolName: "propose_verification", risk: "写入公共核验", status: "pending" }]) }));
vi.mock("@/lib/agent/api-client", () => ({ resumeTask: api.resume, cancelTask: api.cancel, decideApproval: api.decide, getTask: api.get, listApprovals: api.approvals }));
import { TaskWorkspace } from "./TaskWorkspace";
import { newSession, type ChatSession } from "@/lib/agent/sessions";
const session = (reason: string): ChatSession => ({ ...newSession(), currentTaskId: "t1", taskViews: { t1: { task: { id: "t1", userId: "u", title: "策划书", status: reason === "approval_pending" ? "needs_input" : "paused", usage: { tokens: 5, toolCalls: 1, wallMs: 1000, costUsd: 0 }, budget: { tokens: 200000, toolCalls: 1, wallMs: 600000, costUsd: 0.5 }, result: { summary: "部分草稿", artifactIds: [], partial: true, completion: { state: "partial", reason } } }, events: [], lastSeq: 0 } } });
const mount = (s: ChatSession, onTask = vi.fn(), sending = false) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TaskWorkspace session={s} sending={sending} onSelect={() => {}} onTask={onTask} onRefresh={() => {}} onContinue={() => {}} /></QueryClientProvider>);
afterEach(() => { cleanup(); vi.clearAllMocks(); });
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

it("旧失败任务存在后续轮次时保留记录并禁用恢复，最新暂停仍可恢复", async () => {
  const s = session("execution_interrupted");
  s.taskViews!.t1.task.status = "failed"; s.taskViews!.t1.task.turnSeq = 1;
  s.taskViews!.t2 = { ...s.taskViews!.t1, task: { ...s.taskViews!.t1.task, id: "t2", turnSeq: 2, status: "paused" } };
  const view = mount(s);
  expect(screen.queryByRole("button", { name: "恢复任务" })).toBeNull();
  expect(screen.getByText(/后续对话已开始/)).toBeVisible();
  expect(screen.getByRole("button", { name: "用新消息继续" })).toBeVisible();
  view.unmount(); mount({ ...s, currentTaskId: "t2" });
  fireEvent.click(screen.getByRole("button", { name: "恢复任务" }));
  await waitFor(() => expect(api.resume).toHaveBeenCalledWith("t2"));
});

it("新消息尚未回包时显示提交中，不把上轮已完成显示成当前进度", () => {
  const s = session("done"); s.taskViews!.t1.task.status = "succeeded";
  s.pendingTurn = { turnId: "new-turn", content: "new question" };
  const mounted = mount(s, vi.fn(), true);
  expect(screen.getByText(/正在提交新任务/)).toBeVisible();
  expect(screen.getByText(/尚未收到后端确认/)).toBeVisible();
  mounted.unmount(); mount(s);
  expect(screen.queryByText(/正在提交新任务/)).toBeNull();
});

it("legacy cached successes do not display a stale attempt's failure as current state", () => {
  const s = session("completed"); s.taskViews!.t1.task.status = "succeeded"; s.taskViews!.t1.task.error = "HTTP 429 old attempt";
  mount(s);
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  expect(screen.queryByText("HTTP 429 old attempt")).toBeNull();
});

it.each(["paused", "needs_input"] as const)("%s任务提供取消与处理说明，不引导提交会被拒绝的新轮次", async status => {
  const s = session("output_incomplete"); s.taskViews!.t1.task.status = status;
  mount(s);
  expect(screen.queryByRole("button", { name: "用新消息继续" })).toBeNull();
  expect(screen.getByText(/先恢复、处理或取消此任务/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith("t1"));
});
