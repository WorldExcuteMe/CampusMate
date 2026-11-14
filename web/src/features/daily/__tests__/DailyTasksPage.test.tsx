import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/data/types";
const mocks = vi.hoisted(() => ({ listTasks: vi.fn(), updateTask: vi.fn(), error: vi.fn() }));
vi.mock("@/app/auth", () => ({
  useAuth: () => ({ session: null }),
  useRepository: () => ({ mode: "demo", listTasks: mocks.listTasks, updateTask: mocks.updateTask }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: vi.fn() } }));
import { DailyTasksPage } from "../DailyTasksPage";
let task: Task;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  task = { id: "fixture", userId: "demo-user", title: "状态切换测试班会", dueAt: null, status: "done", priority: 65, inboxItemId: null, estimateHours: 1, kind: "daily", createdAt: "2026-11-14", demo: true };
  mocks.listTasks.mockImplementation(async () => [{ ...task }]);
  mocks.updateTask.mockImplementation(async (_id: string, patch: Partial<Task>) => { task = { ...task, ...patch }; return task; });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });
const mount = () => render(<QueryClientProvider client={client}><DailyTasksPage /></QueryClientProvider>);
describe("daily checkbox", () => {
  it("uses the checkbox value to restore todo and then complete again", async () => {
    mount();
    const checkbox = await screen.findByRole("checkbox", { name: "撤销完成 状态切换测试班会" });
    expect(checkbox).toBeChecked();
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(mocks.updateTask).toHaveBeenLastCalledWith("fixture", { status: "todo" });
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(mocks.updateTask).toHaveBeenLastCalledWith("fixture", { status: "done" });
  });
  it("prevents repeated clicks while saving and keeps the old state on failure", async () => {
    let reject!: (e: Error) => void;
    mocks.updateTask.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    mount();
    const checkbox = await screen.findByRole("checkbox", { name: /状态切换测试班会/ });
    await userEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    expect(checkbox).toBeChecked();
    await act(async () => reject(new Error("fixture failure")));
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(checkbox).toBeChecked();
    expect(mocks.error).toHaveBeenCalledWith("更新任务状态失败，请重试");
  });
});
