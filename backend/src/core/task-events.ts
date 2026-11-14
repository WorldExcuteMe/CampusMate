export function toolResultView(raw: string): { ok: boolean; summary: string; sourceUrls: string[] } {
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
  return { ok: !value?.error, summary: value?.__approval_pending__ ? "等待人工审批，尚未执行" : value?.error ? "工具未完成，请查看任务说明" : Array.isArray(value?.results) ? `返回${value.results.length}条结果` : "已返回工具数据", sourceUrls: [...sourceUrls] };
}
