import {
  classificationSchema,
  type Classification,
  type ExtractedNotice,
} from "../schemas";
import { RISK_KEYWORDS } from "../llm/mock";

function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null;
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

export function classify(extracted: ExtractedNotice, rawText: string): Classification {
  const riskSignals = RISK_KEYWORDS.filter((k) => rawText.includes(k));
  const days = daysUntil(extracted.deadline);

  let cls: Classification["class"];
  if (riskSignals.length >= 1) {
    cls = "risk";
  } else if (
    ["competition", "internship", "research", "scholarship"].includes(extracted.category)
  ) {
    cls = days !== null && days <= 7 ? "must_act" : "high_value";
  } else if (days !== null && days <= 3) {
    cls = "must_act";
  } else if (extracted.category === "activity") {
    cls = "worth_watching";
  } else {
    cls = "normal";
  }

  let score = 30;
  const reasons: string[] = [];
  if (cls === "must_act") {
    score += 35;
    reasons.push("需尽快处理");
  } else if (cls === "high_value") {
    score += 25;
    reasons.push("高价值机会");
  } else if (cls === "risk") {
    score += 40;
    reasons.push("存在风险信号，优先核验");
  }
  if (days !== null) {
    if (days <= 3) {
      score += 25;
      reasons.push(`截止临近（${days} 天）`);
    } else if (days <= 7) {
      score += 15;
      reasons.push(`截止较近（${days} 天）`);
    } else if (days <= 30) {
      score += 8;
      reasons.push(`截止 ${days} 天`);
    }
  } else {
    reasons.push("未识别到截止时间");
  }
  if (extracted.conditions.length) reasons.push("含参与条件");
  score = Math.max(0, Math.min(100, score));

  return classificationSchema.parse({
    class: cls,
    priorityScore: score,
    priorityReason: reasons.join("；"),
    riskSignals,
  });
}