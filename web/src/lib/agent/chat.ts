import { llmChat, type ChatMessage } from "../llm/proxy";
import { errorMessage, isTransportError } from "../llm/errors";
import { AGENT_TOOLS } from "./tools";
import { ruleExtract } from "../llm/mock";
import { classify } from "./classifier";
import { cleanGroupMessage, extractDailyTime, nowBeijingText } from "../ingest/clean";
import { fetchGroupNotices, fetchGroups, syncGroupRecords } from "../ingest/qq";
import { mergeInbox } from "../ingest/dedupe";
import { uid, type Repository, type Profile, type Opportunity, type VerificationReport } from "../data/types";
import { guardUrl } from "../security/urlGuard";
import { composeContext, trimToBudget, resolveContextCap, messagesTokens, toolsTokens } from "./context";
import { DEFAULT_REASONING } from "../llm/reasoning";
import { detectScope, allowedTools, checkToolScope, type TaskScope } from "./scope";
import { setPlan, memoryPrompt, appendMemory } from "./memory";

export interface ChatOutcome {
  reply: string;
  actions: string[];
  usage: { input: number; output: number };
  model: string;
  mock: boolean;
  needsSetup?: boolean;
  contextUsed?: number;
  contextCap?: number;
  compressed?: boolean;
  pruned?: boolean;
}

// 意图自判：仅当用户提示词涉及 QQ/微信/群信息抓取时才走摄取 workflow 与环境配置。
const INGEST_RE = /(QQ|微信|wechat|群|抓取|同步|摄取)/i;
export function detectIngestIntent(message: string): boolean {
  return INGEST_RE.test(message);
}

const SYSTEM = (profile: Profile, mode: "auto" | "daily") =>
  `你是 CampusMate 校园机会管家，面向大学生的信息与机会管理 Agent。` +
  `当前北京时间=${nowBeijingText()}（据此判断过期：截止/日期早于今天=已过期）。` +
  `用户画像：专业=${profile.major}，年级=${profile.grade}，兴趣=${profile.interests.join("、")}，技能=${profile.skills.join("、")}，目标=${profile.goals.join("、")}。` +
  `当前模式=${mode === "auto" ? "自动（全工具+群摄取+完全访问）" : "日常（聚焦日常事务）"}。` +
  `规则：1) 需要结构化信息/创建任务/检索机会/同步群通知时调用对应工具；2) 回答简洁中文、重点突出；` +
  `3) 机会与结论必须给来源，不编造；无法核验不等于诈骗；4) 群消息先清洗再提取，信息本位（日期/关键词/文件，不限发送人）；5) 日常事务（调课/班会）用 create_daily_task；6) 有效信息须落库：总结群通知后对每条独立有效通知调 save_to_inbox 写入 Inbox，含时间的日常事务调 create_daily_task；merge_inbox 仅去重不新建；归纳须覆盖全部类别（赛事/实习/科研/奖助/生活/教务/活动/其他），不得只报赛事；` +
  `7) 严禁编造工具结果或群消息：必须通过真实工具调用获取数据，禁止在回复中虚构 <tool_result>、消息、日期、发送人；工具未返回数据时如实说明"未获取到"，不得虚构。` +
  `8) 群定位普适：不同用户的通知群名不同，禁止假设固定群名。先调 list_groups 枚举本机所有群（含 uin/信息密度/内容样例），按样例内容语义识别目标通知群，再用其 uin 调 sync_group_notices；省略 group 时系统按信息密度自动定位。` +
  `9) 完全访问：可用 run_terminal/read_file/write_file/web_fetch/rag_search 访问用户主机的文件/终端/网络。web_fetch 只请求任务给定的真实目标 URL，严禁替换为代理地址。` +
  `10) 时间本位：一切截止/日期与当前北京时间比较。已过期（早于今天）的通知/机会不得作为当前可行动项呈现；总结群通知或 RAG 历史时只呈现未过期项，过期项仅在用户明确要历史回顾时列出并标注"已过期"。无明确截止的旧消息须结合消息时间判断时效，不得把陈旧信息当新通知。` +
  `11) 工具调用协议：优先使用原生 tool_calls；若你的接口不支持原生工具调用，则单独输出一个 JSON 对象 {"tool":"工具名","args":{...}} 作为工具指令，等待返回后再继续。` +
  `12) 对话体感：回复只给面向用户的结论与必要来源/截止/匹配建议，不提及工具名、调用过程、内部机制、"已同步/RAG/合并/归一"等噪声；不反问确认除非缺关键信息；落库动作静默完成只在结尾一句告知已写入几条。` +
  (mode === "daily" ? `日常模式优先处理调课/班会/讲座等含时间信息，谨慎创建机会。` : `自动模式可主动调用 list_groups + sync_group_notices 摄取目标群通知。`);

