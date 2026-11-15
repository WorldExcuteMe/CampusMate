import { randomUUID } from "node:crypto";
import type { AcademicTerm, CourseSchedule, ImportJob, InformationSource, InstitutionProfile, PersonalContextStore, ScheduleException } from "../core/personal-context.ts";
import type { SqlClient, SqlPool } from "./sql.ts";
import { transactionPool } from "./sql.ts";
import { validateScheme, scheduleKey, type TimeScheme } from "../../../shared/calendar.ts";
import { assertTermOwner, calendarDate, json, millis, optionalText, type DbRow } from "./postgres-shared.ts";

function term(r: DbRow): AcademicTerm { return { id: String(r.id), userId: String(r.user_id), institutionId: String(r.institution_id), name: String(r.name), startDate: calendarDate(r.start_date), endDate: calendarDate(r.end_date), totalWeeks: Number(r.total_weeks), timezone: String(r.timezone), weekAnchor: r.week_anchor ? calendarDate(r.week_anchor) : undefined }; }
function schedule(r: DbRow): CourseSchedule { return { id: String(r.id), userId: String(r.user_id), termId: String(r.term_id), courseId: r.course_id == null ? "" : String(r.course_id), courseName: String(r.course_name), weekday: Number(r.weekday), startTime: String(r.start_time), endTime: String(r.end_time), startWeek: Number(r.start_week), endWeek: Number(r.end_week), weekPattern: r.week_pattern as CourseSchedule["weekPattern"], classroom: String(r.classroom), campus: String(r.campus), source: String(r.source), importedAt: millis(r.imported_at) }; }
function exception(r: DbRow): ScheduleException { return { id: String(r.id), userId: String(r.user_id), termId: String(r.term_id), scheduleId: optionalText(r.schedule_id), kind: r.kind as ScheduleException["kind"], date: calendarDate(r.date), sourceDate: r.source_date ? calendarDate(r.source_date) : undefined, weekday: r.weekday == null ? undefined : Number(r.weekday), startTime: optionalText(r.start_time), endTime: optionalText(r.end_time), classroom: String(r.classroom), note: String(r.note) }; }
function job(r: DbRow): ImportJob { return { id: String(r.id), userId: String(r.user_id), termId: String(r.term_id), format: r.format as ImportJob["format"], status: r.status as ImportJob["status"], sourceName: String(r.source_name), previewCount: Number(r.preview_count), errorCount: Number(r.error_count), version: Number(r.version), createdAt: millis(r.created_at), preview: r.preview as ImportJob["preview"], savedScheduleIds: (r.saved_schedule_ids ?? []) as string[] }; }

