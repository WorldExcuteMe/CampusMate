import { llmChat, type ChatMessage } from "../llm/proxy";
import { AGENT_TOOLS } from "./tools";
import { ruleExtract } from "../llm/mock";
import { classify } from "./classifier";
import { cleanGroupMessage, extractDailyTime } from "../ingest/clean";
import { fetchGroupNotices, fetchGroups, syncGroupRecords } from "../ingest/qq";
import { uid, type Repository, type Profile } from "../data/types";
import { guardUrl } from "../security/urlGuard";

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
  `当前模式=${mode === "auto" ? "自动（全工具+群摄取+完全访问）" : "日常（聚焦日常事务）"}。` +
  `规则：1) 需要结构化信息/创建任务/检索机会/同步群通知时调用对应工具；2) 回答简洁中文、重点突出；` +
  `3) 机会与结论必须给来源，不编造；无法核验不等于诈骗；4) 群消息先清洗再提取，信息本位（日期/关键词/文件，不限发送人）；5) 日常事务（调课/班会）用 create_daily_task；6) 有效信息须同步进 Inbox/日常任务/机会雷达；` +
  `7) 严禁编造工具结果或群消息：必须通过真实工具调用获取数据，禁止在回复中虚构 <tool_result>、消息、日期、发送人；工具未返回数据时如实说明"未获取到"，不得虚构。` +
  `8) 群定位普适：不同用户的通知群名不同，禁止假设固定群名。先调 list_groups 枚举本机所有群（含 uin/信息密度/内容样例），按样例内容语义识别目标通知群，再用其 uin 调 sync_group_notices；省略 group 时系统按信息密度自动定位。` +
  `9) 完全访问：可用 run_terminal/read_file/write_file/web_fetch/rag_search 访问用户主机的文件/终端/网络。web_fetch 只请求任务给定的真实目标 URL，严禁替换为代理地址。过期通知（截止日期早于今天）不纳入。` +
  `10) 工具调用协议：优先使用原生 tool_calls；若你的接口不支持原生工具调用，则单独输出一个 JSON 对象 {"tool":"工具名","args":{...}} 作为工具指令，等待返回后再继续。` +
  (mode === "daily" ? `日常模式优先处理调课/班会/讲座等含时间信息，谨慎创建机会。` : `自动模式可主动调用 list_groups + sync_group_notices 摄取目标群通知。`);

