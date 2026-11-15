import type { ProviderStore, StoredProvider } from "./storage-contracts.ts";
import type { Task, ProviderSnapshot } from "./types.ts";
import { CredentialVault } from "./credentials.ts";
import { DeepSeekTransport, type LlmTransport } from "./llm.ts";
import { providerFetch, providerUrl } from "./provider-http.ts";
import { canonicalArgs, sha256 } from "../runtime/idempotency.ts";

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export interface PublicProvider {
  id: string; displayName: string; protocol: string; baseUrl: string; modelId: string; hasKey: boolean;
  capabilities: Record<string, unknown>; contextLimit: number | null; metadataSource: string; isDefault: boolean; builtin: boolean;
}

function capabilities(input: unknown): Record<string, unknown> {
  const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  const enums: Record<string, unknown[]> = { tools: ["native", "json", "none", "unknown"], vision: [true, false, "unknown"], streaming: [true, false, "unknown"], temperature: [true, false, "unknown"], reasoning: ["reasoning_effort", "enable_thinking", "thinking_budget", "none", "unknown"], outputParameter: ["max_tokens", "max_completion_tokens", "unknown"] };
  for (const [key, values] of Object.entries(enums)) result[key] = values.includes(data[key]) ? data[key] : "unknown";
  if (typeof data.streamUsage === "boolean") result.streamUsage = data.streamUsage;
  if (Number.isSafeInteger(data.maxOutputTokens) && Number(data.maxOutputTokens) >= 256) result.maxOutputTokens = Number(data.maxOutputTokens);
  return result;
}
const publicConfig = (p: StoredProvider, builtin = false): PublicProvider => ({ id: p.providerId, displayName: p.displayName, protocol: p.protocol, baseUrl: p.baseUrl, modelId: p.modelId, hasKey: Boolean(p.encryptedSecret), capabilities: p.capabilities, contextLimit: p.contextLimit ?? null, metadataSource: p.metadataSource, isDefault: p.isDefault, builtin });
const configVersion = (p: StoredProvider) => sha256(canonicalArgs({ providerId: p.providerId, modelId: p.modelId, baseUrl: p.baseUrl, capabilities: p.capabilities, contextLimit: p.contextLimit ?? null, secret: p.encryptedSecret ?? null }));

