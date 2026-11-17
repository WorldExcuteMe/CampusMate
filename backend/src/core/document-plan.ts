import type { DocumentRequirements } from "../../../shared/document.ts";
import type { Plan, PlanStep } from "./planner.ts";
import { freezeAcceptance } from "./planner.ts";
const DEFAULT_SECTIONS = ["背景与问题", "项目目标", "方案与实施步骤", "团队分工与进度", "资源与预算", "风险与应对", "预期成果与评估"];
export function isProposalRequest(intent: string): boolean {
  const preview = /只.{0,8}(?:预览|提纲|大纲)|(?:等我|待我|经我)确认|(?:下一轮|下一条).{0,10}(?:写|生成)|(?:不要|不|勿)(?:写入|保存)(?:到任何|任何|[，。；！？\s]|$)|暂不(?:写|生成|保存)|preview only|outline only/i.test(intent);
  if (preview) return false;
  return /(?:写|撰写|编写|生成|起草|制作|草拟|完成|做).{0,70}(?:策划书|计划书|项目方案)|(?:write|draft|create|generate).{0,70}(?:proposal|project plan)/i.test(intent);
}
export function proposalRequirements(intent: string): DocumentRequirements {
  const custom = intent.match(/(?:章节|章节要求|章节结构)\s*[:：]\s*([^\n。]+)/)?.[1].split(/[、，,；;]/).map((s) => s.trim()).filter(Boolean).slice(0, 15);
  const sections = custom?.length ? custom : DEFAULT_SECTIONS;
  const number = "(?:\\d{1,6}|[零一二两三四五六七八九十百千万]{1,9})";
  const normalized = intent.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "");
  let minChars = 0, maxChars: number | undefined;
  const range = normalized.match(new RegExp(`(${number})\\s*(?:至|到|[-–~])\\s*(${number})\\s*(?:字|字符)`));
  if (range) { minChars = numeral(range[1]); maxChars = numeral(range[2]); }
  else for (const length of normalized.matchAll(new RegExp(`(至少|不少于|不低于|不超过|至多|最多)?\\s*(${number})\\s*(?:字|字符)`, "g"))) {
    const amount = numeral(length[2]); if (/不超过|至多|最多/.test(length[1] ?? "")) maxChars = maxChars === undefined ? amount : Math.min(maxChars, amount); else minChars = Math.max(minChars, amount);
  }
  return { sections, minChars, ...(maxChars === undefined ? {} : { maxChars }), requireSources: !/无需(?:联网|外部资料|引用)|仅(?:基于|用)(?:给定|提供|以下)材料/.test(intent) };
}
function numeral(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }, units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, section = 0, n = 0;
  for (const c of value) { if (Object.hasOwn(digits, c)) n = digits[c]; else if (c === "万") { total += (section + n || 1) * 10000; section = n = 0; } else { section += (n || 1) * units[c]; n = 0; } }
  return total + section + n;
}
export function proposalPlan(taskId: string, goal: string, requirements: DocumentRequirements): Plan {
  const items: [string, PlanStep["kind"], string][] = [["research", "act", "资料与来源"], ["outline", "plan", "提纲与约束"], ...requirements.sections.map((s, i): [string, PlanStep["kind"], string] => [`chapter-${i}`, "act", s]), ["inspect", "verify", "正文与引用检查"], ["deliver", "summarize", "生成并交付文档"]];
  const steps = items.map(([key, kind, title], index): PlanStep => ({ id: `${taskId}:${key}`, seq: index + 1, kind, title, input: goal, expectedOutput: title, dependsOn: index ? [`${taskId}:${items[index - 1][0]}`] : [], acceptance: [{ id: `${key}:content`, kind: "count_min", params: { name: key, min: 1 }, required: true }], status: "pending" }));
  return freezeAcceptance({ id: taskId, goal, steps, version: 1, acceptanceFrozen: false, createdAt: Date.now() });
}
