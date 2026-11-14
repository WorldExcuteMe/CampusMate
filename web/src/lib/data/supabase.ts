import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentRun } from "../agent/orchestrator";
import type {
  ActivityEvent,
  InboxItem,
  Opportunity,
  Profile,
  Repository,
  Task,
  VerificationReport,
} from "./types";

export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey);
}

export class SupabaseRepository implements Repository {
  readonly mode = "supabase" as const;
  constructor(private db: SupabaseClient, private userId: string) {}

  async getProfile(): Promise<Profile> {
    const { data, error } = await this.db
      .from("profiles")
      .select("*")
      .eq("id", this.userId)
      .single();
    if (error) throw error;
    return {
      id: data.id,
      name: data.name ?? "",
      major: data.major ?? "",
      grade: data.grade ?? "",
      interests: data.interests ?? [],
      skills: data.skills ?? [],
      goals: data.goals ?? [],
      timeBudgetHours: data.time_budget_hours ?? 10,
      bio: data.bio ?? "",
    };
  }
  async updateProfile(p: Profile): Promise<Profile> {
    const { error } = await this.db.from("profiles").upsert({
      id: this.userId,
      name: p.name,
      major: p.major,
      grade: p.grade,
      interests: p.interests,
      skills: p.skills,
      goals: p.goals,
      time_budget_hours: p.timeBudgetHours,
      bio: p.bio,
    });
    if (error) throw error;
    return p;
  }
  async listInbox(): Promise<InboxItem[]> {
    const { data, error } = await this.db
      .from("inbox_items")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(rowToInbox);
  }
  async getInbox(id: string): Promise<InboxItem | null> {
    const { data, error } = await this.db
      .from("inbox_items")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToInbox(data) : null;
  }
  async createInbox(item: InboxItem): Promise<InboxItem> {
    const { error } = await this.db.from("inbox_items").insert({
      id: item.id,
      user_id: this.userId,
      raw_text: item.rawText,
      source_url: item.sourceUrl,
      source_type: item.sourceType,
      extracted: item.extracted,
      classification: item.classification,
      status: item.status,
    });
    if (error) throw error;
    return item;
  }
  async updateInbox(id: string, patch: Partial<InboxItem>): Promise<InboxItem> {
    const row: Record<string, unknown> = {};
    if (patch.status) row.status = patch.status;
    if (patch.extracted) row.extracted = patch.extracted;
    if (patch.classification) row.classification = patch.classification;
    const { data, error } = await this.db
      .from("inbox_items")
      .update(row)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return rowToInbox(data);
  }
  async listTasks(): Promise<Task[]> {
    const { data, error } = await this.db
      .from("tasks")
      .select("*")
      .eq("user_id", this.userId)
      .order("due_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map(rowToTask);
  }
  async createTask(task: Task): Promise<Task> {
    const { error } = await this.db.from("tasks").insert({
      id: task.id,
      user_id: this.userId,
      title: task.title,
      due_at: task.dueAt,
      status: task.status,
      priority: task.priority,
      inbox_item_id: task.inboxItemId,
      estimate_hours: task.estimateHours,
      kind: task.kind,
      time_text: task.timeText ?? null,
    });
    if (error) throw error;
    return task;
  }
  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const row: Record<string, unknown> = {};
    if (patch.status) row.status = patch.status;
    if (patch.title) row.title = patch.title;
    if (patch.dueAt !== undefined) row.due_at = patch.dueAt;
    const { data, error } = await this.db
      .from("tasks")
      .update(row)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return rowToTask(data);
  }
  async listOpportunities(): Promise<Opportunity[]> {
    const { data, error } = await this.db.from("opportunities").select("*");
    if (error) throw error;
    return (data ?? []).map(rowToOpportunity);
  }
  async getOpportunity(id: string): Promise<Opportunity | null> {
    const { data, error } = await this.db
      .from("opportunities")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToOpportunity(data) : null;
  }
  async createOpportunity(o: Opportunity): Promise<Opportunity> {
    const { error } = await this.db.from("opportunities").insert({
      id: o.id,
      title: o.title,
      type: o.type,
      organizer: o.organizer,
      description: o.description,
      conditions: o.conditions,
      deadline: o.deadline,
      source_url: o.sourceUrl,
      source_type: o.sourceType,
      status: o.status,
      is_demo: o.demo,
    });
    if (error) throw error;
    return o;
  }
  async listReports(): Promise<VerificationReport[]> {
    const { data, error } = await this.db
      .from("verification_reports")
      .select("*, evidence_items(*)");
    if (error) throw error;
    return (data ?? []).map(rowToReport);
  }
  async getReport(id: string): Promise<VerificationReport | null> {
    const { data, error } = await this.db
      .from("verification_reports")
      .select("*, evidence_items(*)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToReport(data) : null;
  }
  async createReport(r: VerificationReport): Promise<VerificationReport> {
    const { error } = await this.db.from("verification_reports").insert({
      id: r.id,
      opportunity_id: r.opportunityId,
      status: r.status,
      summary: r.summary,
      findings: r.findings,
    });
    if (error) throw error;
    if (r.evidence?.length) {
      await this.db.from("evidence_items").insert(
        r.evidence.map((e) => ({
          report_id: r.id,
          source_url: e.sourceUrl,
          source_type: e.sourceType,
          excerpt: e.excerpt,
          supports: e.supports,
          confidence: e.confidence,
        })),
      );
    }
    return r;
  }
  async logActivity(e: ActivityEvent): Promise<void> {
    await this.db.from("activity_events").insert({
      id: e.id,
      user_id: this.userId,
      event_type: e.eventType,
      entity_type: e.entityType,
      entity_id: e.entityId,
    });
  }
  async listActivity(): Promise<ActivityEvent[]> {
    const { data } = await this.db
      .from("activity_events")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false });
    return (data ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      eventType: r.event_type,
      entityType: r.entity_type,
      entityId: r.entity_id,
      createdAt: r.created_at,
    }));
  }
  async logAgentRun(run: AgentRun): Promise<void> {
    await this.db.from("agent_runs").insert({
      id: run.id,
      user_id: this.userId,
      task_type: run.taskType,
      status: run.status,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      model: run.model,
      token_usage: run.tokenUsage,
      error: run.error ?? null,
    });
  }
  async listAgentRuns(): Promise<AgentRun[]> {
    const { data } = await this.db
      .from("agent_runs")
      .select("*")
      .eq("user_id", this.userId)
      .order("started_at", { ascending: false });
    return (data ?? []).map((r) => ({
      id: r.id,
      taskType: r.task_type,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      model: r.model,
      provider: r.model,
      mock: false,
      tokenUsage: r.token_usage ?? { input: 0, output: 0 },
      error: r.error ?? undefined,
    }));
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToInbox(r: any): InboxItem {
  return {
    id: r.id,
    userId: r.user_id,
    rawText: r.raw_text,
    sourceUrl: r.source_url,
    sourceType: r.source_type,
    extracted: r.extracted,
    classification: r.classification,
    status: r.status,
    createdAt: r.created_at,
    demo: false,
  };
}
function rowToTask(r: any): Task {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    dueAt: r.due_at,
    status: r.status,
    priority: r.priority,
    inboxItemId: r.inbox_item_id,
    estimateHours: r.estimate_hours,
    kind: r.kind ?? "general",
    timeText: r.time_text ?? undefined,
    createdAt: r.created_at,
    demo: false,
  };
}
function rowToOpportunity(r: any): Opportunity {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    organizer: r.organizer,
    description: r.description,
    conditions: r.conditions ?? [],
    deadline: r.deadline,
    sourceUrl: r.source_url,
    sourceType: r.source_type,
    collectedAt: r.collected_at,
    status: r.status,
    demo: r.is_demo ?? false,
  };
}
function rowToReport(r: any): VerificationReport {
  return {
    id: r.id,
    opportunityId: r.opportunity_id,
    status: r.status,
    summary: r.summary,
    findings: r.findings ?? [],
    evidence: (r.evidence_items ?? []).map((e: any) => ({
      sourceUrl: e.source_url,
      sourceType: e.source_type,
      excerpt: e.excerpt,
      retrievedAt: e.retrieved_at,
      supports: e.supports,
      confidence: e.confidence,
    })),
    createdAt: r.created_at,
  };
}