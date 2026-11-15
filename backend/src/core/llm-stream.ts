import type { ToolCall } from "./types.ts";
import { LlmTransportError, errorMessage } from "./errors.ts";
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("模型请求超时或已取消"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("模型请求超时或已取消"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function responseText(res: Response, signal: AbortSignal, cap = 4_000_000): Promise<string> {
  if (!res.body?.getReader) return abortable(res.text(), signal).then((text) => { if (text.length > cap) throw new Error("模型响应超过大小限制"); return text; });
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value } = await abortable(reader.read(), signal); if (done) break; total += value.byteLength; if (total > cap) throw new Error("模型响应超过大小限制"); chunks.push(value); }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
}
export async function readSse(res: Response, opts: { signal: AbortSignal; start: number; now: () => number; onDelta?: (text: string) => void; redact: (text: string) => string; guardTail?: number }) {
  const reader = res.body?.getReader(); if (!reader) throw new Error("模型流缺少响应体");
  const decoder = new TextDecoder(); let buffer = "", content = "", pending = "", model = "unknown";
  let doneMarker = false, finishReason: string | null = null, usage: unknown, ttftMs: number | null = null, bytes = 0, sentAt = opts.start;
  const calls = new Map<string, ToolCall>();
  const active = new Map<number, string>(), byId = new Map<string, string>();
  let serial = 0;
  const flush = (final = false) => {
    pending = opts.redact(pending);
    const length = final ? pending.length : Math.max(0, pending.length - (opts.guardTail ?? 0));
    if (length) { opts.onDelta?.(pending.slice(0, length)); pending = pending.slice(length); sentAt = opts.now(); }
  };
  const frame = (text: string) => {
    const payload = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!payload) return;
    if (payload === "[DONE]") { doneMarker = true; return; }
    const data = JSON.parse(payload);
    if (data.error) {
      const status = Number(data.error.status ?? data.status);
      const category = String(data.error.type ?? data.error.code ?? "").toLowerCase();
      const reason = status === 401 || status === 403 || /auth|permission|api.?key/.test(category) ? "authentication" : status === 429 || /rate.?limit/.test(category) ? "rate_limit" : status >= 500 || /server|overload/.test(category) ? "upstream" : "protocol";
      throw new LlmTransportError(`模型流返回错误：${errorMessage(data.error)}`, { reason, status: Number.isInteger(status) ? status : undefined });
    }
    if (typeof data.model === "string") model = data.model;
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (typeof delta?.content === "string") {
      ttftMs ??= opts.now() - opts.start; content += delta.content; pending += delta.content;
      if (pending.length >= 64 || opts.now() - sentAt >= 250) flush();
    }
    for (const piece of delta?.tool_calls ?? []) {
      if (!Number.isInteger(piece.index) || piece.index < 0 || piece.index >= 64) throw new LlmTransportError("工具流索引无效", { reason: "protocol" });
      let key = active.get(piece.index);
      if (piece.id) {
        if (typeof piece.id !== "string" || piece.id.length > 256) throw new LlmTransportError("工具流ID无效", { reason: "protocol" });
        const existing = byId.get(piece.id);
        if (existing) key = existing;
        else {
          // Some compatible gateways reuse index=0 for independent complete
          // IDs. An index routes subsequent deltas, never merges two IDs.
          if (!key || calls.get(key)?.id) key = `call-${serial++}`;
          byId.set(piece.id, key);
        }
      }
      key ??= `call-${serial++}`;
      if (!calls.has(key) && calls.size >= 64) throw new LlmTransportError("工具流调用数量超限", { reason: "protocol" });
      const call = calls.get(key) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (piece.id) call.id = piece.id;
      if (piece.function?.name) {
        if (typeof piece.function.name !== "string") throw new LlmTransportError("工具流函数名称无效", { reason: "protocol" });
        if (piece.function.name !== call.function.name) call.function.name = piece.function.name.startsWith(call.function.name) ? piece.function.name : call.function.name + piece.function.name;
      }
      if (piece.function?.arguments) {
        if (typeof piece.function.arguments !== "string") throw new LlmTransportError("工具流参数类型无效", { reason: "protocol" });
        call.function.arguments += piece.function.arguments;
      }
      calls.set(key, call); active.set(piece.index, key);
    }
  };
  let broken = false;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), opts.signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 4_000_000) throw new Error("模型流超过大小限制");
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) { frame(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length); if (doneMarker) break; }
      if (doneMarker) break;
    }
    if (!doneMarker) { buffer += decoder.decode(); if (buffer.trim()) frame(buffer); }
  } catch (error) { if (error instanceof LlmTransportError || (!content && !calls.size)) throw error; broken = true; }
  finally { flush(true); void reader.cancel().catch(() => {}); }
  return { content: opts.redact(content), toolCalls: [...calls.values()], model, usage, ttftMs, finishReason, truncated: broken || !doneMarker || finishReason === "length" || !finishReason };
}
