import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoOpportunities } from "@/demo/seed";
import { RadarPage } from "../RadarPage";
import { OpportunityDetailPage } from "../OpportunityDetailPage";

const mocks = vi.hoisted(() => ({ list: vi.fn(), createTask: vi.fn() }));
vi.mock("@/lib/use-beijing-day", () => ({ useBeijingDay: () => "2026-11-14" }));
vi.mock("@/app/auth", () => ({ useRepository: () => ({
  listOpportunities: mocks.list, getOpportunity: async (id: string) => (await mocks.list()).find((o: { id: string }) => o.id === id),
  listReports: async () => [], createTask: mocks.createTask,
}) }));
const fixture = (id: string, deadline: string | null, status = "active") => ({ ...demoOpportunities[0], id, title: id, deadline, status });
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([
    fixture("有效测试", "2026-11-14"), fixture("过期测试", "2025-11-25"),
    fixture("未知测试", null), fixture("坏日期测试", "2026-02-30"), fixture("归档测试", "2027-01-01", "archived"),
  ]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); client.clear(); });
function mount(url = "/app/radar") {
  return render(<MemoryRouter initialEntries={[url]}><QueryClientProvider client={client}><Routes>
    <Route path="/app/radar" element={<RadarPage />} /><Route path="/app/radar/:id" element={<OpportunityDetailPage />} />
  </Routes></QueryClientProvider></MemoryRouter>);
}
describe("Radar expiry views", () => {
  it("defaults to known active dates, retains historical and unknown entries, combines search", async () => {
    mount();
    expect(await screen.findByRole("link", { name: /有效测试/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /过期测试|未知测试|坏日期测试|归档测试/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "已过期（1）" }));
    expect(screen.getByRole("link", { name: /过期测试/ })).toBeVisible();
    expect(screen.getByText(/2025-11-25 · 已过期/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "待核实日期（2）" }));
    expect(screen.getAllByRole("link")).toHaveLength(2);
    await userEvent.type(screen.getByPlaceholderText("搜索机会…"), "未知测试");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    await userEvent.clear(screen.getByPlaceholderText("搜索机会…"));
    await userEvent.click(screen.getByRole("button", { name: "已归档（1）" }));
    expect(screen.getByRole("link", { name: /归档测试/ })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "全部（5）" }));
    expect(screen.getAllByRole("link")).toHaveLength(5);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
  it.each(["过期测试", "归档测试"])("keeps %s detail accessible but disables a new participation plan", async (id) => {
    mount(`/app/radar/${id}`);
    expect(await screen.findByRole("button", { name: "创建参与计划" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("历史记录");
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});
