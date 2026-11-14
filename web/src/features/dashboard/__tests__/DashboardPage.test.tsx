import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/data/types";
const mocks = vi.hoisted(() => ({ listTasks: vi.fn(), updateTask: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("@/app/auth", () => ({ useRepository: () => ({
  mode: "demo", listTasks: mocks.listTasks, updateTask: mocks.updateTask,
  listInbox: async () => [], listOpportunities: async () => [],
}) }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock("@/lib/use-beijing-day", () => ({ useBeijingDay: () => "2026-11-14" }));
import { DashboardPage } from "../DashboardPage";
let task: Task;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  task = { id: "fixture", userId: "demo-user", title: "确认测试任务", dueAt: null, status: "todo", priority: 65, inboxItemId: null, estimateHours: 1, kind: "daily", createdAt: "2026-11-14", demo: true };
  mocks.listTasks.mockImplementation(async () => [{ ...task }]);
  mocks.updateTask.mockImplementation(async (_id: string, patch: Partial<Task>) => { task = { ...task, ...patch }; return task; });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });
const mount = () => render(<MemoryRouter><QueryClientProvider client={client}><DashboardPage /></QueryClientProvider></MemoryRouter>);
describe("Today completion confirmation", () => {
  it("counts 0..7 day open tasks, separates overdue and preserves closed history", async () => {
    mocks.listTasks.mockResolvedValue([
      { ...task, id: "old", title: "旧待办", dueAt: "2026-11-13" },
      { ...task, id: "today", title: "今天待办", dueAt: "2026-11-14" },
      { ...task, id: "seven", title: "七天待办", dueAt: "2026-11-21" },
      { ...task, id: "eight", title: "八天待办", dueAt: "2026-11-22" },
      { ...task, id: "done", dueAt: "2026-11-10", status: "done" },
      { ...task, id: "cancelled", dueAt: "2026-11-15", status: "cancelled" },
    ]);
    mount();
    await screen.findByText("旧待办");
    expect(within(screen.getByRole("link", { name: "2 7 天内截止" })).getByText("2")).toBeVisible();
    expect(screen.getByRole("link", { name: "1 已逾期待处理" })).toHaveAttribute("href", "/app/growth?view=overdue");
    expect(screen.queryByRole("checkbox", { name: "完成 旧待办" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "完成 今天待办" })).toBeVisible();
    expect(mocks.updateTask).not.toHaveBeenCalled();
  });
  it("does not write before confirmation; cancelling keeps the todo; confirming writes once", async () => {
    mount();
    const checkbox = await screen.findByRole("checkbox", { name: "完成 确认测试任务" });
    await userEvent.click(checkbox);
    expect(screen.getByRole("alertdialog", { name: "确认完成任务？" })).toBeVisible();
    expect(checkbox).not.toBeChecked(); expect(mocks.updateTask).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(mocks.updateTask).not.toHaveBeenCalled(); expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.updateTask).toHaveBeenCalledExactlyOnceWith("fixture", { status: "done" });
    expect(screen.queryByRole("checkbox", { name: /确认测试任务/ })).not.toBeInTheDocument();
  });
  it("locks confirmation while saving and preserves the dialog and task after failure", async () => {
    let reject!: (e: Error) => void;
    mocks.updateTask.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    mount();
    await userEvent.click(await screen.findByRole("checkbox", { name: /确认测试任务/ }));
    await userEvent.click(screen.getByRole("button", { name: "确认完成" }));
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => reject(new Error("fixture failure")));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认完成" })).toBeEnabled());
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(task.status).toBe("todo");
    expect(mocks.error).toHaveBeenCalledWith("完成任务失败，请重试");
  });
});
