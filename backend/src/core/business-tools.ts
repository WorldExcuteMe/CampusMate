import type { ToolDef } from './types.ts';
import { validDate } from '../../../shared/calendar.ts';

export const BUSINESS_TOOL_NAMES = ['save_to_inbox', 'create_daily_task', 'set_growth_goal', 'merge_inbox'] as const;
export type BusinessToolName = typeof BUSINESS_TOOL_NAMES[number];
export interface BusinessOwner { userId: string; taskId: string; }
export type BusinessResult = { ok: true; storage: 'postgres'; [key: string]: unknown };
export interface BusinessStore {
  execute(name: BusinessToolName, args: Record<string, unknown>, owner: BusinessOwner): Promise<BusinessResult>;
}
const text = { type: 'string' };
const date = { type: ['string', 'null'], description: '明确的 YYYY-MM-DD 日期；未知用 null，不推测。' };
export const BUSINESS_TOOLS: ToolDef[] = [
  { type: 'function', function: { name: 'save_to_inbox', description: '将一条通知真实保存到本人收件箱，等待人工确认；每条独立通知调用一次。保存不代表已核验。来源可为群号、消息时间或公开链接。', parameters: { type: 'object', properties: { title: text, summary: text, category: { type: 'string', enum: ['competition', 'internship', 'research', 'scholarship', 'activity', 'opensource', 'notice', 'daily'] }, deadline: date, source: text }, required: ['title', 'summary'] } } },
  { type: 'function', function: { name: 'create_daily_task', description: '真实创建本人的日常待办（班会、调课、交材料等），保存后可在任务与目标查看。未知日期必须留空；timeText 原样保留已知时间地点。', parameters: { type: 'object', properties: { title: text, dueAt: date, timeText: text }, required: ['title'] } } },
  { type: 'function', function: { name: 'set_growth_goal', description: '原子保存本人成长目标、画像目标和对应待办；用户可在成长中心查看。重复相同目标和日期不会生成重复任务。', parameters: { type: 'object', properties: { goal: text, dueAt: date }, required: ['goal'] } } },
  { type: 'function', function: { name: 'merge_inbox', description: '整理本人已有通知：同一事件的重复通知归档（不删除），保留原文与合并引用；截止/年度/轮次冲突不合并，不创建新通知。所有更改在一个事务内完成。', parameters: { type: 'object', properties: {} } } },
];

export function businessText(args: Record<string, unknown>, name: string, max: number, required = false): string {
  const raw = args[name];
  if (raw === undefined || raw === null) { if (required) throw new Error(`${name} 不能为空`); return ''; }
  if (typeof raw !== 'string' || raw.length > max || /\u0000/.test(raw)) throw new Error(`${name} 格式无效或超过 ${max} 字符`);
  const value = raw.trim();
  if (required && !value) throw new Error(`${name} 不能为空`);
  return value;
}
export function businessDate(args: Record<string, unknown>, name: string): string | null {
  const value = businessText(args, name, 10);
  if (value && !validDate(value)) throw new Error(`${name} 必须是有效的 YYYY-MM-DD 日期`);
  return value || null;
}

export interface MergeNotice { id: string; title: string; deadline: string | null; sourceUrl: string | null; status: string; mergedFrom: string[]; }
function norm(title: string): string { return title.toLowerCase().replace(/^(关于|通知|公告|提醒)[:：]?/, '').replace(/[\s，,。.！!？?：:；;、]/g, ''); }
function rounds(title: string): string { return (title.match(/20\d{2}|第[一二三四五六七八九十\d]+届|\d{1,2}(?:-\d{1,2})?月/g) ?? []).join('|'); }
function sameEvent(a: MergeNotice, b: MergeNotice): boolean {
  // A common URL/title must never override conflicting dates or event rounds.
  if (a.deadline && b.deadline && a.deadline !== b.deadline) return false;
  const ra = rounds(a.title), rb = rounds(b.title);
  if (ra && rb && ra !== rb) return false;
  if (a.sourceUrl && b.sourceUrl && a.sourceUrl !== b.sourceUrl) return false;
  const na = norm(a.title), nb = norm(b.title);
  if (na === nb) return true;
  // Conservative matching only: don't archive vaguely similar independent notices.
  return Boolean(a.sourceUrl && a.sourceUrl === b.sourceUrl && Math.min(na.length, nb.length) >= 6 && (na.includes(nb) || nb.includes(na)));
}
export function planInboxMerges(items: MergeNotice[]): { canonical: MergeNotice; duplicates: MergeNotice[]; mergedFrom: string[] }[] {
  const groups: MergeNotice[][] = [];
  const score = (n: MergeNotice) => (n.status === 'confirmed' ? 8 : 0) + (n.deadline ? 4 : 0) + (n.sourceUrl ? 2 : 0);
  for (const item of items.filter(n => !['archived', 'ignored', 'failed'].includes(n.status)).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))) {
    // Complete linkage prevents an undated notice bridging two conflicting deadlines.
    const group = groups.find(g => g.every(other => sameEvent(item, other)));
    if (group) group.push(item); else groups.push([item]);
  }
  return groups.filter(g => g.length > 1).map(([canonical, ...duplicates]) => ({ canonical, duplicates, mergedFrom: [...new Set([...canonical.mergedFrom, ...duplicates.flatMap(d => [d.id, ...d.mergedFrom])])].filter(id => id !== canonical.id).sort() }));
}
