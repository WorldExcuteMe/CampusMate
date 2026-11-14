// OpenAI-compatible adapter: one retry owner, one deadline, explicit capabilities.
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatResult, ToolDef } from "./types.ts";
import { errorMessage, LlmTransportError } from "./errors.ts";
import { abortable, responseText, readSse } from "./llm-stream.ts";
import { normalizeUsage } from "./llm-usage.ts";
import { generationPolicy, type GenerationStage } from "./generation-policy.ts";
import { canonicalArgs, sha256 } from "../runtime/idempotency.ts";
import { messagesTokens, toolsTokens, estimateTokens } from "./context.ts";

export interface ChatOptions {
  messages: ChatMessage[]; tools?: ToolDef[]; reasoning?: string; temperature?: number;
  maxOutputTokens?: number; deadlineAt?: number; signal?: AbortSignal; stage?: GenerationStage;
  onDelta?: (text: string) => void;
}
export interface LlmTransport { chat(opts: ChatOptions): Promise<ChatResult>; }
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
  constructor(cfg: DeepSeekConfig) { if (!cfg.apiKey) throw new Error("LLM_API_KEY missing (server-side)"); this.cfg = cfg; }
  private redact(text: string): string {
    const key = this.cfg.apiKey;
    const escaped = key.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
    const re = new RegExp(key.length < 8 ? "\\b" + escaped + "\\b" : escaped, "g");
    return text.replace(re, "[密钥已隐藏]").split(key.length >= 8 ? encodeURIComponent(key) : "\u0000").join("[密钥已隐藏]");
  }
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const cfg = this.cfg, caps = cfg.capabilities ?? {}, start = Date.now();
    const deadline = Math.min(opts.deadlineAt ?? Infinity, start + (cfg.timeoutMs ?? 60000));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now()));
    const abort = () => ctrl.abort(); opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) ctrl.abort();
    const requestId = randomUUID();
    const estimatedInput = messagesTokens(opts.messages) + toolsTokens(opts.tools);
    const maxOutput = Math.max(1, Math.min(opts.maxOutputTokens ?? 8192, Number(caps.maxOutputTokens) || 8192, cfg.contextLimit ? cfg.contextLimit - estimatedInput : Infinity));
    const policy = generationPolicy(caps, opts.reasoning ?? cfg.reasoningPreference, opts.stage ?? "simple", maxOutput);
    const tools = [...(opts.tools ?? [])].sort((a, b) => a.function.name.localeCompare(b.function.name));
    const jsonTools = tools.length > 0 && !["native", "none"].includes(String(caps.tools)) && cfg.capabilities !== undefined;
    const messages = jsonTools ? [opts.messages[0], { role: "system" as const, content: '工具协议：需要工具时仅输出JSON {"tool":"名称","args":{...}}，等待真实观测再继续。仅可使用以下工具及参数；普通文本不是工具结果：\n' + JSON.stringify(tools) }, ...opts.messages.slice(1)].filter(Boolean) : opts.messages;
    const body = {
      model: cfg.model ?? "deepseek-chat", messages,
      ...(caps.temperature === true ? { temperature: opts.temperature ?? 0.2 } : {}),
      ...policy.params,
      ...(caps.outputParameter === "max_tokens" ? { max_tokens: maxOutput } : caps.outputParameter === "max_completion_tokens" ? { max_completion_tokens: maxOutput } : {}),
      ...(tools.length && (caps.tools === "native" || cfg.capabilities === undefined) ? { tools, tool_choice: "auto" } : {}),
      ...(caps.streaming === true ? { stream: true, ...(caps.streamUsage === true ? { stream_options: { include_usage: true } } : {}) } : {}),
    };
    let lastError: unknown;
    let attempts = 0;
    try {
      if (opts.messages.some((m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")) && caps.vision !== true) throw new LlmTransportError("该端点未确认图片输入能力，请配置视觉模型或改用文字材料");
      if (cfg.contextLimit && estimatedInput >= cfg.contextLimit) throw new LlmTransportError("上下文超出已配置窗口，请缩小输入");
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
          let content: string, toolCalls: ChatResult["toolCalls"], model: string, rawUsage: unknown, finishReason: string | null, truncated: boolean, ttftMs: number | null;
          if (res.ok && res.headers?.get("content-type")?.includes("text/event-stream")) {
            const stream = await readSse(res, { signal: ctrl.signal, start, now: Date.now, onDelta: opts.onDelta, redact: (text) => this.redact(text), guardTail: cfg.apiKey.length });
            ({ content, toolCalls, model, finishReason, truncated, ttftMs } = stream); rawUsage = stream.usage;
            toolCalls = JSON.parse(JSON.stringify(toolCalls), (_key, value) => typeof value === "string" ? this.redact(value) : value);
          } else {
            const text = await responseText(res, ctrl.signal);
            let data: any;
            try { data = JSON.parse(text, (_key, value) => typeof value === "string" ? this.redact(value) : value); }
            catch { throw new LlmTransportError("LLM 返回非 JSON（HTTP " + res.status + "）"); }
            if (!res.ok) throw new LlmTransportError("上游模型错误 HTTP " + res.status + ": " + errorMessage(data.error ?? data));
            const message = data.choices?.[0]?.message;
            if (!message || typeof message !== "object") throw new LlmTransportError("模型响应协议无效：缺少choices/message");
            content = typeof message.content === "string" ? message.content : "";
            toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
            model = typeof data.model === "string" ? data.model : "unknown"; rawUsage = data.usage;
            finishReason = data.choices[0].finish_reason ?? null; truncated = finishReason === "length";
            ttftMs = Date.now() - start;
          }
          const usage = normalizeUsage(rawUsage);
          return {
            content, toolCalls, model, finishReason, truncated,
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
      throw new LlmTransportError(errorMessage(this.redact(error instanceof Error ? error.message : errorMessage(error))), { telemetry: { requestId, attempts, ttftMs: null, totalMs: Date.now() - start, finishReason: null, stablePrefixHash: sha256(canonicalArgs({ system: opts.messages.find((m) => m.role === "system")?.content ?? "" })), toolsHash: sha256(canonicalArgs(tools)), usage: normalizeUsage(null), reasoning: { requested: policy.requested, effective: policy.effective, family: policy.family, stage: policy.stage, reason: policy.reason } } });
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
