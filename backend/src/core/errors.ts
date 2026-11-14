// 统一错误序列化 + 传输错误类型 + 错误分类（移植自 web/src/lib/llm/errors.ts 并扩展）。
// 任何被抛值（Error/字符串/Supabase 普通对象/嵌套/循环引用/null）都可读，绝不产出 [object Object]。
import type { ErrorClass } from "./types.ts";

const MAX_LEN = 500;

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN) + "…" : t;
}

function safeStringify(o: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(o, (_k, v) => {
      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
      }
      return v;
    }) ?? "";
  } catch {
    return "";
  }
}

function fromObject(o: Record<string, unknown>): string {
  const parts: string[] = [];
  const msg = o.message ?? o.error_description ?? o.error;
  if (typeof msg === "string" && msg.trim()) parts.push(msg.trim());
  else if (msg && typeof msg === "object") parts.push(fromObject(msg as Record<string, unknown>));
  const details = o.details;
  if (typeof details === "string" && details.trim()) parts.push(details.trim());
  const hint = o.hint;
  if (typeof hint === "string" && hint.trim()) parts.push(`hint: ${hint.trim()}`);
  const code = o.code ?? o.status ?? o.statusCode;
  if (code != null && code !== "") parts.push(`code: ${String(code)}`);
  if (parts.length) return parts.join(" | ");
  const j = safeStringify(o);
  if (j && j !== "{}") return j;
  const keys = Object.keys(o);
  return keys.length ? `对象{${keys.join(", ")}}` : "空对象（无错误信息）";
}

export function errorMessage(err: unknown): string {
  if (err == null) return "未知错误（无错误信息）";
  if (typeof err === "string") return clip(err) || "空错误信息";
  if (err instanceof Error) return clip(err.message || err.name || "Error");
  if (typeof err === "object") return clip(fromObject(err as Record<string, unknown>));
  return clip(String(err));
}

export class LlmTransportError extends Error {
  readonly kind = "llm-transport";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LlmTransportError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isTransportError(err: unknown): boolean {
  return err instanceof LlmTransportError || (err instanceof Error && err.name === "LlmTransportError");
}

// 错误分类 → 恢复策略（TASK_RUNTIME_SPEC §7）。
export function classifyError(err: unknown): ErrorClass {
  if (isTransportError(err)) return "transport";
  const msg = errorMessage(err).toLowerCase();
  if (err instanceof Error && err.name === "AbortError") return "transport";
  if (/429|rate.?limit|too many requests/.test(msg)) return "rate_limit";
  if (/401|403|api.?key|permission|unauthorized|forbidden/.test(msg)) return "permission";
  if (/json|parse|invalid|schema|tool_call_id/.test(msg)) return "invalid_model_output";
  if (/budget|exceed|quota|预算/.test(msg)) return "budget";
  if (/timeout|timed out|econnreset|socket|network|fetch failed|502|503|504/.test(msg)) return "tool_transient";
  return "tool_permanent";
}

export function isRetryable(cls: ErrorClass): boolean {
  return cls === "transport" || cls === "rate_limit" || cls === "tool_transient";
}