// 通知语义去重合并：把本质指向同一信息源/同一事件的通知归一展示，减少冗余。
// 合并键 = 归一标题 + 事件核心 + 截止/轮次 + 来源URL；不同轮次（如3月vs9-11月）不合并。
// 阈值用用户真实群通知语料调校（完全重复/同事件变体合并，跨轮次保留）。
import type { Repository, InboxItem } from "../data/types";

export interface NoticeSig {
  title: string;
  deadline?: string | null;
  sourceUrl?: string | null;
}

export function normalizeTitle(t: string): string {
  let s = t ?? "";
  s = s.replace(/\[(QQ小程序|微信小程序|小程序|链接|文件|图片)\]/g, "");
  s = s.replace(/^(关于|通知|公告|提醒)[:：]?/g, "");
  s = s.replace(/[（(]\d+[)）]/g, "");
  s = s.replace(/第[一二三四五六七八九十\d]+号/g, "");
  s = s.replace(/[\s　]+/g, "");
  s = s.replace(/[，,。.！!？?：:；;、]/g, "");
  return s.toLowerCase();
}

// 事件核心：去掉机构/年份/届次/级别/公文套语，留下事件本体（如"模拟面试大赛"）。
export function eventCore(t: string): string {
  let s = normalizeTitle(t);
  s = s.replace(/(计算机科学与技术学院|大数据学院|经济与管理学院|太原理工大学|学院|学校)/g, "");
  s = s.replace(/(20\d{2}年?|第[一二三四五六七八九十\d]+届|全国|校内|院级|省级|校级)/g, "");
  s = s.replace(/(关于举办|关于组织参加|关于做好|的通知|通知|报名|申报|工作)/g, "");
  return s;
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function hasRoundConflict(a: NoticeSig, b: NoticeSig): boolean {
  const na = normalizeTitle(a.title);
  const nb = normalizeTitle(b.title);
  const ra = (na.match(/\d{1,2}(-\d{1,2})?月/) || [])[0];
  const rb = (nb.match(/\d{1,2}(-\d{1,2})?月/) || [])[0];
  return !!((ra && rb && ra !== rb) || (a.deadline && b.deadline && a.deadline !== b.deadline));
}

export function noticeSimilarity(a: NoticeSig, b: NoticeSig): number {
  // 冲突优先于同 URL/同标题；共用页面不代表同一轮报名。
  if (hasRoundConflict(a, b)) return 0.1;
  if (a.sourceUrl && b.sourceUrl && a.sourceUrl === b.sourceUrl) return 1;
  const na = normalizeTitle(a.title);
  const nb = normalizeTitle(b.title);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ca = eventCore(a.title);
  const cb = eventCore(b.title);
  let s = dice(ca, cb);
  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (short.length >= 4 && long.includes(short)) s = Math.max(s, 0.85);
  else if (na.includes(nb) || nb.includes(na)) s = Math.max(s, 0.9);
  return s;
}

export const MERGE_THRESHOLD = 0.6;

export function clusterNotices<T extends NoticeSig>(items: T[], threshold = MERGE_THRESHOLD): T[][] {
  // 按内容稳定排序，不依赖仓库 createdAt、数据库行顺序或原地排序副作用。
  const key = (s: NoticeSig) => JSON.stringify([normalizeTitle(s.title), s.deadline ?? "", s.sourceUrl ?? "", s.title]);
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const ordered = items.slice().sort((a, b) => compare(key(a), key(b)));
  const parent = ordered.map((_, i) => i);
  const members = ordered.map((item) => [item]);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const edges: { a: number; b: number; score: number }[] = [];
  for (let a = 0; a < ordered.length; a++) {
    for (let b = a + 1; b < ordered.length; b++) {
      const score = noticeSimilarity(ordered[a], ordered[b]);
      if (score >= threshold && !hasRoundConflict(ordered[a], ordered[b])) edges.push({ a, b, score });
    }
  }
  // 合并所有连通匹配，而非找到首组即停止。强匹配优先，平分时按稳定内容顺序处理。
  edges.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  for (const edge of edges) {
    const a = find(edge.a);
    const b = find(edge.b);
    if (a === b) continue;
    // 无日期的桥接通知也不能把两个已知截止/轮次冲突的组串起来。
    if (members[a].some((x) => members[b].some((y) => hasRoundConflict(x, y)))) continue;
    parent[b] = a;
    members[a].push(...members[b]);
    members[b] = [];
  }
  return members.filter((group) => group.length > 0);
}

function canonScore(s: NoticeSig & { item?: InboxItem }): number {
  return (s.deadline ? 2 : 0) + (s.sourceUrl ? 2 : 0) + s.title.length / 100;
}

// 合并 Inbox（含历史通知）：同源同事件归一，规范条富化合并引用，重复条归档。
export async function mergeInbox(repo: Repository): Promise<{ merged: number; clusters: number }> {
  const items = (await repo.listInbox()).filter((i) => i.status !== "archived" && i.status !== "ignored");
  const sigs = items.map((item) => ({
    item,
    title: item.extracted.title,
    deadline: item.extracted.deadline,
    sourceUrl: item.sourceUrl ?? item.extracted.sourceUrl,
  }));
  const clusters = clusterNotices(sigs);
  let merged = 0;
  let multi = 0;
  for (const c of clusters) {
    if (c.length < 2) continue;
    multi++;
    const canon = c.slice().sort((x, y) => canonScore(y) - canonScore(x))[0];
    const dups = c.filter((x) => x !== canon);
    await repo.updateInbox(canon.item.id, {
      extracted: {
        ...canon.item.extracted,
        summary: `${canon.item.extracted.summary} [已合并${dups.length}条同源通知]`.slice(0, 200),
      },
      mergedFrom: [...(canon.item.mergedFrom ?? []), ...dups.map((d) => d.item.id)],
    });
    for (const d of dups) await repo.updateInbox(d.item.id, { status: "archived" });
    merged += dups.length;
  }
  return { merged, clusters: multi };
}
