vi.mock("@/app/auth",()=>({useAuth:()=>({session:null}),useRepository:()=>({listInbox:mock.list})}));
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ruleExtract } from "@/lib/llm/mock";
const mock = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/app/config", () => ({ repository: { listInbox: mock.list } }));
import { InboxPage } from "./InboxPage";
const item = (id: string, title: string, status = "pending_review", cls = "normal") => ({ id, userId: "demo", rawText: title, sourceUrl: "https://school.example/news", sourceType: "text", extracted: ruleExtract(title, null), classification: { class: cls, priorityScore: 50, priorityReason: "按用户相关性排序", riskSignals: [] }, status, createdAt: "2026-11-15T00:00:00Z", demo: true });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function view() { render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InboxPage /></QueryClientProvider></MemoryRouter>); }
it("筛选和搜索真实通知，选择后预览原文和来源，归档默认不混入", async () => {
  mock.list.mockResolvedValue([item("a", "校园创新竞赛报名", "pending_review", "high_value"), item("b", "学费退款风险提醒", "pending_review", "risk"), item("c", "去年归档通知", "archived")]); view();
  await screen.findByRole("button", { name: /预览校园创新竞赛报名/ });
  expect(screen.queryByRole("button", { name: /预览去年归档通知/ })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "退款" } });
  fireEvent.click(screen.getByRole("button", { name: /预览学费退款风险提醒/ }));
  expect(screen.getByRole("link", { name: /打开来源/ })).toHaveAttribute("href", "https://school.example/news");
  expect(screen.getByRole("link", { name: /查看详情并处理/ })).toHaveAttribute("href", "/app/inbox/b");
});
it("读取错误明确显示，允许重试而不是伪装为空收件箱", async () => {
  mock.list.mockRejectedValue(new Error("读取失败")); view(); expect(await screen.findByRole("alert")).toHaveTextContent("读取失败"); expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
});
