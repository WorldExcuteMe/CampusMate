import { createHash } from "node:crypto";
import type { SqlPool } from "../runtime/sql.ts";
import { validDate, validTime } from "../../../shared/calendar.ts";

export interface InboxInput { title: string; rawText: string; summary?: string; category?: string; deadline?: string | null; deadlineTime?: string; location?: string | null; sourceUrl?: string | null; materials?: string[]; }
export interface CampusInbox { id: string; userId: string; rawText: string; sourceUrl: string | null; sourceType: "text"; extracted: Record<string, unknown>; classification: Record<string, unknown>; status: string; createdAt: string; extractionMock: boolean; }
function stableId(owner: string, fields: unknown[]): string {
  const hash = createHash("sha256").update(JSON.stringify([owner, ...fields])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const text = (value: unknown, max = 6000) => typeof value === "string" ? value.trim().slice(0, max) : "";
const categories = new Set(["competition", "internship", "scholarship", "activity", "notice", "research", "opensource"]);
function sourceClock(source: string, date: string): string | undefined {
  if (/UTC|GMT|世界时|纽约|伦敦|\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/i.test(source)) return;
  const clocks = new Set<string>();
  const patterns = [/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})(?:日|号)\s*(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分?)?)/g, /(20\d{2})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/g];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
    if (match[1] && match[1] !== date.slice(0, 4) || Number(match[2]) !== Number(date.slice(5, 7)) || Number(match[3]) !== Number(date.slice(8, 10))) continue;
    const clock = `${match[4].padStart(2, "0")}:${(match[5] ?? match[6] ?? "00").padStart(2, "0")}`;
    if (validTime(clock)) clocks.add(clock);
  }
  return clocks.size === 1 ? [...clocks][0] : undefined;
}
function normalizedDeadline(input: Pick<InboxInput, "deadline" | "deadlineTime">, evidenceText: string, rawText = "") {
  let deadline = text(input.deadline, 60) || null;
  const explicitZone = /UTC|GMT|世界时|纽约|伦敦|\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})/i.test(evidenceText);
  const groundedClock = deadline && !explicitZone ? sourceClock(evidenceText, deadline.slice(0, 10)) ?? (!/更正|修改|改为|改成|调整/.test(evidenceText) ? sourceClock(rawText, deadline.slice(0, 10)) : undefined) : undefined;
  const localClock = text(input.deadlineTime, 5);
  if (localClock && !validTime(localClock)) throw new Error("deadlineTime须为北京时间HH:mm，未知不填");
  if (deadline && !explicitZone && (groundedClock || localClock)) deadline = `${deadline.slice(0, 10)}T${groundedClock ?? localClock}:00+08:00`;
  if (deadline && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/.test(deadline)) deadline = deadline.replace(" ", "T") + "+08:00";
  if (deadline && (!validDate(deadline.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(deadline) || deadline.includes("T") && !validTime(deadline.slice(11, 16)) || !Number.isFinite(Date.parse(deadline)))) throw new Error("截止时间须为有效YYYY-MM-DD或ISO时间；无时区的校内通知按北京时间，未知请留空");
  return { deadline, groundedClock };
}
function fromRow(row: Record<string, unknown>): CampusInbox { return { id: String(row.id), userId: String(row.user_id), rawText: String(row.raw_text), sourceUrl: row.source_url as string | null, sourceType: "text", extracted: row.extracted as Record<string, unknown>, classification: row.classification as Record<string, unknown>, status: String(row.status), createdAt: new Date(row.created_at as string).toISOString(), extractionMock: Boolean(row.extraction_mock) }; }
const columns = "id,user_id,raw_text,source_url,extracted,classification,status,created_at,extraction_mock";

