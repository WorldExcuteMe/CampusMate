import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beijingDay, daysUntil, isTaskDueSoon, isTaskOverdue, opportunityTimeState } from "../time-policy";
import { useBeijingDay } from "../use-beijing-day";
import { DeadlineTag } from "@/components/shared";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Beijing calendar deadline policy", () => {
  it("uses Beijing midnight, not UTC or the host's calendar", () => {
    expect(beijingDay(new Date("2026-11-14T15:59:59Z"))).toBe("2026-11-14");
    expect(beijingDay(new Date("2026-11-14T16:00:00Z"))).toBe("2026-11-15");
    expect(daysUntil("2026-11-14", "2026-11-14")).toBe(0);
    expect(daysUntil("2026-11-14", "2026-11-15")).toBe(-1);
    expect(daysUntil("2028-02-29", "2028-02-28")).toBe(1);
  });
  it.each([null, "", "2026-02-30", "2026-13-01", "2026-11-14T12:00:00Z", "not-a-date"])("keeps invalid or absent deadline %s unknown", (deadline) => {
    expect(daysUntil(deadline, "2026-11-14")).toBeNull();
    expect(opportunityTimeState({ deadline, status: "active" }, "2026-11-14")).toBe("unknown");
  });
  it("honors stored expired/archived states and never rewrites old years", () => {
    expect(opportunityTimeState({ deadline: "2025-11-25", status: "active" }, "2026-11-14")).toBe("expired");
    expect(opportunityTimeState({ deadline: "2026-11-14", status: "active" }, "2026-11-14")).toBe("active");
    expect(opportunityTimeState({ deadline: "2027-01-01", status: "expired" }, "2026-11-14")).toBe("expired");
    expect(opportunityTimeState({ deadline: "2025-01-01", status: "archived" }, "2026-11-14")).toBe("archived");
  });
  it("separates overdue from inclusive 0..7 day deadlines and excludes closed tasks", () => {
    const task = { status: "todo" as const, dueAt: "2026-11-13" };
    expect(isTaskOverdue(task, "2026-11-14")).toBe(true);
    expect(isTaskDueSoon(task, "2026-11-14")).toBe(false);
    for (const dueAt of ["2026-11-14", "2026-11-21"]) expect(isTaskDueSoon({ ...task, dueAt }, "2026-11-14")).toBe(true);
    for (const dueAt of ["2026-11-22", null, "bad"]) expect(isTaskDueSoon({ ...task, dueAt }, "2026-11-14")).toBe(false);
    for (const status of ["done", "cancelled"] as const) {
      expect(isTaskOverdue({ ...task, status }, "2026-11-14")).toBe(false);
      expect(isTaskDueSoon({ dueAt: "2026-11-14", status }, "2026-11-14")).toBe(false);
    }
  });
  it("rolls over mounted views at midnight with one timer and cleans it on unmount", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T15:59:59Z"));
    const Today = () => <p>{useBeijingDay()}</p>;
    const { unmount } = render(<><Today /><DeadlineTag deadline="2026-11-14" /><DeadlineTag deadline="2026-11-15" /></>);
    expect(screen.getByText("截止 2026-11-14 · 剩 0 天")).toBeVisible();
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.getByText("2026-11-15")).toBeVisible();
    expect(screen.getByText("截止 2026-11-14 · 已过期")).toBeVisible();
    expect(screen.getByText("截止 2026-11-15 · 剩 0 天")).toBeVisible();
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("refreshes after a suspended tab regains focus", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
    render(<DeadlineTag deadline="2026-11-14" pastLabel="已逾期" />);
    act(() => { vi.setSystemTime(new Date("2026-11-16T12:00:00Z")); window.dispatchEvent(new Event("focus")); });
    expect(screen.getByText("截止 2026-11-14 · 已逾期")).toBeVisible();
  });
});
