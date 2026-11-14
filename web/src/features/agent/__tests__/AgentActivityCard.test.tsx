import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentActivityCard } from "../AgentActivityCard";
import { progressFromEvent } from "@/lib/agent/progress";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows observed stage, elapsed time and a truthful long-wait notice; clears timer on unmount", () => {
  const activity = { sessionId: "s", startedAt: 1000, stageAt: 1000, progress: { phase: "model" as const, round: 1 } };
  const { rerender, unmount } = render(<AgentActivityCard activity={activity} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在等待模型回复");
  expect(screen.getByLabelText("已等待时间")).toHaveTextContent("0 秒");
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(23_000); });
  expect(screen.getByLabelText("已等待时间")).toHaveTextContent("23 秒");
  expect(screen.getByRole("note")).toHaveTextContent("暂未收到新结果");
  rerender(<AgentActivityCard activity={{ ...activity, stageAt: Date.now(), progress: { phase: "tool", tool: "web_fetch", toolIndex: 2, toolTotal: 3 } }} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在读取网页");
  expect(screen.getByRole("status")).toHaveTextContent("第 2 / 3 个工具");
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  expect(screen.getByLabelText("已等待时间")).toHaveTextContent("23 秒");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("backend stages come from explicit events, not invented model reasoning", () => {
  expect(progressFromEvent({ type: "llm.request", payload: { round: 2 } })).toEqual({ phase: "model", round: 3 });
  expect(progressFromEvent({ type: "tool.called", payload: { name: "list_groups", args: { private: "not-for-ui" } } })).toEqual({ phase: "tool", tool: "list_groups" });
  expect(progressFromEvent({ type: "llm.response", payload: {} })).toBeNull();
});
