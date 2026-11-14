// 服务端 LLM Provider Adapter。密钥仅服务端持有；退避重试；错误统一 errorMessage；可注入 fetch 便于测试。
import type { ChatMessage, ChatResult, ToolDef } from "./types.ts";
import { errorMessage, LlmTransportError } from "./errors.ts";

export interface LlmTransport {
  chat(opts: { messages: ChatMessage[]; tools?: ToolDef[]; reasoning?: string; temperature?: number }): Promise<ChatResult>;
}

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

// 思考强度 → 各厂商 OpenAI-compatible 端点安全参数（移植自 web reasoning.ts）。
export function reasoningParams(model: string | undefined, tier: string | undefined): Record<string, unknown> {
  const m = (model ?? "").toLowerCase();
  const t = tier ?? "low";
  if (/^(o1|o3|o4|gpt-5)/.test(m)) return { reasoning_effort: t };
  if (/qwen|qwq/.test(m)) return { enable_thinking: t !== "low" };
  return {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DeepSeekTransport implements LlmTransport {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private fetchImpl: typeof fetch;
  private maxRetries: number;
  private timeoutMs: number;

  constructor(cfg: DeepSeekConfig) {
    if (!cfg.apiKey) throw new Error("LLM_API_KEY missing (server-side)");
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl ?? "https://api.deepseek.com";
    this.model = cfg.model ?? "deepseek-chat";
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
  }

  async chat(opts: { messages: ChatMessage[]; tools?: ToolDef[]; reasoning?: string; temperature?: number }): Promise<ChatResult> {
    const retryable = new Set([429, 500, 502, 503, 504]);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: this.model,
            messages: opts.messages,
            temperature: opts.temperature ?? 0.2,
            ...reasoningParams(this.model, opts.reasoning),
            ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
          }),
        });
        clearTimeout(timer);
        if (retryable.has(res.status) && attempt < this.maxRetries) {
          await sleep(Math.min(10_000, 500 * 2 ** attempt));
          continue;
        }
        const text = await res.text();
        let data: any;
        try { data = JSON.parse(text); } catch {
          throw new LlmTransportError(`LLM 返回非 JSON（HTTP ${res.status}，${text.slice(0, 120) || "空体"}）`);
        }
        if (!res.ok) {
          const e = data?.error;
          const msg = typeof e === "string" ? e : errorMessage(e ?? data);
          throw new LlmTransportError(`上游模型错误 HTTP ${res.status}: ${msg}`);
        }
        const m = data.choices?.[0]?.message ?? {};
        return {
          content: m.content ?? "",
          toolCalls: m.tool_calls ?? [],
          usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
          model: data.model ?? this.model,
        };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        const network = err instanceof TypeError || (err instanceof Error && err.name === "AbortError");
        if ((network || isRetryableStatus(err)) && attempt < this.maxRetries) {
          await sleep(Math.min(10_000, 500 * 2 ** attempt));
          continue;
        }
        break;
      }
    }
    throw lastErr instanceof LlmTransportError ? lastErr : new LlmTransportError(errorMessage(lastErr), { cause: lastErr });
  }
}

function isRetryableStatus(err: unknown): boolean {
  return err instanceof LlmTransportError && /HTTP (429|500|502|503|504)/.test(err.message);
}

// 从环境变量构造（仅服务端调用）。慢端点（如 AMD Gemma 单次可达 160s+）用 LLM_TIMEOUT_MS 调高超时，避免误判连接失败。
export function transportFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): LlmTransport {
  return new DeepSeekTransport({
    apiKey: env.LLM_API_KEY ?? "",
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    fetchImpl,
    timeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined,
    maxRetries: env.LLM_MAX_RETRIES ? Number(env.LLM_MAX_RETRIES) : undefined,
  });
}