import type { Opportunity, Task } from "@/lib/data/types";

const DAY_MS = 86_400_000;
const beijingFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Date-only deadlines remain actionable through the entire Beijing calendar day. */
export function beijingDay(now: Date = new Date()): string {
  const parts = beijingFormatter.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dayNumber(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Date.parse normalizes impossible dates such as February 30; reject those.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms / DAY_MS : null;
}

export function daysUntil(deadline: string | null | undefined, today = beijingDay()): number | null {
  const due = dayNumber(deadline);
  const current = dayNumber(today);
  return due === null || current === null ? null : due - current;
}

export type OpportunityTimeState = "active" | "expired" | "unknown" | "archived";
export const OPPORTUNITY_TIME_LABELS: Record<OpportunityTimeState, string> = {
  active: "有效", expired: "已过期", unknown: "待核实日期", archived: "已归档",
};

/** Derived view only: never overwrites stored status, year or deadline. */
export function opportunityTimeState(
  opportunity: Pick<Opportunity, "deadline" | "status">, today = beijingDay(),
): OpportunityTimeState {
  if (opportunity.status === "archived") return "archived";
  const days = daysUntil(opportunity.deadline, today);
  if (opportunity.status === "expired" || (days !== null && days < 0)) return "expired";
  return days === null ? "unknown" : "active";
}

export function isOpenTask(task: Pick<Task, "status">): boolean {
  return task.status === "todo" || task.status === "in_progress";
}

export function isTaskOverdue(task: Pick<Task, "status" | "dueAt">, today = beijingDay()): boolean {
  const days = daysUntil(task.dueAt, today);
  return isOpenTask(task) && days !== null && days < 0;
}

export function isTaskDueSoon(task: Pick<Task, "status" | "dueAt">, today = beijingDay()): boolean {
  const days = daysUntil(task.dueAt, today);
  return isOpenTask(task) && days !== null && days >= 0 && days <= 7;
}
