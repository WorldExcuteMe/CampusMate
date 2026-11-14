// Personal Campus Context 数据模型 + Store。结构化业务数据独立建模（不塞进 Memory）。
// 课程规则与临时调课分表；user_id 隔离；保留来源/导入时间/版本；支持增删改。
import { randomUUID } from "node:crypto";

export interface InstitutionProfile {
  userId: string;
  university: string;
  college?: string;
  major: string;
  grade: string;
  academicYear?: string;
  semester?: string;
  interests: string[];
  skills: string[];
  goals: string[];
  preferences: Record<string, unknown>;
  updatedAt: number;
}

export interface AcademicTerm {
  id: string;
  userId: string;
  institutionId: string;
  name: string;
  startDate: string;   // YYYY-MM-DD
  endDate: string;
  totalWeeks: number;
  timezone: string;
}

export interface Course {
  id: string;
  userId: string;
  termId: string;
  name: string;
  teacher?: string;
  credit?: number;
}

export type WeekPattern = "every" | "odd" | "even";

export interface CourseSchedule {
  id: string;
  userId: string;
  termId: string;
  courseId: string;
  courseName: string;
  weekday: number;       // 1-7
  startTime: string;     // HH:MM
  endTime: string;
  startWeek: number;
  endWeek: number;
  weekPattern: WeekPattern;
  classroom?: string;
  campus?: string;
  source?: string;
  importedAt?: number;
}

export type ExceptionKind = "reschedule" | "makeup" | "cancel" | "room_change" | "holiday";

export interface ScheduleException {
  id: string;
  userId: string;
  termId: string;
  scheduleId?: string;   // 关联正常课程规则（不覆盖）
  kind: ExceptionKind;
  date: string;          // YYYY-MM-DD 具体日期
  weekday?: number;
  startTime?: string;
  endTime?: string;
  classroom?: string;
  note?: string;
}

export interface InformationSource {
  id: string;
  userId: string;
  kind: "academic_system" | "campus_website" | "student_group" | "official_account";
  name: string;
  url?: string;
  adapterId?: string;
  enabled: boolean;
}

export type ImportStatus = "pending" | "previewed" | "confirmed" | "failed";

export interface ImportJob {
  id: string;
  userId: string;
  termId: string;
  format: "ics" | "csv" | "xlsx" | "pdf" | "html" | "image";
  status: ImportStatus;
  sourceName: string;
  previewCount: number;
  errorCount: number;
  version: number;
  createdAt: number;
}

export interface PersonalContextStore {
  getProfile(userId: string): Promise<InstitutionProfile | null>;
  setProfile(p: InstitutionProfile): Promise<InstitutionProfile>;
  createTerm(t: Omit<AcademicTerm, "id">): Promise<AcademicTerm>;
  listTerms(userId: string): Promise<AcademicTerm[]>;
  saveSchedules(userId: string, termId: string, schedules: Omit<CourseSchedule, "id" | "userId" | "termId">[]): Promise<CourseSchedule[]>;
  listSchedules(userId: string, termId: string): Promise<CourseSchedule[]>;
  addException(e: Omit<ScheduleException, "id">): Promise<ScheduleException>;
  listExceptions(userId: string, termId: string): Promise<ScheduleException[]>;
  deleteSchedule(userId: string, id: string): Promise<boolean>;
  addSource(s: Omit<InformationSource, "id">): Promise<InformationSource>;
  listSources(userId: string): Promise<InformationSource[]>;
  createImportJob(j: Omit<ImportJob, "id">): Promise<ImportJob>;
  updateImportJob(id: string, patch: Partial<ImportJob>): Promise<ImportJob | null>;
}

export class InMemoryPersonalContextStore implements PersonalContextStore {
  private profiles = new Map<string, InstitutionProfile>();
  private terms = new Map<string, AcademicTerm>();
  private schedules = new Map<string, CourseSchedule>();
  private exceptions = new Map<string, ScheduleException>();
  private sources = new Map<string, InformationSource>();
  private jobs = new Map<string, ImportJob>();

  async getProfile(userId: string) { return this.profiles.get(userId) ?? null; }
  async setProfile(p: InstitutionProfile) { const next = { ...p, updatedAt: Date.now() }; this.profiles.set(p.userId, next); return next; }
  async createTerm(t: Omit<AcademicTerm, "id">) { const term = { ...t, id: randomUUID() }; this.terms.set(term.id, term); return term; }
  async listTerms(userId: string) { return [...this.terms.values()].filter((t) => t.userId === userId); }
  async saveSchedules(userId: string, termId: string, schedules: Omit<CourseSchedule, "id" | "userId" | "termId">[]) {
    const out: CourseSchedule[] = [];
    for (const s of schedules) { const rec = { ...s, id: randomUUID(), userId, termId }; this.schedules.set(rec.id, rec); out.push(rec); }
    return out;
  }
  async listSchedules(userId: string, termId: string) { return [...this.schedules.values()].filter((s) => s.userId === userId && s.termId === termId); }
  async addException(e: Omit<ScheduleException, "id">) { const rec = { ...e, id: randomUUID() }; this.exceptions.set(rec.id, rec); return rec; }
  async listExceptions(userId: string, termId: string) { return [...this.exceptions.values()].filter((e) => e.userId === userId && e.termId === termId); }
  async deleteSchedule(userId: string, id: string) { const s = this.schedules.get(id); if (!s || s.userId !== userId) return false; return this.schedules.delete(id); }
  async addSource(s: Omit<InformationSource, "id">) { const rec = { ...s, id: randomUUID() }; this.sources.set(rec.id, rec); return rec; }
  async listSources(userId: string) { return [...this.sources.values()].filter((s) => s.userId === userId); }
  async createImportJob(j: Omit<ImportJob, "id">) { const rec = { ...j, id: randomUUID() }; this.jobs.set(rec.id, rec); return rec; }
  async updateImportJob(id: string, patch: Partial<ImportJob>) { const j = this.jobs.get(id); if (!j) return null; const next = { ...j, ...patch, id }; this.jobs.set(id, next); return next; }
}

// 教学周计算：给定学期起始与当前日期 → 当前教学周（1-based）。
export function currentTeachingWeek(term: AcademicTerm, now: Date): number {
  const start = new Date(term.startDate + "T00:00:00");
  const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
  if (days < 0) return 0;
  return Math.min(term.totalWeeks, Math.floor(days / 7) + 1);
}

// 某教学周是否上课（单双周 + 周次范围）。
export function occursInWeek(s: Pick<CourseSchedule, "startWeek" | "endWeek" | "weekPattern">, week: number): boolean {
  if (week < s.startWeek || week > s.endWeek) return false;
  if (s.weekPattern === "odd") return week % 2 === 1;
  if (s.weekPattern === "even") return week % 2 === 0;
  return true;
}