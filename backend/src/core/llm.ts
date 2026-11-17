// OpenAI-compatible adapter: one retry owner, bounded task/idle deadlines, explicit capabilities.
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatResult, ToolDef } from "./types.ts";
import { errorMessage, LlmTransportError } from "./errors.ts";
import { abortable, responseText, readSse } from "./llm-stream.ts";
import { normalizeUsage } from "./llm-usage.ts";
import { generationPolicy, type GenerationStage } from "./generation-policy.ts";
import { canonicalArgs, sha256 } from "../runtime/idempotency.ts";
import { messagesTokens, toolsTokens, estimateTokens } from "./context.ts";
import { resolveModelCapabilities } from "./model-capabilities.ts";
import { parseTextToolCall } from "./tool-protocol.ts";
import { hasRawToolMarkup, TOOL_PROTOCOL_ERROR, protocolSafeStream } from '../../../shared/tool-protocol.ts';

export interface ChatOptions {
  messages: ChatMessage[]; tools?: ToolDef[]; reasoning?: string; temperature?: number;
  maxOutputTokens?: number; deadlineAt?: number; signal?: AbortSignal; stage?: GenerationStage;
  onDelta?: (text: string) => void;
}
export interface LlmTransport {
  chat(opts: ChatOptions): Promise<ChatResult>;
  // An adapter owns its token accounting. Synthetic/injected transports may
  // use different usage units; unknown estimates retain the actual-usage stop.
  estimateInputTokens?(opts: Pick<ChatOptions, "messages" | "tools">): number;
}
export interface DeepSeekConfig {
  apiKey: string; baseUrl?: string; model?: string; fetchImpl?: typeof fetch;
  maxRetries?: number; timeoutMs?: number; capabilities?: Record<string, unknown>;
  reasoningPreference?: string; contextLimit?: number | null;
}

