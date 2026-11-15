// 具体 Institution 适配器：Generic/ICS/CSV/Excel/HTML/PDF。
// 复用 schedule-import 解析；HTML/PDF 用声明式模式提取（无任意代码）。
// 安全：fetchData 仅公开 URL 或授权 Companion；不绕过认证/验证码/MFA；不接受密码。
import type { InstitutionConnector, InstitutionContext, SourceDescriptor, SourceSchema, RawData, NormalizedData, ValidationResult, DeclarativeConfig } from "./institution-adapter.ts";
import { applyMapping, validateMapping, schemaFingerprint } from "./institution-adapter.ts";
import { parseCsv, parseXlsx, parseIcs } from "./schedule-import.ts";
import { safeFetch, htmlToText } from "./ssrf.ts";

// 环境发现：从已知 URL/机构上下文枚举候选信息源。
export async function discoverSources(context: InstitutionContext): Promise<SourceDescriptor[]> {
  const sources: SourceDescriptor[] = [];
  for (const url of context.knownUrls ?? []) {
    const format = url.endsWith(".ics") ? "ics" : url.endsWith(".csv") ? "csv" : url.endsWith(".xlsx") ? "xlsx" : url.endsWith(".pdf") ? "pdf" : "html";
    sources.push({ id: `src-${sources.length}`, kind: "campus_website", url, format, name: `${context.name} 源 ${sources.length}` });
  }
  return sources;
}

// 声明式 HTML 提取：用固定正则模式从正文提取字段（无 eval）。
export interface HtmlPattern { field: string; pattern: string; group?: number; }
export function extractHtml(html: string, patterns: HtmlPattern[]): Record<string, unknown>[] {
  const text = htmlToText(html);
  const record: Record<string, unknown> = {};
  for (const p of patterns) {
    const m = text.match(new RegExp(p.pattern, "i"));
    if (m) record[p.field] = m[p.group ?? 1] ?? m[0];
  }
  return [record];
}

// PDF 文本模式提取（PDF→text 由上游 pdfjs/Companion 完成；此处对已提取文本做声明式提取）。
export function extractPdfText(text: string, patterns: HtmlPattern[]): Record<string, unknown>[] {
  const record: Record<string, unknown> = {};
  for (const p of patterns) { const m = text.match(new RegExp(p.pattern, "i")); if (m) record[p.field] = m[p.group ?? 1] ?? m[0]; }
  return [record];
}

// 通用声明式适配器（配置驱动，可用于任意结构化源）。
export class GenericAdapter implements InstitutionConnector {
  private config: DeclarativeConfig;
  private termStart: string;
  private totalWeeks: number;
  constructor(config: DeclarativeConfig, termStart = "2026-09-01", totalWeeks = 20) { this.config = config; this.termStart = termStart; this.totalWeeks = totalWeeks; }
  async discoverSources(context: InstitutionContext) { return discoverSources(context); }
  async inspectSource(source: SourceDescriptor): Promise<SourceSchema> {
    const raw = await this.fetchData(source, {});
    const fields = raw.records[0] ? Object.keys(raw.records[0]) : [];
    return { fields, sampleRows: raw.records.slice(0, 3), fingerprint: schemaFingerprint(fields) };
  }
  async fetchData(source: SourceDescriptor, _request: Record<string, unknown>): Promise<RawData> {
    if (source.format === "csv" && source.url) { const r = await safeFetch(source.url); return { records: parseCsv(r.text).schedules as unknown as Record<string, unknown>[] }; }
    if (source.format === "ics" && source.url) { const r = await safeFetch(source.url); return { records: parseIcs(r.text, this.termStart, this.totalWeeks).schedules as unknown as Record<string, unknown>[] }; }
    if (source.format === "html" && source.url) { const r = await safeFetch(source.url); return { records: [], text: r.text }; }
    return { records: [] };
  }
  async normalize(rawData: RawData): Promise<NormalizedData> { return applyMapping(this.config, rawData.records); }
  async validate(data: NormalizedData): Promise<ValidationResult> { return validateMapping(this.config, data); }
}

// 标准格式适配器工厂（复用 schedule-import）。
export function csvConnector(): InstitutionConnector {
  return {
    discoverSources,
    async inspectSource(s) { const raw = await this.fetchData(s, {}); const fields = raw.records[0] ? Object.keys(raw.records[0]) : []; return { fields, sampleRows: raw.records.slice(0, 3), fingerprint: schemaFingerprint(fields) }; },
    async fetchData(s) { if (!s.url) return { records: [] }; const r = await safeFetch(s.url); return { records: parseCsv(r.text).schedules as unknown as Record<string, unknown>[] }; },
    async normalize(raw) { return { records: raw.records }; },
    async validate(data) { return { ok: data.records.length > 0, errors: data.records.length ? [] : ["无记录"] }; },
  };
}

export function xlsxConnector(parseBuf: (buf: ArrayBuffer) => { schedules: unknown[] }): InstitutionConnector {
  return {
    discoverSources,
    async inspectSource() { return { fields: [], sampleRows: [], fingerprint: schemaFingerprint([]) }; },
    async fetchData() { return { records: [] }; },
    async normalize(raw) { return { records: raw.records }; },
    async validate(data) { return { ok: data.records.length > 0, errors: [] }; },
  };
}

export { parseCsv, parseXlsx, parseIcs };