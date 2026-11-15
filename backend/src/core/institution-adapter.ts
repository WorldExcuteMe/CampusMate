// Institution Adapter 框架：声明式映射（禁止任意代码执行）+ 生命周期 + 候选验证门控。
// 安全：不绕过认证/验证码/MFA；不向 LLM 提供密码；模型生成候选规则须 fixture 测试 + 用户确认才激活。
import { createHash } from "node:crypto";

export interface InstitutionContext { institutionId: string; name: string; knownUrls?: string[]; }
export interface SourceDescriptor { id: string; kind: "academic_system" | "campus_website" | "student_group" | "official_account" | "file"; url?: string; format?: "ics" | "csv" | "xlsx" | "pdf" | "html"; name: string; }
export interface SourceSchema { fields: string[]; sampleRows: Record<string, unknown>[]; fingerprint: string; }
export interface RawData { records: Record<string, unknown>[]; text?: string; }
export interface NormalizedData { records: Record<string, unknown>[]; }
export interface ValidationResult { ok: boolean; errors: string[]; }

export interface InstitutionConnector {
  discoverSources(context: InstitutionContext): Promise<SourceDescriptor[]>;
  inspectSource(source: SourceDescriptor): Promise<SourceSchema>;
  fetchData(source: SourceDescriptor, request: Record<string, unknown>): Promise<RawData>;
  normalize(rawData: RawData): Promise<NormalizedData>;
  validate(data: NormalizedData): Promise<ValidationResult>;
}

// ── 生命周期 ──
export type AdapterStatus = "draft" | "candidate" | "validated" | "active" | "degraded" | "retired";
const TRANSITIONS: Record<AdapterStatus, AdapterStatus[]> = {
  draft: ["candidate", "retired"],
  candidate: ["validated", "draft", "retired"],
  validated: ["active", "candidate", "retired"],
  active: ["degraded", "retired"],
  degraded: ["candidate", "active", "retired"],
  retired: [],
};
export function canTransition(from: AdapterStatus, to: AdapterStatus): boolean { return TRANSITIONS[from]?.includes(to) ?? false; }
export function assertTransition(from: AdapterStatus, to: AdapterStatus): void { if (!canTransition(from, to)) throw new Error(`非法适配器状态转换：${from} → ${to}`); }

// ── 声明式映射（固定 transform 白名单，无 eval）──
export type Transform = "trim" | "lower" | "upper" | "number" | "int" | "weekday" | "date" | "time";
const TRANSFORMS: Record<Transform, (v: unknown) => unknown> = {
  trim: (v) => String(v ?? "").trim(),
  lower: (v) => String(v ?? "").toLowerCase(),
  upper: (v) => String(v ?? "").toUpperCase(),
  number: (v) => Number(v),
  int: (v) => parseInt(String(v), 10),
  weekday: (v) => { const m: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 }; const s = String(v ?? "").trim().toLowerCase(); return m[s] ?? Number(s); },
  date: (v) => String(v ?? "").trim(),
  time: (v) => String(v ?? "").trim(),
};

export interface FieldMapping { source: string; transform?: Transform; default?: unknown; }
export interface DeclarativeConfig {
  id: string;
  sourceType: SourceDescriptor["format"] | "generic";
  fieldMap: Record<string, FieldMapping>;   // target → {source, transform}
  required?: string[];
}

// 应用声明式映射（纯数据转换，绝不执行任意代码）。
export function applyMapping(config: DeclarativeConfig, records: Record<string, unknown>[]): NormalizedData {
  const out = records.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [target, m] of Object.entries(config.fieldMap)) {
      let v = r[m.source];
      if (v === undefined || v === null || v === "") v = m.default;
      if (m.transform && v !== undefined) v = TRANSFORMS[m.transform](v);
      o[target] = v;
    }
    return o;
  });
  return { records: out };
}

export function validateMapping(config: DeclarativeConfig, data: NormalizedData): ValidationResult {
  const errors: string[] = [];
  const required = config.required ?? [];
  data.records.forEach((r, i) => { for (const f of required) if (r[f] === undefined || r[f] === null || r[f] === "") errors.push(`记录 ${i}: 缺必填字段 ${f}`); });
  return { ok: errors.length === 0, errors };
}

// ── Schema Fingerprint ──
export function schemaFingerprint(fields: string[]): string {
  return createHash("sha256").update([...fields].sort().join("|")).digest("hex").slice(0, 16);
}

// ── Adapter 元数据 + Registry ──
export interface AdapterFixture { input: Record<string, unknown>[]; expected: Record<string, unknown>[]; }
export interface AdapterMeta {
  id: string;
  institutionId: string;
  version: number;
  status: AdapterStatus;
  config: DeclarativeConfig;
  schemaFingerprint: string;
  supportedDataTypes: string[];
  permissions: string[];
  fixtures: AdapterFixture[];
  health: "unknown" | "healthy" | "degraded";
  lastSuccess?: number;
  errorHistory: { at: number; error: string }[];
  userConfirmed: boolean;
}

export class AdapterRegistry {
  private adapters = new Map<string, AdapterMeta>();
  register(meta: AdapterMeta): void { this.adapters.set(meta.id, meta); }
  get(id: string): AdapterMeta | null { return this.adapters.get(id) ?? null; }
  list(institutionId?: string): AdapterMeta[] { return [...this.adapters.values()].filter((a) => !institutionId || a.institutionId === institutionId); }
  active(institutionId: string): AdapterMeta[] { return this.list(institutionId).filter((a) => a.status === "active"); }

  transition(id: string, to: AdapterStatus): AdapterMeta {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`适配器不存在：${id}`);
    assertTransition(a.status, to);
    const next = { ...a, status: to };
    this.adapters.set(id, next);
    return next;
  }

  // 候选验证：fixtures 全部通过 → validated；否则保持 candidate + 记录错误。
  validateCandidate(id: string): { ok: boolean; errors: string[] } {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`适配器不存在：${id}`);
    const errors: string[] = [];
    for (const fx of a.fixtures) {
      const got = applyMapping(a.config, fx.input).records;
      if (JSON.stringify(got) !== JSON.stringify(fx.expected)) errors.push(`fixture 不匹配：${JSON.stringify(got)} ≠ ${JSON.stringify(fx.expected)}`);
    }
    if (errors.length === 0) { this.adapters.set(id, { ...a, status: "validated", health: "healthy" }); return { ok: true, errors: [] }; }
    this.adapters.set(id, { ...a, errorHistory: [...a.errorHistory, { at: Date.now(), error: errors.join("；") }] });
    return { ok: false, errors };
  }

  // 激活门控：必须 validated + 用户确认。禁止未验证激活。
  activate(id: string, userConfirmed: boolean): AdapterMeta {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`适配器不存在：${id}`);
    if (a.status !== "validated") throw new Error("适配器须先通过候选验证（validated）才能激活");
    if (!userConfirmed) throw new Error("适配器激活须用户确认");
    return this.transition(id, "active");
  }

  // Schema 变更检测：fingerprint 不符 → degraded。
  checkSchema(id: string, currentFields: string[]): AdapterMeta {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`适配器不存在：${id}`);
    if (schemaFingerprint(currentFields) !== a.schemaFingerprint && a.status === "active") {
      const next = { ...a, status: "degraded" as AdapterStatus, health: "degraded" as const };
      this.adapters.set(id, next);
      return next;
    }
    return a;
  }
}