export class ProviderService {
  private store: ProviderStore; private env: Record<string, string | undefined>; private vault: CredentialVault; private fetch: typeof fetch;
  constructor(store: ProviderStore, env: Record<string, string | undefined>, fetchImpl = providerFetch) { this.store = store; this.env = env; this.vault = new CredentialVault(env); this.fetch = fetchImpl; }
  private builtin(): StoredProvider | null {
    if (!this.env.LLM_API_KEY) return null;
    const modelId = this.env.LLM_MODEL?.trim() || "deepseek-chat";
    let baseUrl: URL;
    try {
      baseUrl = new URL(this.env.LLM_BASE_URL ?? "https://api.deepseek.com");
      if (!["https:", "http:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error();
    } catch { throw new ProviderError("服务端默认模型地址配置无效", 503); }
    let caps: unknown = {};
    try { caps = JSON.parse(this.env.LLM_CAPABILITIES ?? "{}"); } catch { /* unknown */ }
    return { userId: "", providerId: "builtin", displayName: this.env.LLM_DISPLAY_NAME?.trim() || modelId, protocol: "openai", baseUrl: baseUrl.toString().replace(/\/+$/, ""), modelId, capabilities: capabilities(caps), contextLimit: Number(this.env.LLM_CONTEXT_LIMIT) || undefined, metadataSource: "server-configured", isDefault: true, createdAt: 0, updatedAt: 0 };
  }
  async list(userId: string): Promise<PublicProvider[]> {
    const custom = await this.store.list(userId);
    const builtin = this.builtin();
    const list = custom.filter((p) => p.providerId !== "builtin").map((p) => publicConfig(p));
    if (builtin) list.unshift({ ...publicConfig(builtin, true), hasKey: true, isDefault: custom.some((p) => p.isDefault) ? Boolean(custom.find((p) => p.providerId === "builtin")?.isDefault) : true });
    return list;
  }
  async save(userId: string, input: Record<string, unknown>): Promise<PublicProvider> {
    const id = String(input.providerId ?? input.id ?? "");
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id) || ["builtin", "builtin-deepseek"].includes(id)) throw new ProviderError("自定义供应商ID无效或为保留ID");
    if (input.protocol !== undefined && input.protocol !== "openai") throw new ProviderError("当前仅支持OpenAI兼容协议");
    let url: URL;
    try { url = providerUrl(String(input.baseUrl ?? "")); } catch (error) { throw new ProviderError((error as Error).message); }
    const modelId = String(input.modelId ?? input.model ?? "").trim();
    if (!modelId || modelId.length > 180) throw new ProviderError("请填写模型ID");
    let encryptedSecret;
    if (input.apiKey !== undefined && input.apiKey !== "") {
      if (typeof input.apiKey !== "string" || input.apiKey.length > 8192 || /[\r\n]/.test(input.apiKey)) throw new ProviderError("API密钥格式无效");
      try { encryptedSecret = this.vault.encrypt(input.apiKey.trim(), userId, id); } catch (error) { throw new ProviderError((error as Error).message, 503); }
    }
    const contextLimit = input.contextLimit == null || input.contextLimit === "" ? undefined : Number(input.contextLimit);
    if (contextLimit !== undefined && (!Number.isSafeInteger(contextLimit) || contextLimit < 1024 || contextLimit > 4000000)) throw new ProviderError("上下文上限无效");
    const saved = await this.store.upsert({ userId, providerId: id, displayName: String(input.displayName ?? input.name ?? id).slice(0, 120), protocol: "openai", baseUrl: url.toString().replace(/\/+$/, ""), modelId, encryptedSecret, removeSecret: input.removeSecret === true, ...(input.capabilities !== undefined ? { capabilities: capabilities(input.capabilities) } : {}), ...(input.contextLimit !== undefined ? { contextLimit: contextLimit ?? null } : {}), metadataSource: "user-configured" });
    return publicConfig(saved);
  }
  async setDefault(userId: string, id: string): Promise<void> {
    const p = id === "builtin" ? this.builtin() : await this.store.get(userId, id);
    if (!p) throw new ProviderError("模型配置不存在", 404);
    await this.store.upsert({ ...p, userId, isDefault: true });
  }
  async remove(userId: string, id: string) { if (id === "builtin") throw new ProviderError("内置配置由服务端管理"); return this.store.delete(userId, id); }
  private async resolve(userId: string, id?: string): Promise<StoredProvider> {
    const chosen = id === "builtin-deepseek" ? "builtin" : id ?? (await this.list(userId)).find((p) => p.isDefault)?.id;
    const p = chosen === "builtin" ? this.builtin() : chosen ? await this.store.get(userId, chosen) : null;
    if (!p) throw new ProviderError("所选模型不存在，请在设置中配置供应商", 404);
    if (p.protocol !== "openai") throw new ProviderError("模型协议未支持");
    return p;
  }
  private version(p: StoredProvider): string { return p.providerId === "builtin" ? sha256(configVersion(p) + this.env.LLM_API_KEY) : configVersion(p); }
  async snapshot(userId: string, providerId?: string): Promise<ProviderSnapshot> {
    const p = await this.resolve(userId, providerId);
    return { providerId: p.providerId, displayName: p.displayName, modelId: p.modelId, baseUrl: p.baseUrl, protocol: p.protocol, capabilities: p.capabilities, contextLimit: p.contextLimit ?? null, metadataSource: p.metadataSource, configVersion: this.version(p) };
  }
  async transport(task: Pick<Task, "userId" | "modelConfig">): Promise<LlmTransport> {
    const p = await this.resolve(task.userId, task.modelConfig?.providerId);
    if (task.modelConfig && this.version(p) !== task.modelConfig.configVersion) throw new ProviderError("模型配置已变更，请用新消息重新提交任务", 409);
    let key: string;
    try { key = p.providerId === "builtin" ? this.env.LLM_API_KEY! : p.encryptedSecret ? this.vault.decrypt(p.encryptedSecret, task.userId, p.providerId) : ""; } catch (error) { throw new ProviderError((error as Error).message, 503); }
    if (!key) throw new ProviderError("所选供应商未配置API密钥");
    const fetchImpl: typeof fetch = p.providerId === "builtin" && this.fetch === providerFetch ? (url, init) => fetch(url, { ...init, redirect: "error" }) : this.fetch;
    return new DeepSeekTransport({ apiKey: key, baseUrl: p.baseUrl, model: p.modelId, fetchImpl, capabilities: p.capabilities, contextLimit: p.contextLimit, reasoningPreference: task.modelConfig?.reasoningPreference, maxRetries: Number(this.env.LLM_MAX_RETRIES ?? 2), timeoutMs: Number(this.env.LLM_TIMEOUT_MS ?? 120000) });
  }
  async test(userId: string, id: string) {
    const modelConfig = await this.snapshot(userId, id);
    const transport = await this.transport({ userId, modelConfig });
    const result = await transport.chat({ messages: [{ role: "user", content: "仅回复OK" }], maxOutputTokens: 32, deadlineAt: Date.now() + 20000, reasoning: "low" });
    return { ok: true, configuredModel: modelConfig.modelId, actualModel: result.model, note: "连接成功；未据此推断工具、图片或窗口能力" };
  }
}
