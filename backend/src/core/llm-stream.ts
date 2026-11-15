import type { ToolCall } from "./types.ts";
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
export async function readSse(res: Response, opts: { signal: AbortSignal; start: number; now: () => number; onDelta?: (text: string) => void; redact: (text: string) => string; guardTail?: number; captureReasoning?: boolean }) {
  const reader = res.body?.getReader(); if (!reader) throw new Error("模型流缺少响应体");
  const decoder = new TextDecoder(); let buffer = "", content = "", pending = "", model = "unknown";
  let doneMarker = false, finishReason: string | null = null, usage: unknown, ttftMs: number | null = null, bytes = 0, sentAt = opts.start;
  let reasoningContent: string | undefined;
  const calls = new Map<number, ToolCall>();
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
    if (typeof data.model === "string") model = data.model;
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta;
    if (opts.captureReasoning && typeof delta?.reasoning_content === 'string') {
      ttftMs ??= opts.now() - opts.start;
      reasoningContent = (reasoningContent ?? '') + delta.reasoning_content;
    }
    if (typeof delta?.content === "string") {
      ttftMs ??= opts.now() - opts.start; content += delta.content; pending += delta.content;
      if (pending.length >= 64 || opts.now() - sentAt >= 250) flush();
    }
    for (const piece of delta?.tool_calls ?? []) {
      if (!Number.isInteger(piece.index) || piece.index < 0 || piece.index >= 64) throw new Error("工具流索引无效");
      const call = calls.get(piece.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (piece.id) call.id += piece.id;
      if (piece.function?.name) call.function.name += piece.function.name;
      if (piece.function?.arguments) call.function.arguments += piece.function.arguments;
      calls.set(piece.index, call);
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
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) { frame(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length); }
    }
    buffer += decoder.decode(); if (buffer.trim()) frame(buffer);
  } catch (error) { if (!content && !calls.size && !reasoningContent) throw error; broken = true; }
  finally { flush(true); void reader.cancel().catch(() => {}); }
  return { content: opts.redact(content), toolCalls: [...calls.values()], model, usage, ttftMs, finishReason, ...(reasoningContent !== undefined ? { reasoningContent: opts.redact(reasoningContent) } : {}), truncated: broken || !doneMarker || finishReason === "length" || !finishReason };
}
