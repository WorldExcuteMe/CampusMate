// Topic matching is a guard against obvious search drift, not source authority
// or factual verification. Generic student/university words cannot identify a named event.
export function normalizeInformationRequest(text: string): string {
  return text.replace(/^\s*请基于已有记录继续[：:]\s*/, "").trim();
}
export function informationTopic(text: string): string | undefined {
  const query = normalizeInformationRequest(text)
    .replace(/^\s*(?:(?:请|帮我|麻烦)\s*)*(?:收集|搜集|查询|查找|搜索|了解|介绍)\s*/, "")
    .replace(/的?(?:信息|资料|情况)[。！？\s]*$/, "")
    .replace(/第[\d一二三四五六七八九十百]+届/g, "")
    .replace(/20\d{2}\s*年?/g, " ")
    .replace(/\b(?:site|filetype):\S+/gi, "");
  const quoted = /["“]([^"”]{4,})["”]/.exec(query)?.[1];
  const event = query.match(/[\u3400-\u9fff]{2,}?(?:竞赛|大赛|比赛|杯|赛)/)?.[0];
  const generic = new Set(["official", "website", "registration", "deadline", "fee", "fees", "rules", "notice", "information", "competition", "competitions", "free", "for", "the", "and", "round"]);
  const english = query.match(/[a-z][a-z\d_.+-]{2,}/gi)?.find(word => !generic.has(word.toLowerCase()));
  const chinese = query.replace(/20\d{2}年?|官网|官方|报名(?:时间|费用|入口|条件|资格|状态)?|费用|截止(?:时间)?|时间|通知|规则|信息|资料|免费/g, " ").match(/[\u3400-\u9fff]{2,}/g)?.sort((a, b) => b.length - a.length)[0];
  const topic = quoted ?? event ?? english ?? chinese;
  return topic && !["竞赛", "大赛", "比赛", "赛事", "机会", "活动", "通知", "来源", "核验", "核实", "搜索", "大学生计算机竞赛", "大学生竞赛", "高校计算机竞赛"].includes(topic) ? topic : undefined;
}
export function matchesTopic(topic: string | undefined, text: string): boolean {
  if (!topic) return true;
  if (!/[\u3400-\u9fff]/.test(topic)) return text.toLowerCase().includes(topic.toLowerCase());
  const compact = text.replace(/\s/g, "");
  const event = /(?:竞赛|大赛|比赛|杯|赛)$/.test(topic);
  if (event) {
    const core = topic.replace(/^(?:中国|全国)?(?:大学生|高校学生|高校)?/, "").replace(/(?:竞赛|大赛|比赛|杯|赛)$/, "");
    if (core.length >= 2) return compact.includes(core) && /竞赛|大赛|比赛|杯|赛/.test(compact);
  }
  const grams = [...new Set(Array.from({ length: topic.length - 1 }, (_, i) => topic.slice(i, i + 2)))];
  return !grams.length || grams.filter(gram => compact.includes(gram)).length >= Math.min(grams.length, Math.max(2, Math.ceil(grams.length * 0.5)));
}
// A generic request has no named entity, but that does not make unrelated
// calendar/year results relevant. This remains a drift guard, not fact proof.
export function matchesInformationRequest(request: string, text: string): boolean {
  const topic = informationTopic(request);
  const contestRequest = /竞赛|大赛|比赛|赛事|contest|competition/i.test(request);
  const broad = !topic || /(?:一|两|三|[1-3])\s*个(?:真实)?(?:赛事|竞赛|比赛)/.test(request);
  if (contestRequest && broad && (/计算机|编程|computer|programming/i.test(request) || /(?:一|两|三|[1-3])\s*个(?:真实)?(?:赛事|竞赛|比赛)/.test(request))) {
    const contest = /竞赛|大赛|比赛|参赛|赛程|锦标|杯|contest|competition|\bICPC\b|\bCCPC\b/i.test(text);
    const computing = !/计算机|编程|computer|programming/i.test(request) || /计算机|软件|信息技术|程序|编程|算法|数据|人工智能|computer|programming|algorithm|\bICPC\b|\bCCPC\b/i.test(text);
    return contest && computing;
  }
  return matchesTopic(topic, text);
}
