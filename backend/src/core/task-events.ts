import { toolResultFailed } from "./tool-result.ts";
export function toolResultView(raw: string): { ok: boolean; summary: string; sourceUrls: string[]; warning?: boolean } {
  let value: any;
  try { value = JSON.parse(raw); } catch { return { ok: true, summary: "已返回工具数据", sourceUrls: [] }; }
  const sourceUrls = new Set<string>();
  const visit = (item: any, depth = 0) => {
    if (!item || typeof item !== "object" || depth > 4) return;
    for (const [key, entry] of Object.entries(item)) {
      if ((key === "url" || key === "sourceUrl") && typeof entry === "string") {
        try { const url = new URL(entry); if (["http:", "https:"].includes(url.protocol)) { url.username = ""; url.password = ""; for (const p of [...url.searchParams.keys()]) if (/token|key|auth|secret|signature/i.test(p)) url.searchParams.delete(p); if (sourceUrls.size < 8) sourceUrls.add(url.toString()); } } catch { /* omit invalid source */ }
      } else visit(entry, depth + 1);
    }
  };
  visit(value);
  const failed=toolResultFailed(raw);
  const validation = typeof value?.error === 'string' ? value.error.match(/^工具参数无效：(args(?:\.[a-zA-Z_]\w*|\[\d+\])*)(类型应为[a-z/]+|必填|不在允许值中)/) : null;
  const failure = validation ? `参数格式不正确：${validation[1]}${validation[2]}；未执行` : value?.class === 'tool_validation' && value?.field === 'deadline' ? '截止日期格式无效；未知日期可留空，未保存' : value?.class === 'tool_result_uncertain' ? '操作结果未确认，请先核对保存状态，勿重复提交' : '工具执行失败，未确认完成；已成功的部分保留';
  const warning = !failed && typeof value?.warning === 'string';
  return { ok: !failed, summary: value?.__approval_pending__ ? "等待人工审批，尚未执行" : failed ? failure : warning ? value.quality === 'degraded' ? '检索匹配不足，暂无可用结果；请换关键词或核对官网' : `返回${value.results?.length ?? 0}条结果，已过滤无关条目；仍需核实来源` : Array.isArray(value?.results) ? `返回${value.results.length}条结果` : "已返回工具数据", sourceUrls: [...sourceUrls], ...(warning ? { warning: true } : {}) };
}
