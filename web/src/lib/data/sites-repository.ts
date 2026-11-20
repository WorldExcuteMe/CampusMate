import { req } from "@/lib/agent/api-client";
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

type Row = Record<string, unknown>;

const INBOX_STATUS = new Set(["pending_review", "confirmed", "ignored", "archived", "failed"]);
const TASK_STATUS = new Set(["todo", "in_progress", "done", "cancelled"]);
const TASK_KIND = new Set(["daily", "opportunity", "general"]);
const SOURCE_TYPE = new Set(["text", "image", "pdf", "docx", "url"]);
const CATEGORY = new Set(["competition", "internship", "research", "scholarship", "activity", "opensource", "notice"]);
const OPPORTUNITY_STATUS = new Set(["active", "expired", "archived"]);

const isRow = (value: unknown): value is Row =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value : "";
const nullableText = (value: unknown) => typeof value === "string" && value ? value : null;
const number = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const isoTime = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
};
const enumText = <T extends string>(value: unknown, allowed: Set<string>, fallback: T): T =>
  typeof value === "string" && allowed.has(value) ? value as T : fallback;

function mapProfile(data: Row, userId: string): Profile {
  return {
    id: userId,
    name: text(data.name),
    school: text(data.school),
    major: text(data.major),
    grade: text(data.grade),
    interests: strings(data.interests),
    skills: strings(data.skills),
    goals: strings(data.goals),
    timeBudgetHours: number(data.timeBudgetHours ?? data.time_budget_hours, 10),
    bio: text(data.bio),
  };
}

function mapInbox(data: Row, userId: string): InboxItem {
  const nested = isRow(data.extracted);
  const extracted: Row = nested ? (data.extracted as Row) : data;
  const classification = isRow(data.classification) ? data.classification : {};
  return {
    id: text(data.id),
    userId,
    rawText: text(data.rawText ?? data.raw_text ?? extracted.summary ?? (nested ? undefined : data.content) ?? extracted.title),
    sourceUrl: nullableText(data.sourceUrl ?? data.source_url ?? extracted.sourceUrl ?? (nested ? undefined : data.url)),
    sourceType: enumText(data.sourceType, SOURCE_TYPE, "text"),
    extracted: {
      title: text(extracted.title ?? data.title),
      category: enumText(extracted.category, CATEGORY, "notice"),
      org: text(extracted.org),
      summary: text(extracted.summary ?? (nested ? undefined : data.content)),
      deadline: nullableText(extracted.deadline ?? (nested ? undefined : data.dueAt)),
      conditions: strings(extracted.conditions),
      materials: strings(extracted.materials),
      cost: nullableText(extracted.cost),
      location: nullableText(extracted.location),
      sourceUrl: nullableText(extracted.sourceUrl),
      evidenceExcerpt: text(extracted.evidenceExcerpt),
      confidence: number(extracted.confidence, 0.5),
    },
    classification: {
      class: enumText(classification.class, new Set(["must_act", "high_value", "worth_watching", "normal", "risk"]), "normal"),
      priorityScore: number(classification.priorityScore, 50),
      priorityReason: text(classification.priorityReason),
      riskSignals: strings(classification.riskSignals),
    },
    status: enumText(data.status, INBOX_STATUS, "confirmed"),
    createdAt: isoTime(data.createdAt ?? data.created_at ?? data.savedAt),
    demo: false,
    mergedFrom: strings(data.mergedFrom),
    extractionMock: data.extractionMock === true,
  };
}

function mapTask(data: Row, userId: string): Task {
  return {
    id: text(data.id),
    userId,
    title: text(data.title),
    dueAt: nullableText(data.dueAt ?? data.deadline),
    status: enumText(data.status, TASK_STATUS, "todo"),
    priority: number(data.priority, 50),
    inboxItemId: nullableText(data.inboxItemId),
    estimateHours: typeof data.estimateHours === "number" ? data.estimateHours : null,
    kind: enumText(data.kind, TASK_KIND, "daily"),
    timeText: typeof data.timeText === "string" && data.timeText ? data.timeText : undefined,
    createdAt: isoTime(data.createdAt ?? data.created_at ?? data.savedAt),
    demo: false,
  };
}

function mapOpportunity(data: Row): Opportunity {
  return {
    id: text(data.id),
    title: text(data.title) || "未命名机会",
    type: enumText(data.type, CATEGORY, "notice"),
    organizer: text(data.organizer),
    description: text(data.description ?? data.summary),
    conditions: strings(data.conditions),
    deadline: nullableText(data.deadline),
    sourceUrl: text(data.sourceUrl),
    sourceType: text(data.sourceType) || "text",
    collectedAt: isoTime(data.collectedAt ?? data.savedAt),
    status: enumText(data.status, OPPORTUNITY_STATUS, "active"),
    demo: false,
  };
}

