import type {
  Classification,
  ExtractedNotice,
  InboxStatus,
  NoticeCategory,
  TaskStatus,
  VerificationStatus,
  Evidence,
} from "../schemas";
import type { AgentRun } from "../agent/orchestrator";

export interface Profile {
  id: string;
  name: string;
  major: string;
  grade: string;
  interests: string[];
  skills: string[];
  goals: string[];
  timeBudgetHours: number;
  bio: string;
}

export interface InboxItem {
  id: string;
  userId: string;
  rawText: string;
  sourceUrl: string | null;
  sourceType: "text" | "image" | "pdf" | "docx" | "url";
  extracted: ExtractedNotice;
  classification: Classification;
  status: InboxStatus;
  createdAt: string;
  demo: boolean;
  mergedFrom?: string[];
}

export interface Task {
  id: string;
  userId: string;
  title: string;
  dueAt: string | null;
  status: TaskStatus;
  priority: number;
  inboxItemId: string | null;
  estimateHours: number | null;
  kind: "daily" | "opportunity" | "general";
  timeText?: string;
  createdAt: string;
  demo: boolean;
}

export interface Opportunity {
  id: string;
  title: string;
  type: NoticeCategory;
  organizer: string;
  description: string;
  conditions: string[];
  deadline: string | null;
  sourceUrl: string;
  sourceType: string;
  collectedAt: string;
  status: "active" | "expired" | "archived";
  demo: boolean;
}

export interface VerificationFinding {
  item: string;
  result: "pass" | "warn" | "fail" | "unknown";
  note: string;
}

export interface VerificationReport {
  id: string;
  opportunityId: string;
  status: VerificationStatus;
  summary: string;
  findings: VerificationFinding[];
  evidence: Evidence[];
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  userId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export interface Repository {
  readonly mode: "demo" | "supabase";
  getProfile(): Promise<Profile>;
  updateProfile(p: Profile): Promise<Profile>;
  listInbox(): Promise<InboxItem[]>;
  getInbox(id: string): Promise<InboxItem | null>;
  createInbox(item: InboxItem): Promise<InboxItem>;
  updateInbox(id: string, patch: Partial<InboxItem>): Promise<InboxItem>;
  listTasks(): Promise<Task[]>;
  createTask(task: Task): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  listOpportunities(): Promise<Opportunity[]>;
  getOpportunity(id: string): Promise<Opportunity | null>;
  createOpportunity(o: Opportunity): Promise<Opportunity>;
  listReports(): Promise<VerificationReport[]>;
  getReport(id: string): Promise<VerificationReport | null>;
  createReport(r: VerificationReport): Promise<VerificationReport>;
  logActivity(e: ActivityEvent): Promise<void>;
  listActivity(): Promise<ActivityEvent[]>;
  logAgentRun(run: AgentRun): Promise<void>;
  listAgentRuns(): Promise<AgentRun[]>;
}

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}