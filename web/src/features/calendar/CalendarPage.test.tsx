vi.mock("@/app/auth",()=>({useAuth:()=>({session:null}),useRepository:()=>({listTasks:mocks.tasks,listOpportunities:mocks.opps})}));
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const mocks = vi.hoisted(() => ({ schedules: vi.fn(), terms: vi.fn(), tasks: vi.fn(), opps: vi.fn() }));
vi.mock("@/app/config", () => ({ runtime: "local", isCloudRuntime: false, supabaseClient: null, repository: { listTasks: mocks.tasks, listOpportunities: mocks.opps } }));
vi.mock("@/lib/agent/api-client", () => ({ backendEnabled: () => true, listTerms: mocks.terms, listSchedules: mocks.schedules, importSchedule: vi.fn(), createTerm: vi.fn(), saveTimeScheme: vi.fn() }));
import { CalendarPage } from "./CalendarPage";
const term = { id: "term", institutionId: "a", name: "秋季学期", startDate: "2026-09-07", endDate: "2027-01-24", totalWeeks: 20, timezone: "Asia/Shanghai" };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-16T09:00:00+08:00"));
  mocks.terms.mockResolvedValue([term]); mocks.opps.mockResolvedValue([]);
  mocks.tasks.mockResolvedValue([{ id: "now", title: "本周截止", dueAt: "2026-11-17", status: "todo" }, { id: "next", title: "下周截止", dueAt: "2026-11-24", status: "todo" }, { id: "done", title: "已经完成", dueAt: "2026-11-17", status: "done" }]);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
it("具体日期截止不在其他周重复，已完成任务不展示", async () => {
  const client = setup(); mocks.schedules.mockResolvedValue({ schedules: [], exceptions: [], schemes: [] });
  render(<QueryClientProvider client={client}><CalendarPage /></QueryClientProvider>);
  await screen.findAllByText(/本周截止/);
  expect(screen.queryByText(/下周截止/)).toBeNull();
  expect(screen.queryByText(/已经完成/)).toBeNull();
});
it("课表读取失败明确报错，不推断全天空闲", async () => {
  const client = setup(); mocks.schedules.mockRejectedValue(new Error("课表服务不可达"));
  render(<QueryClientProvider client={client}><CalendarPage /></QueryClientProvider>);
  expect(await screen.findByText(/课表.*失败/)).toBeVisible();
  expect(screen.queryByText(/08:00-22:00（840分钟）/)).toBeNull();
});
it("查看其他周不清空今天已知的下一项安排",async()=>{
  const client=setup();mocks.tasks.mockResolvedValue([{id:"today",title:"今日重要截止",dueAt:"2026-11-16",status:"todo"}]);
  mocks.schedules.mockResolvedValue({schedules:[],exceptions:[],schemes:[]});
  render(<QueryClientProvider client={client}><CalendarPage/></QueryClientProvider>);
  await screen.findAllByText(/今日重要截止/);
  fireEvent.change(screen.getByLabelText("查看日期"),{target:{value:"2026-11-23"}});
  expect(screen.getByText(/当天截止 · 截止：今日重要截止/)).toBeVisible();
});
