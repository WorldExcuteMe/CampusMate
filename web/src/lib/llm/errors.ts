// 统一错误序列化：任何被抛出的值（Error / 字符串 / Supabase PostgrestError 普通对象 /
// 嵌套对象 / null）都转成可读中文/原文消息，绝不产出 "[object Object]"。
// 根因：Supabase 客户端 `throw error` 抛的是 { message, details, hint, code } 普通对象，
// String(对象) === "[object Object]"，曾把工具写库失败误报成「真实模型调用中断（[object Object]）」。

const MAX_LEN = 500;

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN) + "…" : t;
}

// 循环安全 JSON：遇到重复引用标记 [Circular]，绝不抛异常。
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

// 从任意对象提取最有信息量的字段组合（message 优先，附 details/hint/code）。
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
  // 无可读字段 → 循环安全 JSON 序列化，仍不返回 [object Object]
  const j = safeStringify(o);
  if (j && j !== "{}") return j;
  // 最终兜底：列出键名，绝不回退到 Object.prototype.toString（那会是 [object Object]）
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

// 真实模型传输失败（网络/上游 HTTP/超时/非 JSON）。与工具/DB/上下文错误区分，
// 使 runChat 只在确实无法到达模型时才报「模型调用中断」，其余错误不再误降级。
export class LlmTransportError extends Error {
  readonly kind = "llm-transport" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LlmTransportError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export function isTransportError(err: unknown): boolean {
  return err instanceof LlmTransportError || (err instanceof Error && err.name === "LlmTransportError");
}