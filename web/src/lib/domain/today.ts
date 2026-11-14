// Today 首页选择器：今日课程 / 今日待办 / 临近截止 / 重要通知 / 推荐机会。
// 纯逻辑，从真实 repository 数据派生。

export interface TaskLike { id: string; title: string; dueAt: string | null; status: string; priority?: number; }
export interface InboxLike { id: string; title: string; priority?: number; class?: string; createdAt?: string; }
export interface OppLike { id: string; title: string; deadline?: string | null; matchScore?: number; status?: string; }
import { activeTask, deadlineInstant, localParts } from "../../../../shared/calendar";

const DAY = 86_400_000;

export function todayTasks(tasks: TaskLike[], now = Date.now(), timezone = "Asia/Shanghai"): TaskLike[] {
  const today = localParts(now, timezone).date;
  return tasks.filter((t) => activeTask(t.status) && t.dueAt && Number.isFinite(deadlineInstant(t.dueAt, timezone)) && localParts(deadlineInstant(t.dueAt, timezone), timezone).date === today)
    .sort((a, b) => (Date.parse(a.dueAt!) - Date.parse(b.dueAt!)) || ((b.priority ?? 0) - (a.priority ?? 0)));
}

export function upcomingDeadlines(tasks: TaskLike[], days = 7, now = Date.now(), timezone = "Asia/Shanghai"): TaskLike[] {
  const limit = now + days * DAY;
  return tasks.filter((t) => activeTask(t.status) && t.dueAt && deadlineInstant(t.dueAt, timezone) >= now && deadlineInstant(t.dueAt, timezone) <= limit)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
}

export function overdueTasks(tasks: TaskLike[], now = Date.now(), timezone = "Asia/Shanghai"): TaskLike[] { return tasks.filter((t) => activeTask(t.status) && t.dueAt && deadlineInstant(t.dueAt, timezone) < now).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!)); }

export function importantNotices(inbox: InboxLike[], limit = 5): InboxLike[] {
  return [...inbox].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).slice(0, limit);
}

export function recommendedOpportunities(opps: OppLike[], limit = 5, now = Date.now()): OppLike[] {
  return opps.filter((o) => !["archived", "expired", "cancelled"].includes(o.status ?? "") && (!o.deadline || deadlineInstant(o.deadline, "Asia/Shanghai") >= now))
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0)).slice(0, limit);
}

export interface TodaySummary { courses: number; tasks: TaskLike[]; deadlines: TaskLike[]; notices: InboxLike[]; opportunities: OppLike[]; }

export function buildToday(opts: { courseCount: number; tasks: TaskLike[]; inbox: InboxLike[]; opps: OppLike[]; now?: number }): TodaySummary {
  const now = opts.now ?? Date.now();
  return {
    courses: opts.courseCount,
    tasks: todayTasks(opts.tasks, now),
    deadlines: upcomingDeadlines(opts.tasks, 7, now),
    notices: importantNotices(opts.inbox),
    opportunities: recommendedOpportunities(opts.opps, 5, now),
  };
}