export class PostgresPersonalContextStore implements PersonalContextStore {
  private pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async getProfile(userId: string): Promise<InstitutionProfile | null> {
    const r = await this.pool.query<DbRow>("select p.*,u.university,u.college,u.academic_year,u.semester,u.preferences,u.updated_at from profiles p left join user_institution_profiles u on u.user_id=p.id where p.id=$1", [userId]);
    const row = r.rows[0]; if (!row) return null;
    return { userId, university: String(row.university ?? ""), college: optionalText(row.college), major: String(row.major), grade: String(row.grade), academicYear: optionalText(row.academic_year), semester: optionalText(row.semester), interests: row.interests as string[], skills: row.skills as string[], goals: row.goals as string[], preferences: (row.preferences ?? {}) as Record<string, unknown>, updatedAt: millis(row.updated_at ?? row.created_at) };
  }
  async setProfile(p: InstitutionProfile): Promise<InstitutionProfile> {
    await this.pool.transaction(async (client) => {
      await client.query("insert into profiles(id,major,grade,interests,skills,goals) values($1,$2,$3,$4,$5,$6) on conflict(id) do update set major=excluded.major,grade=excluded.grade,interests=excluded.interests,skills=excluded.skills,goals=excluded.goals", [p.userId, p.major, p.grade, p.interests, p.skills, p.goals]);
      await client.query("insert into user_institution_profiles(user_id,university,college,academic_year,semester,preferences) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(user_id) do update set university=excluded.university,college=excluded.college,academic_year=excluded.academic_year,semester=excluded.semester,preferences=excluded.preferences,updated_at=now()", [p.userId, p.university, p.college ?? "", p.academicYear ?? "", p.semester ?? "", json(p.preferences)]);
    });
    return (await this.getProfile(p.userId))!;
  }
  async createTerm(t: Omit<AcademicTerm, "id">) { const r = await this.pool.query<DbRow>("insert into academic_terms(id,user_id,institution_id,name,start_date,end_date,total_weeks,timezone,week_anchor) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *", [randomUUID(), t.userId, t.institutionId, t.name, t.startDate, t.endDate, t.totalWeeks, t.timezone, t.weekAnchor ?? null]); return term(r.rows[0]); }
  async listTerms(userId: string) { const r = await this.pool.query<DbRow>("select * from academic_terms where user_id=$1 order by start_date,id", [userId]); return r.rows.map(term); }
  async saveSchedules(userId: string, termId: string, rows: Omit<CourseSchedule, "id" | "userId" | "termId">[]) {
    return this.pool.transaction(async (client) => {
      await assertTermOwner(client, userId, termId); const out: CourseSchedule[] = [];
      for (const s of rows) {
        if (s.courseId) { const course = await client.query("select id from courses where id=$1 and user_id=$2 and term_id=$3", [s.courseId, userId, termId]); if (!course.rows.length) throw new Error("Course owner/term forbidden"); }
        const r = await client.query<DbRow>("insert into course_schedules(id,user_id,term_id,course_id,course_name,weekday,start_time,end_time,start_week,end_week,week_pattern,classroom,campus,source) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *", [randomUUID(), userId, termId, s.courseId || null, s.courseName, s.weekday, s.startTime, s.endTime, s.startWeek, s.endWeek, s.weekPattern, s.classroom ?? "", s.campus ?? "", s.source ?? ""]);
        out.push(schedule(r.rows[0]));
      }
      return out;
    });
  }
  async listSchedules(userId: string, termId: string) { const r = await this.pool.query<DbRow>("select * from course_schedules where user_id=$1 and term_id=$2 order by weekday,start_time,id", [userId, termId]); return r.rows.map(schedule); }
  private async ownedSchedule(client: SqlClient, userId: string, termId: string, id: string) { const r = await client.query("select id from course_schedules where id=$1 and user_id=$2 and term_id=$3", [id, userId, termId]); if (!r.rows.length) throw new Error("Schedule owner/term forbidden"); }
  async addException(e: Omit<ScheduleException, "id">) {
    await assertTermOwner(this.pool, e.userId, e.termId); if (e.scheduleId) await this.ownedSchedule(this.pool, e.userId, e.termId, e.scheduleId);
    const r = await this.pool.query<DbRow>("insert into schedule_exceptions(id,user_id,term_id,schedule_id,kind,date,weekday,start_time,end_time,classroom,note,source_date) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *", [randomUUID(), e.userId, e.termId, e.scheduleId ?? null, e.kind, e.date, e.weekday ?? null, e.startTime ?? null, e.endTime ?? null, e.classroom ?? "", e.note ?? "", e.sourceDate ?? null]); return exception(r.rows[0]);
  }
  async listExceptions(userId: string, termId: string) { const r = await this.pool.query<DbRow>("select * from schedule_exceptions where user_id=$1 and term_id=$2 order by date,id", [userId, termId]); return r.rows.map(exception); }
  async deleteSchedule(userId: string, id: string) { return (await this.pool.query("delete from course_schedules where id=$1 and user_id=$2", [id, userId])).rowCount > 0; }
  async addSource(s: Omit<InformationSource, "id">) {
    // A user URL is never inserted as a globally approved official source.
    const source = s.url ? await this.pool.query<{ id: string }>("select id from information_sources where url=$1", [s.url]) : { rows: [] };
    const r = await this.pool.query<DbRow>("insert into user_information_sources(id,user_id,source_id,name,kind,url,adapter_id,enabled) values($1,$2,$3,$4,$5,$6,$7,$8) returning *", [randomUUID(), s.userId, source.rows[0]?.id ?? null, s.name, s.kind, s.url ?? null, s.adapterId ?? null, s.enabled]);
    return { ...s, id: String(r.rows[0].id) };
  }
  async listSources(userId: string): Promise<InformationSource[]> { const r = await this.pool.query<DbRow>("select * from user_information_sources where user_id=$1 order by created_at,id", [userId]); return r.rows.map((s) => ({ id: String(s.id), userId, name: String(s.name), kind: s.kind as InformationSource["kind"], url: optionalText(s.url), adapterId: optionalText(s.adapter_id), enabled: Boolean(s.enabled) })); }
  async createImportJob(j: Omit<ImportJob, "id">) { await assertTermOwner(this.pool, j.userId, j.termId); const r = await this.pool.query<DbRow>("insert into import_jobs(id,user_id,term_id,format,status,source_name,preview_count,error_count,version,preview) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) returning *", [randomUUID(), j.userId, j.termId, j.format, j.status, j.sourceName, j.previewCount, j.errorCount, j.version, j.preview ? json(j.preview) : null]); return job(r.rows[0]); }
  async getImportJob(userId: string, id: string) { const r = await this.pool.query<DbRow>("select * from import_jobs where id=$1 and user_id=$2", [id, userId]); return r.rows[0] ? job(r.rows[0]) : null; }
  async confirmImportJob(userId: string, id: string, allowPartial = false) {
    return this.pool.transaction(async (client) => {
      const repo = new PostgresPersonalContextStore(transactionPool(client));
      const known = await repo.getImportJob(userId, id); if (!known) throw new Error("导入预览不存在");
      await client.query("select id from academic_terms where id=$1 and user_id=$2 for update", [known.termId, userId]);
      const r = await client.query<DbRow>("select * from import_jobs where id=$1 and user_id=$2 for update", [id, userId]); const j = job(r.rows[0]);
      if (j.status === "confirmed") return (await repo.listSchedules(userId, j.termId)).filter((s) => j.savedScheduleIds?.includes(s.id));
      if (j.status !== "previewed" || !j.preview?.schedules.length || (j.errorCount && !allowPartial)) throw new Error("请修复错误或明确确认仅导入有效行");
      const key = scheduleKey;
      const existing = new Set((await repo.listSchedules(userId, j.termId)).map(key));
      const rows = j.preview.schedules.filter((s) => { const k = key(s); if (existing.has(k)) return false; existing.add(k); return true; });
      const saved = await repo.saveSchedules(userId, j.termId, rows.map((s) => ({ ...s, courseId: "" })));
      await client.query("update import_jobs set status='confirmed',saved_schedule_ids=$3 where id=$1 and user_id=$2", [id, userId, saved.map((s) => s.id)]);
      return saved;
    });
  }
  async saveTimeScheme(s: TimeScheme & { userId: string }) {
    validateScheme(s); await assertTermOwner(this.pool, s.userId, s.termId);
    if (!(await this.listTerms(s.userId)).some((t) => t.id === s.termId && t.institutionId === s.institutionId)) throw new Error("作息学期/学校不匹配");
    const id = randomUUID(); await this.pool.query("insert into timetable_schemes(id,user_id,term_id,institution_id,campus,name,effective_from,effective_to,periods) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)", [id, s.userId, s.termId, s.institutionId, s.campus, s.name, s.effectiveFrom, s.effectiveTo, json(s.periods)]); return { ...s, id };
  }
  async listTimeSchemes(userId: string, termId: string): Promise<TimeScheme[]> { const r = await this.pool.query<DbRow>("select * from timetable_schemes where user_id=$1 and term_id=$2 order by effective_from,id", [userId, termId]); return r.rows.map((s) => ({ id: String(s.id), userId, termId, institutionId: String(s.institution_id), campus: String(s.campus), name: String(s.name), effectiveFrom: calendarDate(s.effective_from), effectiveTo: calendarDate(s.effective_to), periods: s.periods as TimeScheme["periods"] })); }
  async updateImportJob(id: string, patch: Partial<ImportJob>) {
    if (!patch.userId) throw new Error("Import job owner required");
    const existing = await this.pool.query<DbRow>("select * from import_jobs where id=$1 and user_id=$2", [id, patch.userId]); if (!existing.rows[0]) return null;
    const old = job(existing.rows[0]); if (patch.termId && patch.termId !== old.termId) throw new Error("Import job term forbidden");
    const r = await this.pool.query<DbRow>("update import_jobs set status=$3,preview_count=$4,error_count=$5,version=$6 where id=$1 and user_id=$2 returning *", [id, patch.userId, patch.status ?? old.status, patch.previewCount ?? old.previewCount, patch.errorCount ?? old.errorCount, patch.version ?? old.version]); return job(r.rows[0]);
  }
}
