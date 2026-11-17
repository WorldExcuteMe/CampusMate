// 场景矩阵生成器：把 blueprint（JSON）确定性地展开为 EvalSuite。
// 设计事实来源：types.ts 的 EvalSuite/EvalCase、dataset.ts 的 parseSuite/suiteStats。
// 约束：无外部依赖、无 LLM 调用、同输入同输出；生成用例标 exploratory，不计入 Gate 通过率。
import fs from "node:fs";
import path from "node:path";
import { parseSuite, saveSuite, suiteStats } from "./dataset.ts";
import type { EvalCase, EvalCheck, EvalDifficulty, EvalSuite, EvalUserContext } from "./types.ts";

export interface BlueprintTemplate {
  prompt: string;
  category: string;
  difficulty?: EvalDifficulty;
  tags?: string[];
  context?: EvalUserContext;
  acceptanceNotes?: string[];
}

export interface BlueprintLimits {
  // 展开后超过该数量的用例用稳定伪随机抽样；缺省不截断。
  maxCases?: number;
  // 抽样种子；缺省用 blueprint id 派生的稳定种子。
  seed?: number;
}

export interface Blueprint {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  axes: Record<string, string[]>;
  template: BlueprintTemplate;
  limits?: BlueprintLimits;
}

// 比数据集套件 id 更严格：为 `${id}-${序号}` 的用例 id 预留长度，保证生成结果一定能被 parseSuite 通过。
const BLUEPRINT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,69}$/;
const AXIS_NAME_RE = /^[\p{L}\p{N}_-]+$/u;
const DIFFICULTIES: EvalDifficulty[] = ["easy", "medium", "hard"];
// 安全的最小检查：只保证用例真的执行过，不硬编码业务断言。业务断言由人工/AI 生成的数据集负责。
const DEFAULT_MAX_DURATION_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// null -> 0 兜底，保证同 id 的 blueprint 抽样稳定。
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// 自实现 mulberry32：无依赖、跨平台一致，用于超限抽样。
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates 抽样后按原始顺序返回，保证抽样结果与 case 序号稳定（同 seed 同结果）。
function sampleIndices(total: number, count: number, seed: number): number[] {
  const indices = Array.from({ length: total }, (_, i) => i);
  const random = mulberry32(seed);
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = indices[i];
    indices[i] = indices[j];
    indices[j] = swap;
  }
  return indices.slice(0, count).sort((a, b) => a - b);
}

function cartesian(axes: Record<string, string[]>): Array<Record<string, string>> {
  let combos: Array<Record<string, string>> = [{}];
  for (const key of Object.keys(axes)) {
    const values = axes[key];
    const next: Array<Record<string, string>> = [];
    for (const combo of combos) for (const value of values) next.push({ ...combo, [key]: value });
    combos = next;
  }
  return combos;
}

function fillPrompt(template: string, combo: Record<string, string>): string {
  let prompt = template;
  // split/join 而不是正则替换：维度值里的 $、\ 等字符不会被特殊处理。
  for (const [key, value] of Object.entries(combo)) prompt = prompt.split(`{{${key}}}`).join(value);
  return prompt;
}

function minimalChecks(): EvalCheck[] {
  return [
    { kind: "status", in: ["succeeded", "failed", "needs_input"] },
    { kind: "max_duration_ms", n: DEFAULT_MAX_DURATION_MS },
  ];
}

