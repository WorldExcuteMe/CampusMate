// 四条端到端个性化工作流。组合真实组件（personal-context/schedule-import/planner/evaluator/verification）。
// 结构化输入输出 + 验收 + 持久化 + 权限；副作用操作（报名/提交）须审批，工作流只产建议/计划。
import type { PersonalContextStore, InstitutionProfile, AcademicTerm, CourseSchedule } from "./personal-context.ts";
import { occursInWeek } from "./personal-context.ts";
import { previewImport } from "./schedule-import.ts";
import { planGoal, validateDag, type Plan } from "./planner.ts";
import { detectConflict } from "./verification.ts";

// ── E1 Personal Campus Onboarding ──
export interface OnboardingInput {
  userId: string; university: string; major: string; grade: string;
  term: { name: string; startDate: string; endDate: string; totalWeeks: number };
  schedule: { format: "ics" | "csv" | "xlsx"; data: string };
  sources?: { kind: "academic_system" | "campus_website" | "student_group" | "official_account"; name: string; url?: string }[];
  confirm?: boolean;
}
export interface OnboardingResult { status: "needs_confirm" | "completed"; preview: { count: number; errors: string[]; duplicates: number }; termId?: string; savedSchedules?: number; }

export async function onboarding(store: PersonalContextStore, input: OnboardingInput): Promise<OnboardingResult> {
  const preview = previewImport(input.schedule.format, input.schedule.data, input.term.startDate, input.term.totalWeeks);
  if (!input.confirm) return { status: "needs_confirm", preview: { count: preview.schedules.length, errors: preview.errors, duplicates: preview.duplicates } };
  await store.setProfile({ userId: input.userId, university: input.university, major: input.major, grade: input.grade, interests: [], skills: [], goals: [], preferences: {}, updatedAt: Date.now() });
  const term = await store.createTerm({ userId: input.userId, institutionId: input.university, name: input.term.name, startDate: input.term.startDate, endDate: input.term.endDate, totalWeeks: input.term.totalWeeks, timezone: "Asia/Shanghai" });
  const saved = await store.saveSchedules(input.userId, term.id, preview.schedules.map((s) => ({ ...s, courseId: "" })));
  for (const s of input.sources ?? []) await store.addSource({ userId: input.userId, kind: s.kind, name: s.name, url: s.url, enabled: true });
  return { status: "completed", preview: { count: preview.schedules.length, errors: preview.errors, duplicates: preview.duplicates }, termId: term.id, savedSchedules: saved.length };
}

// ── E2 Intelligent Campus Inbox ──
export interface InboxInput { userId: string; title: string; rawText: string; category: string; deadline?: string | null; isOpportunity?: boolean; profile?: InstitutionProfile; schedules?: CourseSchedule[]; week?: number; }
export interface InboxResult { objects: { kind: string; title: string; dueAt?: string | null }[]; priority: number; conflicts: string[]; needsConfirm: boolean; }

export function intelligentInbox(input: InboxInput): InboxResult {
  const objects: InboxResult["objects"] = [{ kind: "information", title: input.title }];
  // 优先级：截止紧迫度 + 机会加权。
  let priority = 50;
  if (input.deadline) { const days = Math.ceil((Date.parse(input.deadline) - Date.now()) / 86400000); priority += days <= 3 ? 40 : days <= 7 ? 20 : 0; }
  if (input.isOpportunity) priority += 10;
  // 时间冲突：截止日与课程（简化：截止日星期有课则提示）。
  const conflicts: string[] = [];
  if (input.deadline && input.schedules?.length) {
    const wd = new Date(input.deadline).getDay() || 7;
    const week = input.week ?? 1;
    if (input.schedules.some((s) => s.weekday === wd && occursInWeek(s, week))) conflicts.push(`截止日（周${wd}）有课程，注意时间安排`);
  }
  if (input.isOpportunity) {
    objects.push({ kind: "opportunity", title: input.title });
    if (input.deadline) { objects.push({ kind: "task", title: `报名：${input.title}`, dueAt: input.deadline }); objects.push({ kind: "event", title: `截止：${input.title}`, dueAt: input.deadline }); }
  } else if (input.deadline) {
    objects.push({ kind: "task", title: input.title, dueAt: input.deadline });
  }
  return { objects, priority: Math.min(100, priority), conflicts, needsConfirm: true };
}

// ── E3 Personalized Opportunity Discovery ──
export interface OpportunityInput { profile: InstitutionProfile; opportunities: { id: string; title: string; type: string; deadline?: string | null; minGrade?: string; skills?: string[]; sourceUrl?: string; verified?: boolean }[]; schedules?: CourseSchedule[]; week?: number; }
export interface OpportunityRecommendation { id: string; title: string; score: number; eligible: boolean; matchReasons: string[]; timeConflict: boolean; verified: boolean; sourceUrl?: string; }
export interface DiscoveryResult { recommendations: OpportunityRecommendation[]; }

