export interface TextToolCall { name: string; args: Record<string, unknown>; }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// 只在明确包络上判定为工具调用；不评估代码、不从散文/检索材料中抠取可执行调用。
// 额外容忍模型把 JSON 包在标签里的两种已观测形式（如 `</think> <{...}>` 或 `<tool>{...}</tool>`），
// 前提是工具名在已知集合内且参数安全，否则按“疑似工具调用”交给协议修复，而不是当最终答复。
const MARKUP_WRAPPER = /<\/?think>|<\/?(?:tool|function|tool_calls?)[^>]*>|<{/i;

export function looksLikeToolCall(text: string): boolean {
  const value = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  if (/<\|tool_call>|<tool_call\|>|^call:\w+\s*\{/.test(value)) return true;
  try {
    const data = JSON.parse(value);
    return object(data) && (Object.hasOwn(data, "tool") || Object.hasOwn(data, "function") || (Object.hasOwn(data, "name") && ["args", "arguments", "parameters"].some(key => Object.hasOwn(data, key))));
  } catch {
    if (/^\{/.test(value) && /"(?:tool|function)"\s*:/.test(value)) return true;
    return MARKUP_WRAPPER.test(value) && /"(?:tool|function|name)"\s*:/.test(value) && /\{[\s\S]*\}/.test(value);
  }
}

function balancedJsonEnd(value: string): number {
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function safeKeys(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, child]) => !["__proto__", "prototype", "constructor"].includes(key) && safeKeys(child, depth + 1));
}

function toCall(data: unknown, known: Set<string>): TextToolCall | null {
  if (!object(data)) return null;
  const name = data.tool ?? data.name ?? (object(data.function) ? data.function.name : undefined);
  if (typeof name !== "string" || !known.has(name)) return null;
  let args = Object.hasOwn(data, "args") ? data.args : Object.hasOwn(data, "arguments") ? data.arguments : data.parameters ?? (object(data.function) ? data.function.arguments : undefined) ?? {};
  if (typeof args === "string") args = JSON.parse(args);
  if (!object(args) || !safeKeys(args)) return null;
  return { name, args };
}

function recoverWrappedCall(value: string, known: Set<string>): TextToolCall | null {
  if (!/"(?:tool|function|name)"\s*:/.test(value)) return null;
  const start = value.indexOf("{");
  if (start < 0) return null;
  // 前缀只能是标签/尖括号（如 `</think>`、`<tool_call>`、包裹用的 `<`），不能是散文；
  // 保留“散文里出现 JSON 示例不执行”的既有安全边界。
  const prefix = value.slice(0, start);
  if (prefix.trim() && !/^(?:\s*(?:<|>|<\/?[a-zA-Z_][\w:|.-]*>))*\s*$/.test(prefix)) return null;
  const body = value.slice(start);
  const end = balancedJsonEnd(body);
  if (end < 0) return null;
  // 对象之后只允许空白、闭合标签或包裹用的尖括号，避免从“JSON 示例 + 散文”里抠出可执行调用。
  const rest = body.slice(end).trim();
  if (rest && !/^(?:\s*(?:<\/?[a-zA-Z_][\w:|.-]*>|>|<\/))*\s*$/.test(rest)) return null;
  try { return toCall(JSON.parse(body.slice(0, end)), known); } catch { return null; }
}

export function parseTextToolCall(text: string, known: Set<string>): TextToolCall | null {
  if (text.length > 64_000) return null;
  let value = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(value);
  if (fence) value = fence[1].trim();
  const gemma = /^<\|tool_call>call:([a-zA-Z_][\w-]*)/.exec(value);
  try {
    if (gemma) {
      if (!known.has(gemma[1]) || !value.endsWith("<tool_call|>")) return null;
      const parser = new GemmaValue(value.slice(gemma[0].length, -"<tool_call|>".length));
      const args = parser.parse();
      return object(args) ? { name: gemma[1], args } : null;
    }
    if (!value.startsWith("{")) return recoverWrappedCall(value, known);
    const end = balancedJsonEnd(value);
    // Recover only surplus closing braces after a complete strict JSON object.
    if (end < 0 || !/^\}{0,2}$/.test(value.slice(end).replace(/\s/g, ""))) return null;
    return toCall(JSON.parse(value.slice(0, end)), known);
  } catch { return null; }
}

// Gemma's finite data grammar: JSON values, bare object keys and <|"|> strings.
// Expressions, calls, comments, duplicate keys and prototype keys are rejected.
class GemmaValue {
  private source: string;
  private offset = 0;
  constructor(source: string) { this.source = source; }
  parse(): unknown { const result = this.value(0); this.space(); if (this.offset !== this.source.length) throw new Error("trailing data"); return result; }
  private space() { while (/\s/.test(this.source[this.offset] ?? "") && this.offset < this.source.length) this.offset++; }
  private string(): string {
    if (this.source.startsWith('<|"|>', this.offset)) {
      const start = this.offset + 5, end = this.source.indexOf('<|"|>', start);
      if (end < 0) throw new Error("unclosed string"); this.offset = end + 5; return this.source.slice(start, end);
    }
    const start = this.offset++; let escaped = false;
    while (this.offset < this.source.length) {
      const c = this.source[this.offset++];
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') return JSON.parse(this.source.slice(start, this.offset));
    }
    throw new Error("unclosed string");
  }
  private value(depth: number): unknown {
    if (depth > 32) throw new Error("depth limit"); this.space();
    const c = this.source[this.offset];
    if (c === '"' || this.source.startsWith('<|"|>', this.offset)) return this.string();
    if (c === "{") {
      this.offset++; const result: Record<string, unknown> = {}; this.space();
      if (this.source[this.offset] === "}") { this.offset++; return result; }
      for (;;) {
        this.space(); const key = this.source[this.offset] === '"' || this.source.startsWith('<|"|>', this.offset) ? this.string() : this.identifier();
        if (["__proto__", "prototype", "constructor"].includes(key) || Object.hasOwn(result, key)) throw new Error("unsafe key");
        this.space(); if (this.source[this.offset++] !== ":") throw new Error("missing colon");
        result[key] = this.value(depth + 1); this.space();
        const next = this.source[this.offset++]; if (next === "}") return result; if (next !== ",") throw new Error("missing comma");
      }
    }
    if (c === "[") {
      this.offset++; const result: unknown[] = []; this.space();
      if (this.source[this.offset] === "]") { this.offset++; return result; }
      for (;;) { result.push(this.value(depth + 1)); this.space(); const next = this.source[this.offset++]; if (next === "]") return result; if (next !== ",") throw new Error("missing comma"); }
    }
    for (const literal of ["true", "false", "null"]) if (this.source.startsWith(literal, this.offset)) { this.offset += literal.length; return JSON.parse(literal); }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.offset));
    if (number) { this.offset += number[0].length; const result = Number(number[0]); if (Number.isFinite(result)) return result; }
    throw new Error("invalid value");
  }
  private identifier() { const match = /^[a-zA-Z_][\w-]*/.exec(this.source.slice(this.offset)); if (!match) throw new Error("invalid key"); this.offset += match[0].length; return match[0]; }
}