// 工具端点安全调用：非 OK/空体/非 JSON 一律返回可读 error，绝不抛异常冒泡成「未连接模型」降级。
async function toolPost(url: string, body: unknown): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) return { error: `工具端点 ${url} HTTP ${res.status}：${text.slice(0, 200) || "空响应"}（确认 llm-proxy 已启动且 vite 代理含 /api）` };
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { return { error: `工具端点 ${url} 返回非 JSON（${text.slice(0, 120) || "空体"}）` }; }
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error && e.name === "AbortError" ? "TOOL_TIMEOUT（60s 超时）" : errorMessage(e);
    return { error: `工具端点 ${url} 请求失败：${msg}` };
  }
}

// 工具执行安全边界：任何工具/DB/网络异常都转成可读 error 观测回传给模型，绝不冒泡中断模型循环。
// 根因修复：Supabase `throw error` 抛的是普通对象，曾冒泡到 runChat 被 String() 成 [object Object]
// 并误判为「真实模型调用中断」整体降级 Mock。现在工具失败只是一条观测，模型据此重试/如实说明。
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  repo: Repository,
  profile: Profile,
  actions: string[],
  scope: TaskScope,
): Promise<string> {
  try {
    return await dispatchTool(name, args, repo, profile, actions, scope);
  } catch (e) {
    return JSON.stringify({ error: `工具 ${name} 执行失败：${errorMessage(e)}` });
  }
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  repo: Repository,
  profile: Profile,
  actions: string[],
  scope: TaskScope,
): Promise<string> {
  // 执行期门控：越界工具拒绝；源内检索/同步强制限定用户指定群（确定性，不依赖模型自觉）
  const gate = checkToolScope(scope, name, args);
  if (!gate.ok) return JSON.stringify({ error: gate.reason });
  args = gate.args ?? args;
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
      actions.push(`同步群「${group}」${autoLocated ? "（自动定位）" : ""}：Inbox ${sum.inbox} / 日常 ${sum.daily} / 机会 ${sum.opportunity} / 过期过滤 ${sum.expired} / 语义合并 ${sum.merged}`);
      return JSON.stringify({ group, autoLocated, ...sum });
    } catch (e) {
      return JSON.stringify({ error: `群摄取失败：${errorMessage(e)}（确认 llm-proxy 已启动、QQ 已登录并解密）` });
    }
  }
  if (name === "list_groups") {
    try {
      const groups = await fetchGroups();
      actions.push(`发现本机 ${groups.length} 个群`);
      return JSON.stringify({ count: groups.length, groups: groups.slice(0, 20) });
    } catch (e) {
      return JSON.stringify({ error: `群发现失败：${errorMessage(e)}（确认 llm-proxy 已启动、QQ 已登录并解密）` });
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
    const group = args.group ? String(args.group) : undefined;
    const r = await toolPost("/api/rag/search", { query, k, group });
    actions.push(`RAG 检索：${query}${group ? `（群 ${group}）` : ""}`);
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
  if (name === "save_to_inbox") {
    const title = String(args.title ?? "通知");
    const summary = String(args.summary ?? "");
    const deadline = (args.deadline as string) || null;
    const source = String(args.source ?? "");
    const base = ruleExtract(`${title}\n${summary}`, null);
    const cats = ["competition", "internship", "research", "scholarship", "activity", "opensource", "notice", "daily"];
    const c = String(args.category ?? "");
    const extracted = {
      ...base,
      title,
      summary,
      deadline: deadline ?? base.deadline,
      category: (cats.includes(c) ? c : base.category) as typeof base.category,
      sourceUrl: source.startsWith("http") ? source : base.sourceUrl,
    };
    const classification = classify(extracted, summary);
    await repo.createInbox({
      id: uid(), userId: profile.id, rawText: `${title}\n${summary}`, sourceUrl: extracted.sourceUrl,
      sourceType: "text", extracted, classification, status: "pending_review",
      createdAt: new Date().toISOString(), demo: repo.mode === "demo",
    });
    actions.push(`写入 Inbox：${title}`);
    return JSON.stringify({ ok: true, title });
  }
  if (name === "merge_inbox") {
    const mg = await mergeInbox(repo);
    actions.push(`语义合并 Inbox：归一 ${mg.clusters} 组 / 归档重复 ${mg.merged} 条`);
    return JSON.stringify(mg);
  }
  if (name === "create_opportunity") {
    const o = {
      id: uid(),
      title: String(args.title ?? "机会"),
      type: (String(args.type ?? "competition") as Opportunity["type"]),
      organizer: String(args.organizer ?? ""),
      description: String(args.description ?? ""),
      conditions: [],
      deadline: (args.deadline as string) || null,
      sourceUrl: String(args.sourceUrl ?? ""),
      sourceType: "web",
      collectedAt: new Date().toISOString(),
      status: "active" as const,
      demo: repo.mode === "demo",
    };
    await repo.createOpportunity(o);
    actions.push(`写入机会雷达：${o.title}`);
    return JSON.stringify({ ok: true, id: o.id, title: o.title });
  }
  if (name === "verify_opportunity") {
    const statuses = ["VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "CONFLICTING", "RISK_FLAGGED"];
    const st = String(args.status ?? "UNVERIFIED");
    const report = {
      id: uid(),
      opportunityId: String(args.opportunityId ?? ""),
      status: (statuses.includes(st) ? st : "UNVERIFIED") as VerificationReport["status"],
      summary: String(args.summary ?? ""),
      findings: [],
      evidence: ((args.evidence as Array<Record<string, unknown>>) ?? []).map((e) => ({
        sourceUrl: String(e.sourceUrl ?? ""),
        sourceType: "web",
        excerpt: String(e.excerpt ?? ""),
        retrievedAt: new Date().toISOString(),
        supports: String(e.supports ?? ""),
        confidence: Number(e.confidence ?? 0.5),
      })),
      createdAt: new Date().toISOString(),
    };
    await repo.createReport(report);
    actions.push(`写入可信核验：${report.status}`);
    return JSON.stringify({ ok: true, id: report.id, status: report.status });
  }
  if (name === "set_growth_goal") {
    const goal = String(args.goal ?? "");
    const profile = await repo.getProfile();
    if (!profile.goals.includes(goal)) {
      await repo.updateProfile({ ...profile, goals: [...profile.goals, goal] });
    }
    await repo.createTask({
      id: uid(), userId: profile.id, title: goal, dueAt: (args.dueAt as string) || null,
      status: "todo", priority: 70, inboxItemId: null, estimateHours: 2, kind: "general",
      createdAt: new Date().toISOString(), demo: repo.mode === "demo",
    });
    actions.push(`设定成长目标：${goal}`);
    return JSON.stringify({ ok: true, goal });
  }
  if (name === "web_search") {
    const r = await toolPost("/api/web/search", { query: String(args.query ?? ""), limit: Number(args.limit ?? 6) });
    actions.push(`网页搜索：${args.query}`);
    return JSON.stringify(r.error ? { error: r.error } : { results: r.results ?? [] });
  }
  if (name === "create_plan") {
    const plan = { goal: String(args.goal ?? ""), steps: (args.steps as string[]) ?? [], done: [] as number[], createdAt: new Date().toISOString() };
    setPlan(plan);
    actions.push(`制定长任务计划：${plan.goal}（${plan.steps.length} 步）`);
    return JSON.stringify({ ok: true, plan });
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

// DSH repeat-tool-reminder：canonical 参数链计数，阈值3/5/8注入提醒（只 enrich 不 veto），防死循环重试。
function canonicalKey(name: string, args: Record<string, unknown>): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object"
      ? Object.keys(v as object).sort().reduce((o, k) => { o[k] = sort((v as Record<string, unknown>)[k]); return o; }, {} as Record<string, unknown>)
      : v;
  return name + ":" + JSON.stringify(sort(args));
}
function noteRepeat(repeat: Map<string, number>, name: string, args: Record<string, unknown>, messages: ChatMessage[]): void {
  const key = canonicalKey(name, args);
  const n = (repeat.get(key) ?? 0) + 1;
  repeat.set(key, n);
  if (n === 3 || n === 5 || n === 8) {
    messages.push({ role: "user", content: `[系统提醒] 工具 ${name} 已用相同参数调用 ${n} 次。若结果未变请停止重复重试：改用不同参数/来源，或基于已有结果直接总结；查不到不等于不存在，如实说明。` });
  }
}

// 工具循环轮次上限：多工具（发现/同步/合并/RAG）需更多轮；上下文有 trimToBudget 保底不会爆窗。
const MAX_TOOL_ROUNDS = 20;

export async function runChat(opts: {
  message: string;
  history: ChatMessage[];
  repository: Repository;
  profile: Profile;
  providerId?: string;
  mode?: "auto" | "daily";
  model?: string;
  contextCap?: number;
}): Promise<ChatOutcome> {
  const actions: string[] = [];
  const mode = opts.mode ?? "auto";
  const ingestIntent = detectIngestIntent(opts.message);
  let needsSetup = false;
  if (ingestIntent && mode === "auto") {
    try {
      let env = await (await fetch("/api/env/check")).json();
      if (!(env.qqKey || env.wechatKey)) {
        // 短提示词全新环境：自主取钥+解密，无需人工；失败才引导配置
        try { await fetch("/api/ingest/bootstrap", { method: "POST" }); } catch {}
        env = await (await fetch("/api/env/check")).json();
        if (!(env.qqKey || env.wechatKey)) needsSetup = true;
      }
    } catch {}
  }
  const scope = detectScope(opts.message);
  const baseTools =
    mode === "daily"
      ? AGENT_TOOLS.filter((t) => ["extract_notice", "create_daily_task"].includes(t.function.name))
      : ingestIntent
        ? AGENT_TOOLS
        : AGENT_TOOLS.filter((t) => t.function.name !== "sync_group_notices");
  // 动作空间掩码：锁定源时只暴露源内工具，越界工具模型根本看不到（确定性防漂移）
  const tools = allowedTools(scope, baseTools);
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
  const cap = resolveContextCap(opts.model, opts.contextCap);
  const tTools = toolsTokens(tools);
  const composed = composeContext({
    system: SYSTEM(opts.profile, mode) + "\n" + scope.contract + "\n" + memoryPrompt(),
    history: opts.history,
    user: opts.message,
    tools,
    cap,
  });
  let messages: ChatMessage[] = composed.messages;
  let compressed = composed.compressed;
  let pruned = false;
  const repeat = new Map<string, number>();
  let contextUsed = composed.usedTokens;
  let usage = { input: 0, output: 0 };
  let model = "unknown";
  try {
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
      const res = await llmChat({ providerId: opts.providerId, messages, tools, reasoning: DEFAULT_REASONING });
      usage = { input: usage.input + res.usage.input, output: usage.output + res.usage.output };
      model = res.model;
      if (res.toolCalls.length > 0) {
        messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls });
        for (const call of res.toolCalls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
          const out = await executeTool(call.function.name, args, opts.repository, opts.profile, actions, scope);
          messages.push({ role: "tool", content: out, tool_call_id: call.id });
          noteRepeat(repeat, call.function.name, args, messages);
        }
        const trimmed = trimToBudget(messages, cap, tTools);
        messages = trimmed.messages;
        compressed = compressed || trimmed.compressed; pruned = pruned || trimmed.pruned;
        contextUsed = messagesTokens(messages) + tTools;
        continue;
      }
      if (/<tool_result/i.test(res.content)) {
        return {
          reply: "已拦截虚构的工具结果：模型未真实调用工具。请确认本地 llm-proxy 已启动、环境已配置后重试，以真实抓取群消息。",
          actions, usage, model, mock: false, contextUsed, contextCap: cap, compressed, pruned,
        };
      }
      const jt = parseJsonTool(res.content);
      if (jt) {
        messages.push({ role: "assistant", content: res.content });
        const out = await executeTool(jt.name, jt.args, opts.repository, opts.profile, actions, scope);
        messages.push({ role: "user", content: `工具 ${jt.name} 返回：${out}` });
        noteRepeat(repeat, jt.name, jt.args, messages);
        const trimmed = trimToBudget(messages, cap, tTools);
        messages = trimmed.messages;
        compressed = compressed || trimmed.compressed; pruned = pruned || trimmed.pruned;
        contextUsed = messagesTokens(messages) + tTools;
        continue;
      }
      appendMemory(`${nowBeijingText()} 用户「${opts.message.slice(0, 40)}」→ ${actions.join("；").slice(0, 160) || "直接答复"}`);
      return { reply: res.content, actions, usage, model, mock: false, contextUsed, contextCap: cap, compressed, pruned };
    }
    // 工具预算用尽：强制一次无工具最终总结，保证有可用产出（不再返回"请细化问题"）
    messages.push({ role: "user", content: "工具调用预算已用尽。请基于以上已获取的工具结果，直接给出最终中文总结（含来源/截止/已合并/过期说明），不要再调用任何工具。" });
    const trimmedFin = trimToBudget(messages, cap, tTools);
    messages = trimmedFin.messages;
    compressed = compressed || trimmedFin.compressed; pruned = pruned || trimmedFin.pruned;
    const fin = await llmChat({ providerId: opts.providerId, messages, reasoning: DEFAULT_REASONING });
    usage = { input: usage.input + fin.usage.input, output: usage.output + fin.usage.output };
    const actionsSummary = actions.length ? `已完成 ${actions.length} 步操作：${actions.join("；")}` : "（未获取到有效结果）";
    const finalText = fin.content && !parseJsonTool(fin.content) ? fin.content : actionsSummary;
    return { reply: finalText, actions, usage, model: fin.model || model, mock: false, contextUsed, contextCap: cap, compressed, pruned };
  } catch (err) {
    // 精确分类：只有真实模型传输失败才报「模型连接失败」；工具/DB/上下文异常已在各自边界兜底，
    // 不会冒泡到这里。errorMessage 保证任何被抛值（含 Supabase 普通对象）都可读，绝不出现 [object Object]。
    const reason = errorMessage(err);
    const done = actions.length ? `本轮已完成 ${actions.length} 步操作：${actions.join("；")}。` : "";
    if (isTransportError(err)) {
      return {
        reply: `${done}模型连接失败（${reason}）。已按退避重试并尝试备用端点仍未连通。请确认本地 llm-proxy(8787) 已启动、vite 代理含 /api、模型供应商密钥已在服务端配置；恢复后重发本条即可继续。`,
        actions, usage, model: "unreachable", mock: true, contextUsed, contextCap: cap, compressed, pruned,
      };
    }
    // 非传输异常（理论上已被工具/记忆边界兜底）：如实报告，不误判为模型中断、不伪造数据。
    return {
      reply: `${done}处理过程中出现异常（${reason}），这不是模型连接问题。请重发本条重试；若反复出现请反馈该错误信息。`,
      actions, usage, model, mock: false, contextUsed, contextCap: cap, compressed, pruned,
    };
  }
}