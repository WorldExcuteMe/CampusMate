import { createHash } from "node:crypto";
import { cleanGroupMessage, dedupKey } from "../../../shared/group-message.ts";
import { validDate } from "../../../shared/calendar.ts";
import { text, tool, type WorkspaceTool } from "./workspace-tools.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";

const notice = /通知|公告|上课|停课|补课|调课|报名|截至|截止|提交|交回|汇总表|考试|奖学金|竞赛|比赛|实习|科研|班会|讲座|活动|招募|\d{1,2}[月日号]|\d{1,2}:\d{2}/;
type Export = { uin?: unknown; group?: unknown; groupId?: unknown; platform?: string; records?: unknown[] };

export function groupExport(content: string, platform: "qq" | "wechat", expectedGroup: string, limit: number) {
  const payload = JSON.parse(content) as Export;
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.records) || payload.records.length > 2000) throw new Error("群导出应包含不超过 2000 条 records");
  const identity = platform === "qq" ? payload.uin ?? payload.groupId : payload.groupId ?? payload.group;
  if (String(identity ?? "") !== expectedGroup || (payload.platform && payload.platform !== platform)) throw new Error("导出文件中的群标识与目标不一致");
  const records: { time?: string; text: string; attachment?: string }[] = [];
  const seen = new Set<string>();
  for (const raw of payload.records) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { display?: unknown; text?: unknown; time?: unknown; attachment?: { name?: unknown } };
    const original = typeof row.display === "string" ? row.display : typeof row.text === "string" ? row.text : "";
    const message = cleanGroupMessage(original).slice(0, 1000);
    const attachment = typeof row.attachment?.name === "string" ? row.attachment.name.slice(0, 120) : undefined;
    if (!notice.test(message) && !attachment) continue;
    const time = typeof row.time === "string" && validDate(row.time.slice(0, 10)) ? row.time.slice(0, 25) : undefined;
    const fingerprint = dedupKey(message + (attachment ?? ""));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    records.push({ time, text: message, attachment });
  }
  records.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
  const dated = records.flatMap((row) => row.time ? [row.time] : []);
  return { platform, group: expectedGroup, input: payload.records.length, matched: records.length,
    range: dated.length ? { start: dated.at(-1), end: dated[0] } : null,
    records: records.slice(0, limit), truncated: records.length > limit,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export function groupExportTool(files: WorkspaceFiles, allowedQQ: string[], allowedWeChat: string[]): WorkspaceTool {
  return {
    definition: tool("workspace_group_export", "读取用户授权放入本地工作区的群聊 JSON 导出，校对目标群并返回筛选后的消息。", {
      path: text, platform: { ...text, enum: ["qq", "wechat"] }, group: text, limit: { type: "integer" },
    }, ["path", "platform", "group"]),
    capability: "ingest.qq",
    privateSource: true,
    approval: (args) => `读取 ${args.platform} 群 ${args.group} 的本地文件 ${args.path}`,
    execute: async ({ path, platform, group, limit = 10 }) => {
      const selected = platform === "qq" ? allowedQQ : allowedWeChat;
      if (!selected.includes(String(group))) throw new Error("该群未被授权给此工作区");
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 12) throw new Error("最多读取 12 条匹配消息");
      return groupExport(await files.readText(String(path)), platform as "qq" | "wechat", String(group), Number(limit));
    },
  };
}