export function validateBlueprint(raw: unknown): { blueprint?: Blueprint; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { errors: ["blueprint 必须是 JSON 对象"] };
  if (raw.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");

  const id = typeof raw.id === "string" ? raw.id : "";
  if (!BLUEPRINT_ID_RE.test(id)) {
    errors.push("id 无效：需以小写字母或数字开头，仅含小写字母/数字/下划线/连字符，长度 2–70（为生成的用例 id 预留长度）");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) errors.push("name 必填（非空字符串）");
  if (raw.description !== undefined && typeof raw.description !== "string") errors.push("description 必须是字符串");

  const axes: Record<string, string[]> = {};
  if (!isRecord(raw.axes)) {
    errors.push("axes 必须是对象（维度名 → 非空字符串数组）");
  } else {
    const keys = Object.keys(raw.axes);
    if (!keys.length) errors.push("axes 至少需要一个维度");
    for (const key of keys) {
      if (!AXIS_NAME_RE.test(key)) {
        errors.push(`axes 的维度名无效：${key}（仅支持字母/数字/下划线/连字符）`);
        continue;
      }
      const value = raw.axes[key];
      if (!Array.isArray(value) || !value.length) {
        errors.push(`axes.${key} 必须是非空字符串数组`);
        continue;
      }
      const values: string[] = [];
      for (const item of value) {
        if (typeof item !== "string") errors.push(`axes.${key} 含非字符串值`);
        else if (!item.trim()) errors.push(`axes.${key} 含空字符串值`);
        else values.push(item);
      }
      if (values.length) axes[key] = values;
    }
  }

  const template: BlueprintTemplate = { prompt: "", category: "" };
  const rawTemplate = raw.template;
  if (!isRecord(rawTemplate)) {
    errors.push("template 必须是对象");
  } else {
    if (typeof rawTemplate.prompt !== "string" || !rawTemplate.prompt.trim()) errors.push("template.prompt 必填（非空字符串）");
    else template.prompt = rawTemplate.prompt;
    if (typeof rawTemplate.category !== "string" || !rawTemplate.category.trim()) errors.push("template.category 必填（非空字符串）");
    else template.category = rawTemplate.category.trim();
    if (rawTemplate.difficulty !== undefined) {
      if (typeof rawTemplate.difficulty !== "string" || !DIFFICULTIES.includes(rawTemplate.difficulty as EvalDifficulty)) {
        errors.push("template.difficulty 必须为 easy|medium|hard");
      } else {
        template.difficulty = rawTemplate.difficulty as EvalDifficulty;
      }
    }
    if (rawTemplate.tags !== undefined) {
      if (!Array.isArray(rawTemplate.tags) || rawTemplate.tags.some((item) => typeof item !== "string")) errors.push("template.tags 必须是字符串数组");
      else template.tags = rawTemplate.tags as string[];
    }
    if (rawTemplate.context !== undefined) {
      if (!isRecord(rawTemplate.context)) errors.push("template.context 必须是对象");
      else template.context = rawTemplate.context as EvalUserContext;
    }
    if (rawTemplate.acceptanceNotes !== undefined) {
      if (!Array.isArray(rawTemplate.acceptanceNotes) || rawTemplate.acceptanceNotes.some((item) => typeof item !== "string")) errors.push("template.acceptanceNotes 必须是字符串数组");
      else template.acceptanceNotes = rawTemplate.acceptanceNotes as string[];
    }
  }

  let limits: BlueprintLimits | undefined;
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) {
      errors.push("limits 必须是对象");
    } else {
      limits = {};
      if (raw.limits.maxCases !== undefined) {
        if (typeof raw.limits.maxCases !== "number" || !Number.isInteger(raw.limits.maxCases) || raw.limits.maxCases < 1) errors.push("limits.maxCases 必须是正整数");
        else limits.maxCases = raw.limits.maxCases;
      }
      if (raw.limits.seed !== undefined) {
        if (typeof raw.limits.seed !== "number" || !Number.isFinite(raw.limits.seed)) errors.push("limits.seed 必须是有限数字");
        else limits.seed = raw.limits.seed;
      }
    }
  }

  // 占位符必须是已声明的维度，否则展开后会残留 {{...}}，直接拒绝而不是生成半成品。
  if (template.prompt) {
    const placeholders = [...template.prompt.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1].trim());
    for (const placeholder of placeholders) {
      if (!Object.hasOwn(axes, placeholder)) errors.push(`template.prompt 使用了未声明的占位符 {{${placeholder}}}；请先在 axes 中声明该维度`);
    }
    const leftover = template.prompt.replace(/\{\{[^{}]+\}\}/g, "");
    if (/\{\{|\}\}/.test(leftover)) errors.push("template.prompt 占位符格式不完整（应为 {{维度名}}）");
  }

  if (errors.length) return { errors };
  return {
    errors,
    blueprint: {
      schemaVersion: 1,
      id,
      name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      axes,
      template,
      ...(limits ? { limits } : {}),
    },
  };
}

export function expandBlueprint(bp: Blueprint): EvalSuite {
  const { blueprint, errors } = validateBlueprint(bp);
  if (!blueprint) throw new Error(`Blueprint 校验失败：\n- ${errors.join("\n- ")}`);

  const combos = cartesian(blueprint.axes);
  const prompts: string[] = [];
  const seen = new Set<string>();
  for (const combo of combos) {
    const prompt = fillPrompt(blueprint.template.prompt, combo);
    const key = prompt.trim();
    // 同 prompt 去重：维度值相同或模板未引用某维度时不重复生成用例。
    if (seen.has(key)) continue;
    seen.add(key);
    prompts.push(prompt);
  }

  let picked = prompts.map((_, index) => index);
  if (blueprint.limits?.maxCases !== undefined && prompts.length > blueprint.limits.maxCases) {
    const seed = blueprint.limits.seed !== undefined ? blueprint.limits.seed : hashString(blueprint.id);
    picked = sampleIndices(prompts.length, blueprint.limits.maxCases, seed);
  }

  const difficulty: EvalDifficulty = blueprint.template.difficulty ?? "medium";
  const cases: EvalCase[] = picked.map((promptIndex, order) => ({
    id: `${blueprint.id}-${String(order + 1).padStart(3, "0")}`,
    category: blueprint.template.category,
    difficulty,
    source: "generated",
    // 生成用例没有脚本化模型回放，只有真实模型（live）通道才有评测意义。
    tiers: ["live"],
    // 探索性用例：不计入 Gate 通过率，只用于发现新失败。
    exploratory: true,
    prompt: prompts[promptIndex],
    ...(blueprint.template.context ? { context: blueprint.template.context } : {}),
    ...(blueprint.template.acceptanceNotes ? { acceptanceNotes: blueprint.template.acceptanceNotes } : {}),
    checks: minimalChecks(),
    ...(blueprint.template.tags ? { tags: blueprint.template.tags } : {}),
  }));

  // 生成结果必须能通过 dataset.parseSuite：这里当场校验并返回归一化后的套件。
  return parseSuite({
    schemaVersion: 1,
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description ?? `由 blueprint ${blueprint.id} 确定性展开的探索性场景矩阵：${cases.length} 个用例，不计入 Gate 通过率。`,
    source: "generated",
    cases,
  }, `<generated:${blueprint.id}>`);
}

export function writeGeneratedSuite(bp: Blueprint, outFile: string): { suite: EvalSuite; stats: ReturnType<typeof suiteStats> } {
  const suite = expandBlueprint(bp);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  saveSuite(suite, outFile);
  // 回读校验：确保落盘内容仍可被 dataset 加载（防止手改或序列化问题）。
  const loaded = parseSuite(JSON.parse(fs.readFileSync(outFile, "utf8")), outFile);
  return { suite: loaded, stats: suiteStats(loaded) };
}
