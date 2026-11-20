vi.mock("@/app/auth",()=>({useAuth:()=>({session:null}),useRepository:()=>({listInbox:async()=>[],listTasks:async()=>[{id:"late",title:"逾期任务",dueAt:"2026-11-10",status:"todo"},{id:"future",title:"未来任务",dueAt:"2026-11-18",status:"todo"}],listOpportunities:async()=>[]})}));
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
vi.mock("@/app/config", () => ({ runtime: "local", isCloudRuntime: false, supabaseClient: null, repository: { listInbox: async () => [], listTasks: async () => [{ id: "late", title: "逾期任务", dueAt: "2026-11-10", status: "todo" }, { id: "future", title: "未来任务", dueAt: "2026-11-18", status: "todo" }], listOpportunities: async () => [], updateTask: vi.fn() } }));
vi.mock("@/lib/agent/api-client", () => ({ backendEnabled: () => true, listTerms: async () => [{ id: "t", name: "秋", startDate: "2026-09-07", endDate: "2027-01-24", totalWeeks: 20, timezone: "Asia/Shanghai" }], listSchedules: async () => ({ schedules: [{ id: "math", courseName: "今日数学", weekday: 1, startTime: "08:00", endTime: "09:40", startWeek: 1, endWeek: 20, weekPattern: "every" }], exceptions: [], schemes: [] }) }));
import { DashboardPage } from "./DashboardPage";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("Today读取真实今日课程与下一项，逾期不计未来七天", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-16T07:00:00+08:00"));
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DashboardPage /></QueryClientProvider></MemoryRouter>);
  expect((await screen.findAllByText("今日数学")).length).toBe(2);
  expect(screen.getByText("今日待办 0 · 逾期待处理 1")).toBeVisible();
  const stat = screen.getByText("7 天内截止").closest("a"); expect(stat?.textContent).toContain("1");
});
