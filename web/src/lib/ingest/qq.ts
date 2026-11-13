import { ruleExtract } from "../llm/mock";
import { classify } from "../agent/classifier";
import { cleanGroupMessage, dedupKey, extractDailyTime, isDailyNotice, isExpired, todayBeijing } from "./clean";
import { mergeInbox } from "./dedupe";
import { uid, type Repository } from "../data/types";

export interface GroupRecord {
  time: string;
  sender: string;
  type: number;
  text: string;
  display: string;
  reasons: string[];
  attachment?: { kind: string; name: string; source: string | null };
}

export interface SyncSummary {
  inbox: number;
  daily: number;
  opportunity: number;
  skipped: number;
  expired: number;
  merged: number;
}

const OPP_KEYWORDS = ["竞赛", "比赛", "大赛", "实习", "招聘", "科研", "奖学金", "助学金", "开源", "招募"];
const SEEN_KEY = "campusmate.group.seen";

export interface GroupInfo {
  uin: number;
  name: string;
  total: number;
  scanned: number;
  info_hits: number;
  info_ratio: number;
  samples: { time: string; text: string }[];
}

// 普适群发现：枚举本机所有群，供 agent 按内容/信息密度自动定位通知群（不硬编码群名）。
export async function fetchGroups(): Promise<GroupInfo[]> {
  const res = await fetch("/api/ingest/qq/groups");
  if (!res.ok) throw new Error(`群发现失败 HTTP ${res.status}`);
  const data = await res.json();
  return data.groups ?? [];
}

export async function fetchGroupNotices(group: string): Promise<GroupRecord[]> {
  const isUin = /^\d{6,}$/.test(group.trim());
  const qs = isUin ? `uin=${encodeURIComponent(group.trim())}` : `name=${encodeURIComponent(group)}`;
  const res = await fetch(`/api/ingest/qq?${qs}`);
  if (!res.ok) throw new Error(`群摄取失败 HTTP ${res.status}`);
  const data = await res.json();
  return data.records ?? [];
}

export async function fetchWechatNotices(name: string): Promise<GroupRecord[]> {
  const res = await fetch(`/api/ingest/wechat?name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`微信摄取失败 HTTP ${res.status}`);
  const data = await res.json();
  return (data.records ?? []).map((r: GroupRecord) => ({ ...r, sender: r.sender ?? "wechat" }));
}

// 信息本位：不关注发送人，只按 日期/关键词/文件 过滤后的记录同步进容器。
export async function syncGroupRecords(records: GroupRecord[], repo: Repository): Promise<SyncSummary> {
  const seen: string[] = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
  const sum: SyncSummary = { inbox: 0, daily: 0, opportunity: 0, skipped: 0, expired: 0, merged: 0 };
  const userId = repo.mode === "demo" ? "demo-user" : "me";
  const today = todayBeijing();

  for (const r of records) {
    const raw = cleanGroupMessage(r.display || r.text);
    if (!raw) { sum.skipped++; continue; }
    const key = dedupKey(raw);
    if (seen.includes(key)) { sum.skipped++; continue; }
    seen.push(key);

    const extracted = ruleExtract(raw, null);
    // 结合当前北京时间：截止日期已过的通知不纳入（过期历史不作为当前机会/待办）。
    if (isExpired(extracted.deadline)) { sum.expired++; continue; }
    const classification = classify(extracted, raw);
    const base = {
      userId, rawText: raw, sourceUrl: null, sourceType: "text" as const,
      extracted, classification, createdAt: new Date().toISOString(), demo: repo.mode === "demo",
    };

    if (isDailyNotice(raw)) {
      // 相对日期相对消息发送时间解析；解析出的 dueAt 已过则视为过期。
      const t = extractDailyTime(raw, r.time ? new Date(r.time) : undefined);
      if (t.dueAt && t.dueAt < today) { sum.expired++; continue; }
      await repo.createTask({
        id: uid(), userId, title: raw.split("\n")[0].slice(0, 40), dueAt: t.dueAt,
        status: "todo", priority: 65, inboxItemId: null, estimateHours: 1,
        kind: "daily", timeText: t.timeText, createdAt: base.createdAt, demo: base.demo,
      });
      sum.daily++;
    } else if (OPP_KEYWORDS.some((k) => raw.includes(k))) {
      const item = await repo.createInbox({ ...base, id: uid(), status: "pending_review" });
      await repo.createOpportunity({
        id: uid(), title: extracted.title, type: extracted.category, organizer: extracted.org,
        description: extracted.summary, conditions: extracted.conditions, deadline: extracted.deadline,
        sourceUrl: `qq://group/${r.sender}`, sourceType: "group", collectedAt: base.createdAt,
        status: "active", demo: base.demo,
      });
      sum.inbox++; sum.opportunity++;
      void item;
    } else {
      await repo.createInbox({ ...base, id: uid(), status: "pending_review" });
      sum.inbox++;
    }
  }
  const mg = await mergeInbox(repo);
  sum.merged = mg.merged;
  localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-500)));
  return sum;
}