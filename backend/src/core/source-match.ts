// Topic matching is a guard against obvious search drift, not source authority
// or factual verification. Generic student/university words cannot identify a named event.
export function normalizeInformationRequest(text: string): string {
  return text.replace(/^\s*请基于已有记录继续[：:]\s*/, "").trim();
}
export function informationTopic(text: string): string | undefined {
  const query = normalizeInformationRequest(text)
    .replace(/^\s*(?:(?:请|帮我|麻烦)\s*)*(?:收集|搜集|查询|查找|搜索|了解|介绍)\s*/, "")
    .replace(/的?(?:信息|资料|情况)[。！？\s]*$/, "");
  const quoted = /["“]([^"”]{4,})["”]/.exec(query)?.[1];
  const event = query.match(/[\u3400-\u9fff]{2,}?(?:竞赛|大赛|比赛)/)?.[0];
  return quoted ?? event ?? query.match(/[\u3400-\u9fff]{4,}/g)?.sort((a, b) => b.length - a.length)[0];
}
export function matchesTopic(topic: string | undefined, text: string): boolean {
  if (!topic || !/[\u3400-\u9fff]/.test(topic)) return true;
  const compact = text.replace(/\s/g, "");
  const event = /(?:竞赛|大赛|比赛)$/.test(topic);
  if (event) {
    const core = topic.replace(/^(?:中国|全国)?(?:大学生|高校学生|高校)?/, "").replace(/(?:竞赛|大赛|比赛)$/, "");
    if (core.length >= 2) return compact.includes(core) && /竞赛|大赛|比赛/.test(compact);
  }
  const grams = [...new Set(Array.from({ length: topic.length - 1 }, (_, i) => topic.slice(i, i + 2)))];
  return !grams.length || grams.filter(gram => compact.includes(gram)).length >= Math.min(grams.length, Math.max(2, Math.ceil(grams.length * 0.5)));
}