export interface CloudAgentSettings {
  settings: Record<string, unknown>;
  revision: number;
  updatedAt: number;
}

export class SitesRepository implements Repository {
  readonly mode = "supabase" as const;
  readonly storageScope: string;
  constructor(private userId: string) {
    this.storageScope = `cloud:${userId}`;
  }

  private async items(kind: "inbox" | "daily" | "opportunities"): Promise<Row[]> {
    const data = await req<Record<string, unknown>>(`/v1/domain/${kind}`);
    const list = data[kind];
    return Array.isArray(list) ? list.filter(isRow) : [];
  }

  private async save(kind: "inbox" | "daily" | "opportunities", item: Row): Promise<Row> {
    const data = await req<Record<string, unknown>>(`/v1/domain/${kind}`, {
      method: "POST",
      body: JSON.stringify(item),
    });
    return isRow(data[kind]) ? data[kind] : item;
  }

  async getProfile(): Promise<Profile> {
    const data = await req<{ profile?: unknown }>("/v1/domain/profile");
    return mapProfile(isRow(data.profile) ? data.profile : {}, this.userId);
  }
  async updateProfile(profile: Profile): Promise<Profile> {
    const data = await req<{ profile?: unknown }>("/v1/domain/profile", {
      method: "PUT",
      body: JSON.stringify({ ...profile, id: this.userId }),
    });
    return mapProfile(isRow(data.profile) ? data.profile : { ...profile }, this.userId);
  }

  async listInbox(): Promise<InboxItem[]> {
    return (await this.items("inbox")).map((row) => mapInbox(row, this.userId));
  }
  async getInbox(id: string): Promise<InboxItem | null> {
    const row = (await this.items("inbox")).find((item) => item.id === id);
    return row ? mapInbox(row, this.userId) : null;
  }
  async createInbox(item: InboxItem): Promise<InboxItem> {
    return mapInbox(await this.save("inbox", item as unknown as Row), this.userId);
  }
  async updateInbox(id: string, patch: Partial<InboxItem>): Promise<InboxItem> {
    const current = (await this.items("inbox")).find((item) => item.id === id);
    if (!current) throw new Error("通知不存在");
    return mapInbox(await this.save("inbox", { ...current, ...patch, id }), this.userId);
  }

  async listTasks(): Promise<Task[]> {
    return (await this.items("daily")).map((row) => mapTask(row, this.userId));
  }
  async createTask(task: Task): Promise<Task> {
    return mapTask(await this.save("daily", task as unknown as Row), this.userId);
  }
  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const current = (await this.items("daily")).find((item) => item.id === id);
    if (!current) throw new Error("任务不存在");
    return mapTask(await this.save("daily", { ...current, ...patch, id }), this.userId);
  }

  async listOpportunities(): Promise<Opportunity[]> {
    return (await this.items("opportunities")).map(mapOpportunity);
  }
  async getOpportunity(id: string): Promise<Opportunity | null> {
    const row = (await this.items("opportunities")).find((item) => item.id === id);
    return row ? mapOpportunity(row) : null;
  }
  async createOpportunity(opportunity: Opportunity): Promise<Opportunity> {
    return mapOpportunity(await this.save("opportunities", opportunity as unknown as Row));
  }

  async listReports(): Promise<VerificationReport[]> { return []; }
  async getReport(_id: string): Promise<VerificationReport | null> { return null; }
  async createReport(_report: VerificationReport): Promise<VerificationReport> {
    throw new Error("核验报告云端暂未就绪");
  }
  async logActivity(_event: ActivityEvent): Promise<void> { /* 云端活动日志暂未就绪 */ }
  async listActivity(): Promise<ActivityEvent[]> { return []; }
  async logAgentRun(_run: AgentRun): Promise<void> { /* 云端 Agent 运行记录暂未就绪 */ }
  async listAgentRuns(): Promise<AgentRun[]> { return []; }

  getAgentSettings(): Promise<CloudAgentSettings> {
    return req<CloudAgentSettings>("/v1/settings/agent");
  }
  saveAgentSettings(settings: Record<string, unknown>, expectedRevision?: number): Promise<CloudAgentSettings> {
    return req<CloudAgentSettings>("/v1/settings/agent", {
      method: "PATCH",
      body: JSON.stringify({ ...settings, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
    });
  }
}
