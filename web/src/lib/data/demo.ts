import {
  demoInbox,
  demoOpportunities,
  demoProfile,
  demoReports,
  demoTasks,
} from "../../demo/seed";
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

const KEY = "campusmate.demo.v1";

interface DemoState {
  profile: Profile;
  inbox: InboxItem[];
  tasks: Task[];
  opportunities: Opportunity[];
  reports: VerificationReport[];
  activity: ActivityEvent[];
  runs: AgentRun[];
}

function seedState(): DemoState {
  return {
    profile: demoProfile,
    inbox: demoInbox,
    tasks: demoTasks,
    opportunities: demoOpportunities,
    reports: demoReports,
    activity: [],
    runs: [],
  };
}

function load(): DemoState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch {
    /* fall through to seed */
  }
  const s = seedState();
  save(s);
  return s;
}

function save(s: DemoState): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export class DemoRepository implements Repository {
  readonly mode = "demo" as const;

  async getProfile(): Promise<Profile> {
    return load().profile;
  }
  async updateProfile(p: Profile): Promise<Profile> {
    const s = load();
    s.profile = p;
    save(s);
    return p;
  }
  async listInbox(): Promise<InboxItem[]> {
    return load().inbox.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getInbox(id: string): Promise<InboxItem | null> {
    return load().inbox.find((i) => i.id === id) ?? null;
  }
  async createInbox(item: InboxItem): Promise<InboxItem> {
    const s = load();
    s.inbox.push({ ...item, demo: true });
    save(s);
    return item;
  }
  async updateInbox(id: string, patch: Partial<InboxItem>): Promise<InboxItem> {
    const s = load();
    const idx = s.inbox.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error("inbox item not found");
    s.inbox[idx] = { ...s.inbox[idx], ...patch, demo: true };
    save(s);
    return s.inbox[idx];
  }
  async listTasks(): Promise<Task[]> {
    return load().tasks.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
  }
  async createTask(task: Task): Promise<Task> {
    const s = load();
    s.tasks.push({ ...task, demo: true });
    save(s);
    return task;
  }
  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const s = load();
    const idx = s.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error("task not found");
    s.tasks[idx] = { ...s.tasks[idx], ...patch, demo: true };
    save(s);
    return s.tasks[idx];
  }
  async listOpportunities(): Promise<Opportunity[]> {
    return load().opportunities;
  }
  async getOpportunity(id: string): Promise<Opportunity | null> {
    return load().opportunities.find((o) => o.id === id) ?? null;
  }
  async createOpportunity(o: Opportunity): Promise<Opportunity> {
    const s = load();
    s.opportunities.push(o);
    save(s);
    return o;
  }
  async listReports(): Promise<VerificationReport[]> {
    return load().reports;
  }
  async getReport(id: string): Promise<VerificationReport | null> {
    return load().reports.find((r) => r.id === id) ?? null;
  }
  async logActivity(e: ActivityEvent): Promise<void> {
    const s = load();
    s.activity.push(e);
    save(s);
  }
  async listActivity(): Promise<ActivityEvent[]> {
    return load().activity;
  }
  async logAgentRun(run: AgentRun): Promise<void> {
    const s = load();
    s.runs.push(run);
    save(s);
  }
  async listAgentRuns(): Promise<AgentRun[]> {
    return load().runs;
  }
}

export function resetDemo(): void {
  localStorage.removeItem(KEY);
}