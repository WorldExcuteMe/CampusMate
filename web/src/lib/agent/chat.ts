import { llmChat, type ChatMessage } from "../llm/proxy";
import { AGENT_TOOLS } from "./tools";
import { ruleExtract } from "../llm/mock";
import { classify } from "./classifier";
import { cleanGroupMessage, extractDailyTime } from "../ingest/clean";
import { fetchGroupNotices, syncGroupRecords } from "../ingest/qq";
import { uid, type Repository, type Profile } from "../data/types";

export interface ChatOutcome {
  reply: string;
  actions: string[];
  usage: { input: number; output: number };
  model: string;
  mock: boolean;
  needsSetup?: boolean;
}

// 意图自判：仅当用户提示词涉及 QQ/微信/群信息抓取时才走摄取 workflow 与环境配置。
const INGEST_RE = /(QQ|微信|wechat|群|抓取|同步|摄取)/i;
export function detectIngestIntent(message: string): boolean {
  return INGEST_RE.test(message);
}

const SYSTEM = (profile: Profile, mode: "auto" | "daily") =>
  `你是 CampusMate 校园机会管家，面向大学生的信息与机会管理 Agent。` +
  `用户画像：专业=${profile.major}，年级=${profile.grade}，兴趣=${profile.interests.join("、")}，技能=${profile.skills.join("、")}，目标=${profile.goals.join("、")}。` +
  `当前模式=${mode === "auto" ? "自动（全工具+群摄取）" : "日常（聚焦日常事务）"}。` +
  `规则：1) 需要结构化信息/创建任务/检索机会/同步群通知时调用对应工具；2) 回答简洁中文、重点突出；` +
  `3) 机会与结论必须给来源，不编造；无法核验不等于诈骗；4) 群消息先清洗再提取，信息本位（日期/关键词/文件，不限发送人）；5) 日常事务（调课/班会）用 create_daily_task；6) 有效信息须同步进 Inbox/日常任务/机会雷达。` +
  (mode === "daily" ? `日常模式优先处理调课/班会/讲座等含时间信息，谨慎创建机会。` : `自动模式可主动调用 sync_group_notices 摄取目标群通知。`);

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  repo: Repository,
  profile: Profile,
  actions: string[],
): Promise<string> {
  if (name === "extract_notice") {
    const raw = cleanGroupMessage(String(args.rawText ?? ""));
    const e = ruleExtract(raw, null);
    const c = classify(e, raw);
    await repo.createInbox({
      id: uid(), userId: profile.id, rawText: raw, sourceUrl: null, sourceType: "text",
      extracted: e, classification: c, status: "pending_review",
      createdAt: new Date().toISOString(), demo: repo.mode === "demo",
    });
    actions.push(`提取并同步 Inbox：${e.title}`);
    return JSON.stringify(e);
  }
  if (name === "sync_group_notices") {
    const group = String(args.group ?? "网安2401官方群");
    const records = await fetchGroupNotices(group);
    const sum = await syncGroupRecords(records, repo);
    actions.push(`同步群「${group}」：Inbox ${sum.inbox} / 日常 ${sum.daily} / 机会 ${sum.opportunity}`);
    return JSON.stringify({ group, ...sum });
  }
  if (name === "create_daily_task") {
    const t = extractDailyTime(String(args.timeText ?? "") + " " + String(args.title ?? ""));
    await repo.createTask({
      id: uid(),
      userId: profile.id,
      title: String(args.title ?? "日常任务"),
      dueAt: (args.dueAt as string) || t.dueAt,
      status: "todo",
      priority: 65,
      inboxItemId: null,
      estimateHours: 1,
      kind: "daily",
      timeText: String(args.timeText ?? "") || t.timeText,
      createdAt: new Date().toISOString(),
      demo: repo.mode === "demo",
    });
    actions.push(`创建日常任务：${args.title}`);
    return JSON.stringify({ ok: true, dueAt: (args.dueAt as string) || t.dueAt });
  }
  if (name === "search_opportunities") {
    const q = String(args.query ?? "").toLowerCase();
    const cat = String(args.category ?? "");
    const opps = await repo.listOpportunities();
    const hit = opps
      .filter((o) => (!cat || o.type === cat) && (!q || o.title.toLowerCase().includes(q) || o.description.toLowerCase().includes(q)))
      .slice(0, 6)
      .map((o) => ({ title: o.title, type: o.type, deadline: o.deadline, source: o.sourceUrl }));
    actions.push(`检索机会：${args.query}`);
    return JSON.stringify({ results: hit, note: "来源为官方白名单/公开渠道目录；实时全网搜索适配器见 docs/AGENT_RESEARCH_AND_TUNING.md" });
  }
  if (name === "match_opportunities") {
    const opps = await repo.listOpportunities();
    const scored = opps
      .map((o) => {
        let s = 0;
        const reasons: string[] = [];
        const text = `${o.title} ${o.description}`.toLowerCase();
        if (profile.interests.some((i) => text.includes(i.toLowerCase()))) { s += 25; reasons.push("兴趣相关"); }
        if (profile.skills.some((k) => text.includes(k.toLowerCase()))) { s += 25; reasons.push("技能匹配"); }
        if (profile.goals.some((g) => text.includes(g.slice(0, 2)))) { s += 20; reasons.push("契合目标"); }
        return { title: o.title, score: s, reasons };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Number(args.limit ?? 5));
    actions.push("个性化匹配");
    return JSON.stringify(scored);
  }
  return JSON.stringify({ error: `unknown tool ${name}` });
}

export async function runChat(opts: {
  message: string;
  history: ChatMessage[];
  repository: Repository;
  profile: Profile;
  providerId?: string;
  mode?: "auto" | "daily";
}): Promise<ChatOutcome> {
  const actions: string[] = [];
  const mode = opts.mode ?? "auto";
  const ingestIntent = detectIngestIntent(opts.message);
  let needsSetup = false;
  if (ingestIntent && mode === "auto") {
    try {
      const env = await (await fetch("/api/env/check")).json();
      if (!(env.qqKey || env.wechatKey)) needsSetup = true;
    } catch {}
  }
  const tools =
    mode === "daily"
      ? AGENT_TOOLS.filter((t) => ["extract_notice", "create_daily_task"].includes(t.function.name))
      : ingestIntent
        ? AGENT_TOOLS
        : AGENT_TOOLS.filter((t) => t.function.name !== "sync_group_notices");
  if (needsSetup) {
    return {
      reply: "检测到你要从 QQ/微信获取信息，已打开环境配置引导。完成配置后重新发送该请求，即可自动摄取并更新 Dashboard。",
      actions,
      usage: { input: 0, output: 0 },
      model: "intent-gate",
      mock: false,
      needsSetup: true,
    };
  }
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM(opts.profile, mode) },
    ...opts.history,
    { role: "user", content: opts.message },
  ];
  let usage = { input: 0, output: 0 };
  let model = "unknown";
  try {
    for (let i = 0; i < 4; i++) {
      const res = await llmChat({ providerId: opts.providerId, messages, tools });
      usage = { input: usage.input + res.usage.input, output: usage.output + res.usage.output };
      model = res.model;
      if (res.toolCalls.length === 0) {
        return { reply: res.content, actions, usage, model, mock: false };
      }
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
        const out = await executeTool(call.function.name, args, opts.repository, opts.profile, actions);
        messages.push({ role: "tool", content: out, tool_call_id: call.id });
      }
    }
    return { reply: "（达到工具调用上限，请细化问题）", actions, usage, model, mock: false };
  } catch (err) {
    // 代理/模型不可用时的降级：规则提取 + 明确标识
    const e = ruleExtract(cleanGroupMessage(opts.message), null);
    return {
      reply: `当前未连接真实模型（${err instanceof Error ? err.message : "proxy unavailable"}）。以下为规则提取（Mock）：\n标题：${e.title}\n类别：${e.category}\n截止：${e.deadline ?? "未识别"}\n可在「Agent 设置」配置模型供应商后启用真实对话。`,
      actions,
      usage,
      model: "rule-based-mock",
      mock: true,
    };
  }
}