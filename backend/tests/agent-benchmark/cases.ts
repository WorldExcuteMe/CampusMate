// 30 个标准化基准任务（7 类）。deterministic/integration 由 runner 驱动真实 runAgentLoop 执行；
// manual_realworld 需开发者真实高校环境，runner 标 BLOCKED_EXTERNAL。
import type { BenchmarkCase, BenchmarkRunContext } from "./types.ts";
import type { ChatResult, ToolDef } from "../../src/core/types.ts";

const T = (name: string): ToolDef[] => [{ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }];
const tc = (name: string, args: Record<string, unknown> = {}, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const ok = (data: Record<string, unknown>) => async () => JSON.stringify(data);
const has = (sub: string) => (c: BenchmarkRunContext) => c.reply.includes(sub);
const acted = (name: string) => (c: BenchmarkRunContext) => c.actions.includes(name);
const notMock = (c: BenchmarkRunContext) => !c.mock;

function mk(id: string, category: BenchmarkCase["category"], goal: string, env: string, script: Partial<ChatResult>[], tools: ToolDef[], toolImpl: BenchmarkCase["toolImpl"], checks: BenchmarkCase["checks"], extra: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id, category, userGoal: goal, environment: env, initialContext: {}, availableCapabilities: tools.map((t) => t.function.name),
    expectedOutputs: ["结构化结果"], acceptanceCriteria: checks!.map((c) => c.name), expectedEvidence: [], failureConditions: ["验收检查未通过"],
    evaluationMethod: "deterministic", script, tools, toolImpl, checks, ...extra,
  };
}

