// QQ/微信群通知导入清洗管线：去噪 → 归一 → 去重 → 日常时间提取。
// 仅处理用户主动转发/粘贴/截图导入的自有群消息（授权个人使用）。
import { beijingDay, daysUntil } from "@/lib/time-policy";

export { cleanGroupMessage, dedupKey } from "../../../../shared/group-message";

// 北京时间（Asia/Shanghai）墙钟时间，用本地 Date 字段承载，供过期判断与日期解析。
export function beijingNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}
export function todayBeijing(): string {
  return beijingDay();
}
export function nowBeijingText(): string {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
// 截止日期是否已过期（早于今天，北京时间）。null 视为未知，不判过期。
export function isExpired(deadline: string | null | undefined): boolean {
  const days = daysUntil(deadline);
  return days !== null && days < 0;
}

const WEEKDAY: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};

export interface DailyTime {
  dueAt: string | null;
  timeText: string;
}

export function extractDailyTime(text: string, ref?: Date): DailyTime {
  // ref=消息发送时间：旧消息的相对日期（今天/明天/周X）相对消息时间解析，而非现在。
  const now = ref ?? beijingNow();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // 明确日期
  const full = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (full) {
    const t = text.match(/(\d{1,2})[:：点](\d{2})?/);
    return { dueAt: `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`, timeText: t ? t[0] : "" };
  }
  const md = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (md) {
    return { dueAt: `${now.getFullYear()}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`, timeText: "" };
  }
  // 相对日
  const rel = text.match(/(今天|明天|后天)/);
  if (rel) {
    const offset = rel[1] === "今天" ? 0 : rel[1] === "明天" ? 1 : 2;
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const t = text.match(/(\d{1,2})[:：点](\d{2})?/);
    return { dueAt: iso(d), timeText: `${rel[1]}${t ? " " + t[0] : ""}` };
  }
  // 周X
  const wk = text.match(/(周|星期)([一二三四五六日天])/);
  if (wk) {
    const target = WEEKDAY[wk[2]];
    const d = new Date(now);
    const diff = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    const t = text.match(/(\d{1,2})[:：点](\d{2})?/);
    return { dueAt: iso(d), timeText: `${wk[0]}${t ? " " + t[0] : ""}` };
  }
  return { dueAt: null, timeText: "" };
}

const DAILY_KEYWORDS = ["调课", "班会", "开会", "集合", "签到", "讲座", "点名", "停课", "补课", "例会"];
export function isDailyNotice(text: string): boolean {
  return DAILY_KEYWORDS.some((k) => text.includes(k));
}