// 工具端点安全调用：非 OK/空体/非 JSON 一律返回可读 error，绝不抛异常冒泡成「未连接模型」降级。
async function toolPost(url: string, body: unknown): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { error: `工具端点 ${url} HTTP ${res.status}：${text.slice(0, 200) || "空响应"}（确认 llm-proxy 已启动且 vite 代理含 /api）` };
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { return { error: `工具端点 ${url} 返回非 JSON（${text.slice(0, 120) || "空体"}）` }; }
  } catch (e) {
    return { error: `工具端点 ${url} 请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

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
    try {
      let group = String(args.group ?? "").trim();
      let autoLocated = false;
      if (!group) {
        const groups = await fetchGroups();
        const best = groups.slice().sort((a, b) => (b.info_hits - a.info_hits) || (b.info_ratio - a.info_ratio))[0];
        if (!best) return JSON.stringify({ error: "本机未发现任何群，请先登录 QQ 并完成解密" });
        group = String(best.uin);
        autoLocated = true;
      }
      const records = await fetchGroupNotices(group);
      const sum = await syncGroupRecords(records, repo);
      actions.push(`同步群「${group}」${autoLocated ? "（自动定位）" : ""}：Inbox ${sum.inbox} / 日常 ${sum.daily} / 机会 ${sum.opportunity}`);
      return JSON.stringify({ group, autoLocated, ...sum });
    } catch (e) {
      return JSON.stringify({ error: `群摄取失败：${e instanceof Error ? e.message : String(e)}（确认 llm-proxy 已启动、QQ 已登录并解密）` });
    }
  }
  if (name === "list_groups") {
    try {
      const groups = await fetchGroups();
      actions.push(`发现本机 ${groups.length} 个群`);
      return JSON.stringify({ count: groups.length, groups: groups.slice(0, 20) });
    } catch (e) {
      return JSON.stringify({ error: `群发现失败：${e instanceof Error ? e.message : String(e)}（确认 llm-proxy 已启动、QQ 已登录并解密）` });
    }
  }
  if (name === "run_terminal") {
    const command = String(args.command ?? "");
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const r = await toolPost("/api/terminal", { command, cwd });
    actions.push(`终端执行：${command.slice(0, 40)}`);
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify({ stdout: String(r.stdout ?? "").slice(0, 8000), stderr: String(r.stderr ?? "").slice(0, 2000), code: r.code ?? 0 });
  }
  if (name === "read_file") {
    const p = String(args.path ?? "");
    const r = await toolPost("/api/fs/read", { path: p });
    actions.push(`读取文件：${p}`);
    return JSON.stringify(r.error ? { error: r.error } : { path: p, content: String(r.content ?? "").slice(0, 12000) });
  }
  if (name === "write_file") {
    const p = String(args.path ?? "");
    const content = String(args.content ?? "");
    const r = await toolPost("/api/fs/write", { path: p, content });
    actions.push(`写入文件：${p}`);
    return JSON.stringify(r.error ? { error: r.error } : { ok: true, path: p });
  }
  if (name === "web_fetch") {
    // 仅请求任务给定的真实目标 URL；URL 守卫拒绝内网/代理替换地址，每次重新核对来源
    const target = String(args.url ?? "");
    const g = guardUrl(target);
    if (!g.ok) return JSON.stringify({ error: `URL 守卫拦截：${g.reason}（须为任务给定的真实公开目标，禁止代理/内网替换）` });
    const r = await toolPost("/api/web/fetch", { url: g.normalized });
    actions.push(`网页抓取：${target}`);
    return JSON.stringify(r.error ? { error: r.error } : { url: target, status: r.status, text: String(r.text ?? "").slice(0, 12000) });
  }
  if (name === "rag_search") {
    const query = String(args.query ?? "");
    const k = Number(args.k ?? 5);
    const r = await toolPost("/api/rag/search", { query, k });
    actions.push(`RAG 检索：${query}`);
    return JSON.stringify(r.error ? { error: r.error } : { results: r.results ?? [] });
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

// 模型无关回退：不支持原生 tool_calls 的模型可输出 JSON 工具指令，这里解析执行。
function parseJsonTool(content: string): { name: string; args: Record<string, unknown> } | null {
  const candidates: string[] = [];
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const brace = content.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  const known = new Set(AGENT_TOOLS.map((t) => t.function.name));
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim());
      const name = obj.tool ?? obj.name ?? obj.function?.name;
      if (typeof name === "string" && known.has(name)) {
        let args = obj.args ?? obj.arguments ?? obj.parameters ?? {};
        if (typeof args === "string") args = JSON.parse(args);
        return { name, args };
      }
    } catch {}
  }
  return null;
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
    for (let i = 0; i < 6; i++) {
      const res = await llmChat({ providerId: opts.providerId, messages, tools });
      usage = { input: usage.input + res.usage.input, output: usage.output + res.usage.output };
      model = res.model;
      if (res.toolCalls.length > 0) {
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
          const out = await executeTool(call.function.name, args, opts.repository, opts.profile, actions);
          messages.push({ role: "tool", content: out, tool_call_id: call.id });
        }
        continue;
      }
      if (/<tool_result/i.test(res.content)) {
        return {
          reply: "已拦截虚构的工具结果：模型未真实调用工具。请确认本地 llm-proxy 已启动、环境已配置后重试，以真实抓取群消息。",
          actions, usage, model, mock: false,
        };
      }
      const jt = parseJsonTool(res.content);
      if (jt) {
        messages.push({ role: "assistant", content: res.content });
        const out = await executeTool(jt.name, jt.args, opts.repository, opts.profile, actions);
        messages.push({ role: "user", content: `工具 ${jt.name} 返回：${out}` });
        continue;
      }
      return { reply: res.content, actions, usage, model, mock: false };
    }
    return { reply: "（达到工具调用上限，请细化问题）", actions, usage, model, mock: false };
  } catch (err) {
    // 真实调用中断时的降级：规则提取 + 明确标识（区分中断原因，不误报为「未连接模型」）
    const e = ruleExtract(cleanGroupMessage(opts.message), null);
    const reason = err instanceof Error ? err.message : "proxy unavailable";
    return {
      reply: `真实模型调用中断（${reason}）。以下为规则提取（Mock，非真实模型）：\n标题：${e.title}\n类别：${e.category}\n截止：${e.deadline ?? "未识别"}\n排查：确认本地 llm-proxy(8787) 已启动、vite 代理含 /api、模型供应商已配置密钥。`,
      actions,
      usage,
      model: "rule-based-mock",
      mock: true,
    };
  }
}