const GRADE_ORDER = ["大一", "大二", "大三", "大四", "研一", "研二", "研三"];
function gradeRank(g: string): number { const i = GRADE_ORDER.indexOf(g); return i < 0 ? 0 : i; }

export function opportunityDiscovery(input: OpportunityInput): DiscoveryResult {
  const recs: OpportunityRecommendation[] = input.opportunities.map((o) => {
    const reasons: string[] = [];
    let score = 0;
    const eligible = !o.minGrade || gradeRank(input.profile.grade) >= gradeRank(o.minGrade);
    if (!eligible) reasons.push(`年级不符（需${o.minGrade}）`);
    // 技能匹配
    const skillHits = (o.skills ?? []).filter((s) => input.profile.skills.includes(s));
    score += skillHits.length * 25;
    if (skillHits.length) reasons.push(`技能匹配：${skillHits.join("、")}`);
    // 兴趣/专业匹配
    if (input.profile.interests.some((i) => o.title.includes(i))) { score += 20; reasons.push("兴趣相关"); }
    if (input.profile.major && o.title.includes(input.profile.major)) { score += 15; reasons.push("专业相关"); }
    // 时间冲突
    let timeConflict = false;
    if (o.deadline && input.schedules?.length) { const wd = new Date(o.deadline).getDay() || 7; timeConflict = input.schedules.some((s) => s.weekday === wd && occursInWeek(s, input.week ?? 1)); }
    if (o.verified) score += 10;
    return { id: o.id, title: o.title, score, eligible, matchReasons: reasons, timeConflict, verified: Boolean(o.verified), sourceUrl: o.sourceUrl };
  });
  recs.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
  return { recommendations: recs };
}

// ── E4 Personal Weekly Planning ──
export interface WeeklyPlanInput { userId: string; goal: string; schedules: CourseSchedule[]; tasks: { id: string; title: string; dueAt?: string | null; estimateHours?: number }[]; week: number; }
export interface WeeklyPlanResult { plan: Plan; allocations: { taskTitle: string; weekday: number; startTime: string; endTime: string }[]; conflicts: string[]; acceptancePassed: boolean; freeMinutes: number; }

function toMin(t: string): number { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function fmt(m: number): string { return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; }

export function weeklyPlanning(input: WeeklyPlanInput): WeeklyPlanResult {
  const plan = planGoal(input.goal, "plan");
  const dagOk = validateDag(plan.steps).ok;
  // 计算本周空闲（08:00-22:00，扣除本周课程）。
  const allocations: WeeklyPlanResult["allocations"] = [];
  const conflicts: string[] = [];
  let freeMinutes = 0;
  const weekCourses = input.schedules.filter((s) => occursInWeek(s, input.week));
  const pending = input.tasks.filter((t) => t.dueAt);
  let taskIdx = 0;
  for (let d = 1; d <= 7 && taskIdx < pending.length; d++) {
    const busy = weekCourses.filter((s) => s.weekday === d).map((s) => [toMin(s.startTime), toMin(s.endTime)] as [number, number]).sort((a, b) => a[0] - b[0]);
    let cursor = toMin("08:00"); const end = toMin("22:00");
    const slots: [number, number][] = [];
    for (const [s, e] of busy) { if (s > cursor) slots.push([cursor, s]); cursor = Math.max(cursor, e); }
    if (cursor < end) slots.push([cursor, end]);
    for (const [s, e] of slots) {
      freeMinutes += e - s;
      while (taskIdx < pending.length && e - s >= 60) {
        const t = pending[taskIdx];
        const dur = Math.min((t.estimateHours ?? 1) * 60, e - s);
        allocations.push({ taskTitle: t.title, weekday: d, startTime: fmt(s), endTime: fmt(s + dur) });
        // 截止冲突：分配日晚于截止 → 冲突。
        if (t.dueAt) { const dueWd = new Date(t.dueAt).getDay() || 7; if (d > dueWd) conflicts.push(`${t.title} 分配周${d}晚于截止周${dueWd}`); }
        taskIdx++; break;
      }
    }
  }
  if (taskIdx < pending.length) conflicts.push(`${pending.length - taskIdx} 个任务本周空闲不足，未分配`);
  // 验收：DAG 有效 + 无过期冲突（no_expired）+ 有计划产物。
  const acceptancePassed = dagOk && conflicts.length === 0 && allocations.length > 0;
  return { plan, allocations, conflicts, acceptancePassed, freeMinutes };
}

export { detectConflict };