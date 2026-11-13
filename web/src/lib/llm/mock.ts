import {
  extractedNoticeSchema,
  type ExtractedNotice,
  type NoticeCategory,
} from "../schemas";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

const CATEGORY_RULES: Array<{ category: NoticeCategory; keywords: string[] }> = [
  { category: "competition", keywords: ["竞赛", "比赛", "大赛", "挑战赛", "竞赛通知", "报名参赛"] },
  { category: "internship", keywords: ["实习", "招聘", "招募", "岗位", "校招", "求职网"] },
  { category: "research", keywords: ["科研", "课题", "实验室", "研究助理", "项目组", "招募科研"] },
  { category: "scholarship", keywords: ["奖学金", "助学金", "资助", "评选"] },
  { category: "opensource", keywords: ["开源", "开源项目", "贡献者"] },
  { category: "activity", keywords: ["活动", "讲座", "沙龙", "志愿", "晚会", "报名"] },
];

const RISK_KEYWORDS = [
  "缴费", "收费", "转账", "押金", "保证金", "刷单", "打字员", "先交", "汇款",
  "高额回报", "稳赚", "代理费", "培训费", "解冻", "银行卡号", "验证码",
];

function detectCategory(text: string): NoticeCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => text.includes(k))) return rule.category;
  }
  return "notice";
}

function extractTitle(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? text.trim();
  const cleaned = first.replace(/^(通知|公告|关于)[:：]?/, "").trim();
  return (cleaned || first).slice(0, 80);
}

function extractDeadline(text: string): string | null {
  const patterns = [
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/,
    /(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
  ];
  const deadlineCtx = text.match(/(截止|截至|报名截止|提交截止|deadline)[^。\n]*/i);
  const scope = deadlineCtx ? deadlineCtx[0] : text;
  for (const re of patterns) {
    const m = scope.match(re) ?? text.match(re);
    if (m) {
      if (m.length === 4) {
        const [, y, mo, d] = m;
        return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
      }
      const [, mo, d] = m;
      const year = new Date().getFullYear();
      return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }
  return null;
}

function extractOrg(text: string): string {
  const m = text.match(/(主办[单位方]*|承办[单位方]*|发布[单位方]*|组织[单位方]*)[:：]?\s*([^\n，,。；;]{2,30})/);
  if (m) return m[2].trim();
  const orgLike = text.match(/([\u4e00-\u9fa5]{2,12}(学院|大学|委员会|办公室|中心|实验室|公司|集团))/);
  return orgLike ? orgLike[1] : "";
}

function extractList(text: string, labels: string[]): string[] {
  for (const label of labels) {
    const re = new RegExp(`${label}[:：]([^\\n]+)`);
    const m = text.match(re);
    if (m) {
      return m[1].split(/[、，,；;]/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
    }
  }
  return [];
}

function extractField(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(`${label}[:：]\\s*([^\\n，,。；;]{1,40})`);
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

export function ruleExtract(rawText: string, sourceUrl: string | null): ExtractedNotice {
  const text = rawText.trim();
  const category = detectCategory(text);
  const deadline = extractDeadline(text);
  const riskHits = RISK_KEYWORDS.filter((k) => text.includes(k));
  const conditions = extractList(text, ["参与条件", "报名条件", "要求", "参赛条件", "应聘要求"]);
  const materials = extractList(text, ["所需材料", "报名材料", "提交材料", "材料"]);
  const cost = extractField(text, ["费用", "报名费", "参与成本", "收费"]);
  const location = extractField(text, ["地点", "地址", "位置"]);
  const org = extractOrg(text);
  const summary = text.replace(/\s+/g, " ").slice(0, 120);

  let confidence = 0.4;
  if (deadline) confidence += 0.2;
  if (org) confidence += 0.1;
  if (category !== "notice") confidence += 0.15;
  if (conditions.length) confidence += 0.1;
  confidence = Math.min(0.95, confidence);

  return extractedNoticeSchema.parse({
    title: extractTitle(text),
    category,
    org,
    summary,
    deadline,
    conditions,
    materials,
    cost: riskHits.length && !cost ? "提及收费/转账（需核验）" : cost,
    location,
    sourceUrl,
    evidenceExcerpt: text.slice(0, 200),
    confidence,
  });
}

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly mock = true;

  async extractNotice(req: LlmRequest): Promise<LlmResult> {
    const extracted = ruleExtract(req.input.rawText, req.input.sourceUrl);
    return {
      extracted,
      provider: "mock",
      model: "rule-based-mock",
      tokenUsage: { input: 0, output: 0 },
      mock: true,
    };
  }
}

export { RISK_KEYWORDS };