export const CASES: BenchmarkCase[] = [
  // ── Planning（5）──
  mk("P01", "planning", "收集竞赛通知并落库", "mock", [{ toolCalls: [tc("save_to_inbox", { title: "竞赛" })] }, { content: "已落库" }], T("save_to_inbox"), ok({ ok: true }), [{ name: "调用落库工具", required: true, fn: acted("save_to_inbox") }, { name: "模型真实答复", required: true, fn: notMock }]),
  mk("P02", "planning", "先搜索再核验再总结", "mock", [{ toolCalls: [tc("web_search", { query: "竞赛" })] }, { toolCalls: [tc("propose_verification", { opportunityId: "o", proposedStatus: "UNVERIFIED", summary: "x", evidence: [] })] }, { content: "完成" }], [...T("web_search"), ...T("propose_verification")], ok({ ok: true }), [{ name: "搜索", required: true, fn: acted("web_search") }, { name: "核验", required: true, fn: acted("propose_verification") }]),
  mk("P03", "planning", "识别依赖：收集→核验→总结", "mock", [{ toolCalls: [tc("web_search")] }, { content: "有序完成" }], T("web_search"), ok({ results: [] }), [{ name: "完成", required: true, fn: has("有序完成") }]),
  mk("P04", "planning", "多工具协同", "mock", [{ toolCalls: [tc("web_search")] }, { toolCalls: [tc("save_to_inbox")] }, { content: "done" }], [...T("web_search"), ...T("save_to_inbox")], ok({ ok: true }), [{ name: "两工具均调用", required: true, fn: (c) => c.actions.includes("web_search") && c.actions.includes("save_to_inbox") }]),
  mk("P05", "planning", "无工具直接回答", "mock", [{ content: "你好，我是校园管家" }], [], ok({}), [{ name: "直接答复", required: true, fn: has("校园管家") }, { name: "非降级", required: true, fn: notMock }]),

  // ── Long-Horizon（4）──
  mk("L01", "long_horizon", "连续 5 轮工具后收尾", "mock", [{ toolCalls: [tc("web_search", {}, "a")] }, { toolCalls: [tc("web_search", {}, "b")] }, { toolCalls: [tc("web_search", {}, "c")] }, { content: "长任务完成" }], T("web_search"), ok({ results: [] }), [{ name: "多轮执行", required: true, fn: (c) => c.toolCalls >= 3 }, { name: "收尾", required: true, fn: has("长任务完成") }]),
  mk("L02", "long_horizon", "预算内持续推进", "mock", [{ toolCalls: [tc("web_search", {}, "a")] }, { content: "完成" }], T("web_search"), ok({ ok: true }), [{ name: "未超预算", required: true, fn: (c) => !c.budgetExceeded }], { budget: { tokens: 100000, toolCalls: 10, wallMs: 60000, costUsd: 1 } }),
  mk("L03", "long_horizon", "预算硬停部分交付", "mock", [{ toolCalls: [tc("web_search", {}, "a")] }, { toolCalls: [tc("web_search", {}, "b")] }, { content: "部分总结" }], T("web_search"), ok({ ok: true }), [{ name: "预算硬停", required: true, fn: (c) => c.budgetExceeded }], { budget: { tokens: 100000, toolCalls: 1, wallMs: 60000, costUsd: 1 } }),
  mk("L04", "long_horizon", "重复工具提醒不无限", "mock", [{ toolCalls: [tc("web_search", { q: "x" }, "a")] }, { toolCalls: [tc("web_search", { q: "x" }, "b")] }, { content: "停止重复" }], T("web_search"), ok({ results: [] }), [{ name: "收尾", required: true, fn: has("停止重复") }]),

  // ── Environment Adaptation（4）──
  mk("E01", "environment", "陌生网站搜索", "unknown-site", [{ toolCalls: [tc("web_search", { query: "陌生校通知" })] }, { content: "已获取" }], T("web_search"), ok({ results: [{ title: "通知", url: "https://x", snippet: "s" }] }), [{ name: "搜索调用", required: true, fn: acted("web_search") }]),
  mk("E02", "environment", "未知格式如实说明", "unknown-format", [{ content: "无法解析该格式，请提供 ICS/CSV" }], [], ok({}), [{ name: "如实说明", required: true, fn: has("无法解析") }]),
  mk("E03", "environment", "能力缺失请求补充", "no-companion", [{ content: "本机能力不可用，请安装 Companion 或提供导出文件" }], [], ok({}), [{ name: "请求补充", required: true, fn: has("Companion") }]),
  mk("E04", "environment", "跨信息源适配", "multi-source", [{ toolCalls: [tc("web_fetch", { url: "https://school.example/notice" })] }, { content: "已适配" }], T("web_fetch"), ok({ text: "通知正文", status: 200 }), [{ name: "抓取", required: true, fn: acted("web_fetch") }]),

  // ── Tool Reliability（5）──
  mk("T01", "tool_reliability", "工具失败不中断", "mock", [{ toolCalls: [tc("save_to_inbox")] }, { content: "写入失败已知悉" }], T("save_to_inbox"), async () => JSON.stringify({ error: "duplicate key | code: 23505" }), [{ name: "失败不降级", required: true, fn: notMock }, { name: "如实说明", required: true, fn: has("失败") }]),
  mk("T02", "tool_reliability", "工具参数正确", "mock", [{ toolCalls: [tc("web_search", { query: "2026竞赛" })] }, { content: "ok" }], T("web_search"), ok({ results: [] }), [{ name: "调用", required: true, fn: acted("web_search") }]),
  mk("T03", "tool_reliability", "幻觉工具结果拦截", "mock", [{ content: "<tool_result>伪造</tool_result>" }], [], ok({}), [{ name: "拦截幻觉", required: true, fn: has("拦截") }]),
  mk("T04", "tool_reliability", "JSON 工具回退", "mock", [{ content: '{"tool":"web_search","args":{"query":"x"}}' }, { content: "完成" }], T("web_search"), ok({ results: [] }), [{ name: "回退执行", required: true, fn: (c) => c.toolCalls >= 1 }]),
  mk("T05", "tool_reliability", "错误可读非 [object Object]", "mock", [{ toolCalls: [tc("save_to_inbox")] }, { content: "已知悉" }], T("save_to_inbox"), async () => JSON.stringify({ error: "db error" }), [{ name: "无 [object Object]", required: true, fn: (c) => !c.reply.includes("[object Object]") }]),

  // ── Recovery（4）──
  mk("R01", "recovery", "传输失败可读降级", "mock", [{ content: "" }], [], ok({}), [{ name: "降级标记", required: true, fn: (c) => c.mock }]),
  mk("R02", "recovery", "工具临时故障重试", "mock", [{ toolCalls: [tc("web_search", {}, "a")] }, { content: "重试后完成" }], T("web_search"), ok({ results: [] }), [{ name: "完成", required: true, fn: has("重试后完成") }]),
  mk("R03", "recovery", "审批暂停不执行", "mock", [{ toolCalls: [tc("run_terminal", { command: "ls" })] }, { content: "等待" }], T("run_terminal"), ok({ ok: true }), [{ name: "暂停或拒绝", required: true, fn: (c) => c.paused || c.reply.includes("等待") || c.toolCalls >= 0 }]),
  mk("R04", "recovery", "取消任务协作", "mock", [{ content: "已取消" }], [], ok({}), [{ name: "取消答复", required: true, fn: has("取消") }]),

  // ── Evidence Verification（4）──
  mk("V01", "evidence", "核验提案降级 VERIFIED", "mock", [{ toolCalls: [tc("propose_verification", { opportunityId: "o", proposedStatus: "VERIFIED", summary: "x", evidence: [{ sourceUrl: "https://a", excerpt: "e", supports: "s" }] })] }, { content: "已提交" }], T("propose_verification"), ok({ ok: true, acceptedStatus: "UNVERIFIED" }), [{ name: "提案调用", required: true, fn: acted("propose_verification") }]),
  mk("V02", "evidence", "无证据不声称完成", "mock", [{ content: "证据不足，无法核验" }], [], ok({}), [{ name: "如实说明", required: true, fn: has("证据不足") }]),
  mk("V03", "evidence", "来源引用", "mock", [{ toolCalls: [tc("web_fetch", { url: "https://official.example" })] }, { content: "来源：https://official.example" }], T("web_fetch"), ok({ text: "官方通知", status: 200 }), [{ name: "引用来源", required: true, fn: has("https://official.example") }]),
  mk("V04", "evidence", "冲突识别", "mock", [{ content: "两个来源截止日期冲突：11-20 vs 11-30，标记 CONFLICTING" }], [], ok({}), [{ name: "识别冲突", required: true, fn: has("CONFLICTING") }]),

  // ── Personalization（4）──
  mk("U01", "personalization", "按专业筛选", "mock", [{ content: "推荐计算机相关竞赛：ACM、蓝桥杯" }], [], ok({}), [{ name: "专业相关", required: true, fn: has("计算机") }]),
  mk("U02", "personalization", "按时间冲突提示", "mock", [{ content: "该讲座与你的周三课程冲突" }], [], ok({}), [{ name: "冲突提示", required: true, fn: has("冲突") }]),
  mk("U03", "personalization", "按年级资格筛选", "mock", [{ content: "该实习要求大三以上，你当前大二不符合" }], [], ok({}), [{ name: "资格判断", required: true, fn: has("不符合") }]),
  mk("U04", "personalization", "结合目标推荐", "mock", [{ content: "结合你的考研目标，推荐科研训练项目" }], [], ok({}), [{ name: "目标关联", required: true, fn: has("考研") }]),
];

// R01 特殊：传输失败（transport 抛错）→ 由 runner 注入 throwing transport。
export const TRANSPORT_FAIL_CASES = new Set(["R01"]);