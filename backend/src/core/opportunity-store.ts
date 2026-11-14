// 机会雷达存储（owner 隔离）。字段与前端 Opportunity 对齐，Agent 经 save_opportunity 写入，Radar 经 API 读取。
// Supabase 在部署环境不可达时的后端本地真相源；生产可换 Postgres 实现（同接口）。
import { randomUUID } from "node:crypto";

export interface OpportunityRecord {
  id: string;
  userId: string;
  title: string;
  type: string;
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

export interface OpportunityInput {
  userId: string;
  title: string;
  type?: string;
  organizer?: string;
  description?: string;
  conditions?: string[];
  deadline?: string | null;
  sourceUrl?: string;
  sourceType?: string;
}

export interface OpportunityStore {
  create(input: OpportunityInput): Promise<OpportunityRecord>;
  listByUser(userId: string): Promise<OpportunityRecord[]>;
  get(userId: string, id: string): Promise<OpportunityRecord | null>;
}

const CATEGORIES = new Set(["competition", "internship", "scholarship", "activity", "notice", "research", "exchange", "other"]);

export class InMemoryOpportunityStore implements OpportunityStore {
  private items = new Map<string, OpportunityRecord>();

  async create(input: OpportunityInput): Promise<OpportunityRecord> {
    const type = CATEGORIES.has(input.type ?? "") ? (input.type as string) : "competition";
    const rec: OpportunityRecord = {
      id: randomUUID(),
      userId: input.userId,
      title: input.title,
      type,
      organizer: input.organizer ?? "",
      description: input.description ?? "",
      conditions: Array.isArray(input.conditions) ? input.conditions : [],
      deadline: input.deadline ?? null,
      sourceUrl: input.sourceUrl ?? "",
      sourceType: input.sourceType ?? "agent",
      collectedAt: new Date().toISOString(),
      status: "active",
      demo: false,
    };
    this.items.set(rec.id, rec);
    return rec;
  }

  async listByUser(userId: string): Promise<OpportunityRecord[]> {
    return [...this.items.values()].filter((o) => o.userId === userId).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  }

  async get(userId: string, id: string): Promise<OpportunityRecord | null> {
    const o = this.items.get(id);
    return o && o.userId === userId ? o : null;
  }
}