// Compatibility helper. Runtime calls use explicit endpoint capabilities below.
export function reasoningParams(model: string | undefined, tier: string | undefined): Record<string, unknown> {
  const m = (model ?? "").toLowerCase(), t = tier ?? "low";
  if (/^(o1|o3|o4|gpt-5)/.test(m)) return { reasoning_effort: t };
  if (/qwen|qwq/.test(m)) return { enable_thinking: t !== "low" };
  return {};
}
export class DeepSeekTransport implements LlmTransport {
  private cfg: DeepSeekConfig;
  constructor(cfg: DeepSeekConfig) {
    if (!cfg.apiKey) throw new Error("LLM_API_KEY missing (server-side)");
    const resolved = resolveModelCapabilities(cfg.baseUrl ?? "https://api.deepseek.com", cfg.model ?? "deepseek-chat", cfg.capabilities, cfg.contextLimit);
    this.cfg = { ...cfg, ...(cfg.capabilities !== undefined || resolved.profile ? { capabilities: resolved.capabilities } : {}), contextLimit: resolved.contextLimit };
  }
  estimateInputTokens(opts: Pick<ChatOptions, "messages" | "tools">): number {
    return messagesTokens(opts.messages) + toolsTokens(opts.tools);
  }
  private redact(text: string): string {
    const key = this.cfg.apiKey;
    const escaped = key.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
    const re = new RegExp(key.length < 8 ? "\\b" + escaped + "\\b" : escaped, "g");
    return text.replace(re, "[密钥已隐藏]").split(key.length >= 8 ? encodeURIComponent(key) : "\u0000").join("[密钥已隐藏]");
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const cfg = this.cfg, caps = cfg.capabilities ?? {}, start = Date.now();
    const timeoutMs = cfg.timeoutMs ?? 60000;
    let deadline = Math.min(opts.deadlineAt ?? Infinity, start + timeoutMs);
    // Runtime callers supply a task deadline. Meaningful SSE progress may renew
    // the idle timeout, bounded by that deadline and a ten-minute request cap.
    // Standalone/non-streaming/retry requests retain the original total timeout.
    const streamDeadline = opts.deadlineAt === undefined ? deadline : Math.min(opts.deadlineAt, start + Math.max(timeoutMs, 600000));
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now()));
    const progress = () => {
      if (ctrl.signal.aborted) return;
      deadline = Math.min(streamDeadline, Date.now() + timeoutMs);
      clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now()));
    };
    const abort = () => ctrl.abort(); opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) ctrl.abort();
    const requestId = randomUUID();
    const estimatedInput = messagesTokens(opts.messages) + toolsTokens(opts.tools);
    const maxOutput = Math.max(1, Math.min(opts.maxOutputTokens ?? 8192, Number(caps.maxOutputTokens) || 8192, cfg.contextLimit ? cfg.contextLimit - estimatedInput : Infinity));
    const policy = generationPolicy(caps, opts.reasoning ?? cfg.reasoningPreference, opts.stage ?? "simple", maxOutput);
    const thinking = caps.reasoning === 'deepseek_thinking';
    // Provider/model-bound opaque continuation; never forward another model's trace.
    const reasoningSource = sha256(canonicalArgs({ baseUrl: (cfg.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, ''), model: cfg.model ?? 'deepseek-chat' }));
    const tools = [...(opts.tools ?? [])].sort((a, b) => a.function.name.localeCompare(b.function.name));
    const jsonTools = tools.length > 0 && !["native", "none"].includes(String(caps.tools)) && cfg.capabilities !== undefined;
    // Old malformed assistant turns are not executable instructions or successful
    // observations. Preserve the user's text; quarantine only model output.
    const history = opts.messages.map(message => message.role === 'assistant' && typeof message.content === 'string' && hasRawToolMarkup(message.content) ? { ...message, content: TOOL_PROTOCOL_ERROR } : message);
    const wireHistory = history.map(message => {
      const { reasoning_content, reasoning_source, ...plain } = message;
      // Non-thinking historical replies legitimately have no trace. The empty
      // field makes that explicit, rather than fabricating missing reasoning.
      return thinking && message.role === 'assistant' ? { ...plain, reasoning_content: reasoning_source === reasoningSource && typeof reasoning_content === 'string' ? reasoning_content : '' } : plain;
    });
    const protocol = '工具协议：需要工具时仅输出一个严格JSON {"tool":"名称","args":{...}}，等待真实观测再继续；不要额外闭括号或裸控制标记。仅可使用以下工具及参数；普通文本不是工具结果：\n' + JSON.stringify(tools);
    const messages = jsonTools || caps.singleSystem === true ? [
      { role: "system" as const, content: wireHistory.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).concat(jsonTools ? [protocol] : []).join("\n\n") },
      ...wireHistory.filter(m => m.role !== "system"),
    ] : wireHistory;
    const body = {
      model: cfg.model ?? "deepseek-chat", messages,
      ...(caps.temperature === true ? { temperature: opts.temperature ?? 0.2 } : {}),
      ...policy.params,
      // Explicit endpoint configuration only; never infer this from model names.
      ...(!thinking && caps.thinking === false ? { thinking: { type: 'disabled' } } : {}),
      ...(caps.outputParameter === "max_tokens" ? { max_tokens: maxOutput } : caps.outputParameter === "max_completion_tokens" ? { max_completion_tokens: maxOutput } : {}),
      ...(tools.length && (caps.tools === "native" || cfg.capabilities === undefined) ? { tools, tool_choice: "auto" } : {}),
      ...(caps.streaming === true ? { stream: true, ...(caps.streamUsage === true ? { stream_options: { include_usage: true } } : {}) } : {}),
    };
    let lastError: unknown;
    let attempts = 0;
    try {
      if (opts.signal?.aborted) throw new LlmTransportError("模型请求已由调用方取消", { reason: "cancelled" });
      if (opts.messages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")) && caps.vision === false) throw new LlmTransportError("当前端点已配置为不支持图片输入，请选择视觉模型或使用文字材料", { reason: "capability" });
      if (cfg.contextLimit && estimatedInput >= cfg.contextLimit) throw new LlmTransportError("上下文超出已配置窗口，请缩小输入", { reason: "input" });
      const maxAttempts = Math.max(1, Math.min(3, (cfg.maxRetries ?? 2) + 1));
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attempts = attempt;
        try {
          const res = await abortable((cfg.fetchImpl ?? fetch)((cfg.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "") + "/chat/completions", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
            redirect: "error", signal: ctrl.signal, body: JSON.stringify(body),
          }), ctrl.signal);
          const retryable = [429, 500, 502, 503, 504].includes(res.status);
          if (retryable && attempt < maxAttempts) {
            void res.body?.cancel().catch(() => {});
            const retryAfter = res.headers?.get("retry-after");
            const retryMs = retryAfter ? (/^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 500 * 2 ** (attempt - 1);
            await this.delay(Math.min(10000, retryMs), ctrl.signal, deadline);
            continue;
          }
          let content: string, toolCalls: ChatResult["toolCalls"], model: string, rawUsage: unknown, finishReason: string | null, truncated: boolean, ttftMs: number | null, reasoningContent: string | undefined;
          let streamInterrupted = false;
          if (res.ok && res.headers?.get("content-type")?.includes("text/event-stream")) {
            const safe = protocolSafeStream(opts.onDelta);
            const stream = await readSse(res, { signal: ctrl.signal, start, now: Date.now, onDelta: text => safe.push(text), captureReasoning: thinking, onProgress: progress, redact: (text) => this.redact(text), guardTail: cfg.apiKey.length });
            ({ content, toolCalls, model, finishReason, truncated, ttftMs, streamInterrupted } = stream); rawUsage = stream.usage; reasoningContent = stream.reasoningContent; safe.finish();
            toolCalls = JSON.parse(JSON.stringify(toolCalls), (_key, value) => typeof value === "string" ? this.redact(value) : value);
          } else {
            const text = await responseText(res, ctrl.signal);
            let data: any;
            try { data = JSON.parse(text, (_key, value) => typeof value === "string" ? this.redact(value) : value); }
            catch { throw new LlmTransportError("LLM 返回非 JSON（HTTP " + res.status + "）", { reason: "protocol", status: res.status }); }
            if (!res.ok) throw new LlmTransportError("上游模型错误 HTTP " + res.status + ": " + errorMessage(data.error ?? data), { reason: [401,403].includes(res.status) ? "authentication" : res.status === 429 ? "rate_limit" : "upstream", status: res.status });
            const message = data.choices?.[0]?.message;
            if (!message || typeof message !== "object") throw new LlmTransportError("模型响应协议无效：缺少choices/message", { reason: "protocol" });
            content = typeof message.content === "string" ? message.content : "";
            if (thinking && typeof message.reasoning_content === 'string') reasoningContent = message.reasoning_content;
            toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
            model = typeof data.model === "string" ? data.model : "unknown"; rawUsage = data.usage;
            finishReason = data.choices[0].finish_reason ?? null; truncated = finishReason === "length";
            ttftMs = null; // Non-streaming responses do not expose first-token timing.
          }
          const usage = normalizeUsage(rawUsage);
          if (!truncated && !toolCalls.length && caps.tools === "native") {
            const parsed = parseTextToolCall(content, new Set(tools.map(t => t.function.name)));
            if (parsed) { toolCalls = [{ id: `compat-${requestId}`, type: "function", function: { name: parsed.name, arguments: JSON.stringify(parsed.args) } }]; content = ""; }
          }
          return {
            content, toolCalls, model, finishReason, truncated, streamInterrupted,
            ...(thinking && reasoningContent !== undefined ? { reasoningContent, reasoningSource } : {}),
            usage: { input: usage.inputTotal ?? estimatedInput, output: usage.output ?? estimateTokens(content + JSON.stringify(toolCalls)) },
            telemetry: { requestId, attempts: attempt, ttftMs, totalMs: Date.now() - start, finishReason,
              stablePrefixHash: sha256(canonicalArgs({ system: opts.messages.find((m) => m.role === "system")?.content ?? "" })),
              toolsHash: sha256(canonicalArgs(tools)), usage, reasoning: { requested: policy.requested, effective: policy.effective, family: policy.family, stage: policy.stage, reason: policy.reason } },
          };
        } catch (error) {
          lastError = error;
          // A received response/protocol error is never retried or switched to another model.
          const network = error instanceof TypeError;
          if (!network || ctrl.signal.aborted || attempt >= maxAttempts) break;
          await this.delay(500 * 2 ** (attempt - 1), ctrl.signal, deadline);
        }
      }
      throw lastError;
    } catch (error) {
      const reason = opts.signal?.aborted ? "cancelled" : ctrl.signal.aborted ? "timeout" : error instanceof LlmTransportError ? error.reason : error instanceof SyntaxError ? "protocol" : "network";
      const message = reason === "timeout" ? `模型响应超时（本次请求限时${Math.max(0, Math.round((deadline - start) / 1000))}秒）` : reason === "cancelled" ? "模型请求已由调用方取消" : error instanceof Error ? error.message : errorMessage(error);
      throw new LlmTransportError(errorMessage(this.redact(message)), { reason, status: error instanceof LlmTransportError ? error.status : undefined, telemetry: { requestId, attempts, ttftMs: null, totalMs: Date.now() - start, finishReason: null, stablePrefixHash: sha256(canonicalArgs({ system: opts.messages.find((m) => m.role === "system")?.content ?? "" })), toolsHash: sha256(canonicalArgs(tools)), usage: normalizeUsage(null), reasoning: { requested: policy.requested, effective: policy.effective, family: policy.family, stage: policy.stage, reason: policy.reason } } });
    } finally { clearTimeout(timer); opts.signal?.removeEventListener("abort", abort); }
  }
  private async delay(ms: number, signal: AbortSignal, deadline: number) {
    if (!Number.isFinite(ms) || ms >= deadline - Date.now()) throw new Error("模型请求deadline不足以完成重试");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); }), signal); }
    finally { if (timer) clearTimeout(timer); }
  }
}
export function transportFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): LlmTransport {
  let capabilities: Record<string, unknown> = {};
  try { capabilities = JSON.parse(env.LLM_CAPABILITIES ?? "{}"); } catch { /* unknown */ }
  return new DeepSeekTransport({ apiKey: env.LLM_API_KEY ?? "", baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, fetchImpl, capabilities,
    timeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined, maxRetries: env.LLM_MAX_RETRIES ? Number(env.LLM_MAX_RETRIES) : undefined });
}
