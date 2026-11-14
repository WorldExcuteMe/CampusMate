export type ClaimType = "proposal" | "fact" | "estimate" | "unverified";
export interface DocumentSource { id: string; url: string; title: string; excerpt: string; retrievedAt: number; status: "retrieved"; }
type Cited = { sourceIds?: string[]; claimType?: ClaimType };
export type DocumentBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | ({ type: "paragraph"; text: string } & Cited)
  | ({ type: "list"; items: string[]; ordered?: boolean } & Cited)
  | ({ type: "table"; headers: string[]; rows: string[][] } & Cited)
  | { type: "image"; src: string; alt: string; caption?: string }
  | { type: "chart"; title: string; labels: string[]; values: number[] }
  | { type: "reference"; sourceId: string };
export interface DocumentAst { schemaVersion: 1; title: string; kind: "proposal" | "document"; blocks: DocumentBlock[]; sources: DocumentSource[]; }
export interface DocumentRequirements { sections: string[]; minChars: number; maxChars?: number; requireSources: boolean; }
export interface DocumentCheck { id: string; passed: boolean; detail: string; }
const isRecord = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown, max = 20000): x is string => typeof x === "string" && x.length <= max;
const strings = (x: unknown, limit: number, max = 20000): x is string[] => Array.isArray(x) && x.length <= limit && x.every((s) => text(s, max));
export function publicSourceUrl(value: unknown): string | null { try { const u = new URL(String(value)); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || [...u.searchParams.keys()].some((k) => /token|secret|auth|key|signature/i.test(k))) return null; u.hash = ""; return u.toString(); } catch { return null; } }
export function blockErrors(block: unknown, sourceIds?: Set<string>): string[] {
  if (!isRecord(block)) return ["内容块必须是对象"];
  const valid: Record<string, () => boolean> = {
    heading: () => typeof block.level === "number" && [1, 2, 3].includes(block.level) && text(block.text, 200) && Boolean(block.text.trim()),
    paragraph: () => text(block.text),
    list: () => strings(block.items, 100),
    table: () => strings(block.headers, 15, 500) && Array.isArray(block.rows) && block.rows.length <= 500 && block.rows.every((row) => strings(row, 15, 4000) && row.length === (block.headers as string[]).length),
    image: () => text(block.alt, 500) && (block.caption === undefined || text(block.caption, 1000)) && typeof block.src === "string" && block.src.length <= 2800000 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(block.src),
    chart: () => text(block.title, 200) && strings(block.labels, 50, 100) && Array.isArray(block.values) && block.values.length === (block.labels as string[]).length && block.values.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e15),
    reference: () => typeof block.sourceId === "string" && (!sourceIds || sourceIds.has(block.sourceId)),
  };
  const errors = !Object.hasOwn(valid, String(block.type)) || !valid[String(block.type)]() ? ["内容块类型、大小或字段不合法"] : [];
  if (block.sourceIds !== undefined && (!strings(block.sourceIds, 30, 100) || (sourceIds && (block.sourceIds as string[]).some((id) => !sourceIds.has(id))))) errors.push("引用没有对应的已取得来源");
  if (block.claimType !== undefined && !["proposal", "fact", "estimate", "unverified"].includes(String(block.claimType))) errors.push("主张类型无效");
  if (block.claimType === "fact" && (!Array.isArray(block.sourceIds) || !block.sourceIds.length)) errors.push("外部事实须关联来源");
  return errors;
}
export function documentErrors(value: unknown): string[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || !text(value.title, 300) || !["document", "proposal"].includes(String(value.kind)) || !Array.isArray(value.blocks) || value.blocks.length > 2000 || !Array.isArray(value.sources) || value.sources.length > 50) return ["文档结构无效或超出大小限制"];
  const ids = new Set<string>();
  for (const source of value.sources) { if (!isRecord(source) || !text(source.id, 64) || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(source.id) || publicSourceUrl(source.url) !== source.url || !text(source.title, 300) || !text(source.excerpt, 2000) || typeof source.retrievedAt !== "number" || !Number.isFinite(source.retrievedAt) || source.status !== "retrieved" || ids.has(source.id)) return ["来源格式无效或ID重复"]; ids.add(source.id); }
  return value.blocks.flatMap((b, i) => blockErrors(b, ids).map((e) => `块${i + 1}：${e}`));
}
export function blockText(b: DocumentBlock): string {
  switch (b.type) { case "heading": case "paragraph": return b.text; case "list": return b.items.join("\n"); case "table": return [...b.headers, ...b.rows.flat()].join(" "); case "image": return b.alt; case "chart": return b.title; case "reference": return ""; }
}
export function bodyChars(ast: DocumentAst): number { return ast.blocks.filter((b) => !["heading", "reference"].includes(b.type)).map(blockText).join("").replace(/\s/g, "").length; }
export function inspectDocument(ast: DocumentAst, requirements: DocumentRequirements, toolErrors: string[] = []): DocumentCheck[] {
  const errors = documentErrors(ast), checks: DocumentCheck[] = [{ id: "schema", passed: !errors.length, detail: errors.join("；") || "受限文档结构有效" }];
  const normalize = (s: string) => s.normalize("NFKC").replace(/[\s\p{P}\p{N}]/gu, "");
  for (const required of requirements.sections) {
    const start = ast.blocks.findIndex((b) => b.type === "heading" && b.level === 2 && normalize(b.text) === normalize(required));
    let body = "";
    if (start >= 0) for (let i = start + 1; i < ast.blocks.length; i++) { const b = ast.blocks[i]; if (b.type === "heading" && b.level <= 2) break; if (b.type !== "heading" && b.type !== "reference") body += blockText(b); }
    const count = body.replace(/\s/g, "").length;
    checks.push({ id: `section:${required}`, passed: count >= 60, detail: start < 0 ? `缺少章节：${required}` : `${required}正文${count}字符，至少60` });
  }
  const chars = bodyChars(ast);
  checks.push({ id: "length", passed: chars >= requirements.minChars && (requirements.maxChars === undefined || chars <= requirements.maxChars), detail: `正文${chars}字符（不含空白），要求≥${requirements.minChars}${requirements.maxChars === undefined ? "" : `且≤${requirements.maxChars}`}` });
  const citations = new Set(ast.blocks.flatMap((b) => b.type === "reference" ? [b.sourceId] : "sourceIds" in b ? b.sourceIds ?? [] : []));
  checks.push({ id: "citations", passed: !requirements.requireSources || ast.sources.some((s) => citations.has(s.id)), detail: requirements.requireSources ? `已取得${ast.sources.length}条网页来源，关联${citations.size}条；结构核对不等于独立事实核验` : "用户要求仅基于给定材料，外部来源非必需" });
  checks.push({ id: "claims", passed: ast.kind !== "proposal" || ast.blocks.filter((b) => ["paragraph", "list", "table"].includes(b.type)).every((b) => "claimType" in b && b.claimType !== undefined), detail: "策划书的正文、列表和表格须明确标记外部事实、建议方案、估算或待核实" });
  checks.push({ id: "tools", passed: !toolErrors.length, detail: toolErrors.length ? toolErrors.join("；").slice(0, 600) : "没有未解决的工具失败" });
  return checks;
}
const escapeMd = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_\[\]|])/g, "\\$1");
export function documentMarkdown(ast: DocumentAst): string {
  const errors = documentErrors(ast); if (errors.length) throw new Error(errors[0]);
  const label = (type?: ClaimType) => type === "estimate" ? "【估算】" : type === "unverified" ? "【待核实】" : type === "proposal" ? "【建议方案】" : "";
  const blocks = ast.blocks.map((b) => {
    const refs = "sourceIds" in b ? (b.sourceIds ?? []).map((id) => `[^${id}]`).join("") : "";
    switch (b.type) {
      case "heading": return `${"#".repeat(b.level)} ${escapeMd(b.text)}`;
      case "paragraph": return `${label(b.claimType)}${escapeMd(b.text)}${refs}`;
      case "list": return b.items.map((s, i) => `${b.ordered ? `${i + 1}.` : "-"} ${label(b.claimType)}${escapeMd(s)}`).join("\n") + refs;
      case "table": return [`| ${b.headers.map(escapeMd).join(" | ")} |`, `| ${b.headers.map(() => "---").join(" | ")} |`, ...b.rows.map((row) => `| ${row.map((s) => escapeMd(s).replace(/\n/g, " ")).join(" | ")} |`)].join("\n") + refs;
      case "image": return `![${escapeMd(b.alt)}](${b.src})${b.caption ? `\n\n${escapeMd(b.caption)}` : ""}`;
      case "chart": return `**${escapeMd(b.title)}**\n\n${b.labels.map((s, i) => `- ${escapeMd(s)}：${b.values[i]}`).join("\n")}`;
      case "reference": return `参见来源 [^${b.sourceId}]`;
    }
  });
  const sources = ast.sources.map((s) => `[^${s.id}]: ${escapeMd(s.title)} — ${s.url.replace(/[()]/g, (c) => encodeURIComponent(c))}（取得于${new Date(s.retrievedAt).toISOString()}；网页已取得，事实需核对）`).join("\n");
  return `# ${escapeMd(ast.title)}\n\n> AI生成内容；建议、估算与待核实事项按标记区分，请核对关键事实。\n\n${blocks.join("\n\n")}\n\n${sources ? `## 参考来源\n\n${sources}\n` : ""}`;
}