// Writes the same inbox_items consumed by the existing Inbox. User identity is
// supplied by the authenticated task, never by model arguments.
export class CampusRecords {
  private items = new Map<string, CampusInbox>();
  private pool?: SqlPool;
  constructor(pool?: SqlPool) { this.pool = pool; }
  async saveInbox(userId: string, input: InboxInput, evidenceText = ""): Promise<CampusInbox> {
    const rawText = text(input.rawText, 20000);
    let title = text(input.title, 200);
    // Recover an unambiguous literal title only when the model abbreviated it.
    // Multiple bracketed headings remain ambiguous and require model/user choice.
    const headings = [...new Set([...rawText.matchAll(/【([^【】\n]{2,200})】/g)].map(match => match[1].trim()))];
    if (headings.length === 1 && title.length >= 2 && headings[0].startsWith(title)) title = headings[0];
    if (!title || !rawText) throw new Error("通知标题和原文必填");
    const { deadline, groundedClock } = normalizedDeadline(input, evidenceText, rawText);
    const sourceUrl = text(input.sourceUrl, 2000) || null;
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) throw new Error("来源须为实际提供的公开http(s)链接，未知请留空");
    const location = text(input.location, 300) || null;
    const id = stableId(userId, ["inbox", title.normalize("NFKC").replace(/\s+/g, ""), deadline?.slice(0, 10) ?? rawText, location]);
    const extracted = { title, category: categories.has(input.category ?? "") ? input.category : "notice", org: "", summary: text(input.summary), deadline, location, sourceUrl, conditions: [], materials: (input.materials ?? []).filter(x => typeof x === "string").slice(0, 20), cost: null, evidenceExcerpt: rawText.slice(0, 1000), confidence: 0.5 };
    const classification = { class: "normal", priorityScore: 50, priorityReason: "Agent根据用户提供通知整理，保留待确认状态", riskSignals: [] };
    if (this.pool) {
      return this.pool.transaction(async client => {
        const existing = (await client.query<Record<string, unknown>>(`select ${columns} from inbox_items where user_id=$1 and extracted->>'title'=$2 and left(coalesce(extracted->>'deadline',''),10)=coalesce($3,'') and coalesce(extracted->>'location','')=coalesce($4,'') and ($3::text is not null or raw_text=$5) order by created_at,id limit 1 for update`, [userId, title, deadline?.slice(0, 10) ?? null, location, rawText])).rows[0];
        if (existing) {
          if (groundedClock && existing.status === "pending_review" && (existing.extracted as Record<string, unknown>).deadline !== deadline) return fromRow((await client.query<Record<string, unknown>>(`update inbox_items set extracted=jsonb_set(extracted,'{deadline}',$3::jsonb) where id=$1 and user_id=$2 returning ${columns}`, [existing.id, userId, JSON.stringify(deadline)])).rows[0]);
          return fromRow(existing);
        }
        await client.query("insert into inbox_items(id,user_id,raw_text,source_url,source_type,extracted,classification,status,extraction_mock) values($1,$2,$3,$4,'text',$5::jsonb,$6::jsonb,'pending_review',false) on conflict(id) do nothing", [id, userId, rawText, sourceUrl, JSON.stringify(extracted), JSON.stringify(classification)]);
        const row = (await client.query<Record<string, unknown>>(`select ${columns} from inbox_items where id=$1 and user_id=$2`, [id, userId])).rows[0];
        if (!row) throw new Error("通知保存结果未确认，请核对信息中心");
        return fromRow(row);
      });
    }
    if (!this.items.has(id)) this.items.set(id, { id, userId, rawText, sourceUrl, sourceType: "text", extracted, classification, status: "pending_review", createdAt: new Date().toISOString(), extractionMock: false });
    else if (groundedClock && this.items.get(id)!.status === "pending_review") this.items.get(id)!.extracted.deadline = deadline;
    return structuredClone(this.items.get(id)!);
  }
  async updateInboxDeadline(userId: string, itemId: string, input: Pick<InboxInput, "deadline" | "deadlineTime">, evidenceText: string): Promise<CampusInbox> {
    if (!itemId) throw new Error("更新需要已有信息中心记录的itemId；未知先list_inbox，不可猜测");
    const { deadline } = normalizedDeadline(input, evidenceText);
    if (!deadline) throw new Error("更新截止时间不能为空；未知时不修改已有记录");
    const mutate = (item: CampusInbox) => {
      if (item.status !== "pending_review") throw new Error("记录已确认或不在待确认状态，请在信息中心人工修改");
      return { ...item, extracted: { ...item.extracted, deadline } };
    };
    if (this.pool) return this.pool.transaction(async client => {
      const row = (await client.query<Record<string, unknown>>(`select ${columns} from inbox_items where id=$1 and user_id=$2 for update`, [itemId, userId])).rows[0];
      if (!row) throw new Error("记录不存在或无权更新");
      const updated = mutate(fromRow(row));
      const saved = (await client.query<Record<string, unknown>>(`update inbox_items set extracted=$3::jsonb where id=$1 and user_id=$2 returning ${columns}`, [itemId, userId, JSON.stringify(updated.extracted)])).rows[0];
      return fromRow(saved);
    });
    const item = this.items.get(itemId);
    if (!item || item.userId !== userId) throw new Error("记录不存在或无权更新");
    const updated = mutate(item);
    this.items.set(itemId, updated);
    return structuredClone(updated);
  }
  // 只读：评测/对账用，按 owner 列出信息中心条目（不改变写入语义）。
  async listInbox(userId: string): Promise<CampusInbox[]> {
    if (this.pool) {
      const rows = (await this.pool.query<Record<string, unknown>>(`select ${columns} from inbox_items where user_id=$1 order by created_at,id`, [userId])).rows;
      return rows.map(fromRow);
    }
    return [...this.items.values()].filter((item) => item.userId === userId).map((item) => structuredClone(item));
  }
}
