// 统一业务对象：Information / Task / Event / Opportunity / Reference。
// 可相互关联派生（一条竞赛通知 → Opportunity + 报名 Task + 截止 Event），不用单表代替所有对象。

export type ObjectKind = "information" | "task" | "event" | "opportunity" | "reference";

export interface BusinessObject {
  id: string;
  kind: ObjectKind;
  title: string;
  sourceId?: string;       // 来源 Information id
  relatedIds: string[];    // 关联对象
  createdAt: number;
}

export interface Information extends BusinessObject { kind: "information"; rawText: string; sourceUrl?: string; summary?: string; priority?: number; }
export interface TaskObject extends BusinessObject { kind: "task"; dueAt?: string | null; status: "todo" | "in_progress" | "done"; }
export interface EventObject extends BusinessObject { kind: "event"; startAt: string; endAt?: string; eventType: "course" | "exam" | "activity" | "deadline" | "interview"; }
export interface OpportunityObject extends BusinessObject { kind: "opportunity"; oppType: string; deadline?: string | null; matchScore?: number; verified?: boolean; }
export interface ReferenceObject extends BusinessObject { kind: "reference"; url?: string; archived?: boolean; }

// 从一条信息派生关联对象（竞赛通知 → Opportunity + 报名 Task + 截止 Event）。
export function deriveFromInformation(info: Information, opts: { category: string; deadline?: string | null; isOpportunity?: boolean }): BusinessObject[] {
  const out: BusinessObject[] = [info];
  const base = { sourceId: info.id, createdAt: info.createdAt, relatedIds: [info.id] };
  if (opts.isOpportunity) {
    const opp: OpportunityObject = { id: `${info.id}-opp`, kind: "opportunity", title: info.title, oppType: opts.category, deadline: opts.deadline ?? null, ...base };
    out.push(opp);
    if (opts.deadline) {
      const task: TaskObject = { id: `${info.id}-task`, kind: "task", title: `报名：${info.title}`, dueAt: opts.deadline, status: "todo", ...base, relatedIds: [info.id, opp.id] };
      const event: EventObject = { id: `${info.id}-deadline`, kind: "event", title: `截止：${info.title}`, startAt: opts.deadline, eventType: "deadline", ...base, relatedIds: [info.id, opp.id, task.id] };
      out.push(task, event);
    }
  } else if (opts.deadline) {
    const task: TaskObject = { id: `${info.id}-task`, kind: "task", title: info.title, dueAt: opts.deadline, status: "todo", ...base };
    out.push(task);
  }
  return out;
}

// 关联图：按 relatedIds 双向补全。
export function buildRelationGraph(objects: BusinessObject[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const o of objects) graph.set(o.id, new Set(o.relatedIds));
  for (const o of objects) for (const rid of o.relatedIds) { const s = graph.get(rid); if (s) s.add(o.id); }
  return graph;
}

export function relatedObjects(graph: Map<string, Set<string>>, id: string): string[] {
  return [...(graph.get(id) ?? [])];
}