// Portable Web API handler shared by the local proxy and the deployed Deno Function.
// Production is fail-closed: the entry point MUST supply an authorization verifier.
export interface ServerProvider {
  id: string; name: string; baseUrl: string; protocol: string; model: string; apiKey: string;
}
export interface HandlerOptions {
  authorize?: (request: Request) => Promise<string | null>;
  providers: () => ServerProvider[] | Promise<ServerProvider[]>;
  saveProvider?: (provider: ServerProvider) => void | Promise<void>;
  removeProvider?: (id: string) => void | Promise<void>;
  fetch?: typeof fetch;
  allowedOrigins?: string[];
  allowLoopbackUpstream?: boolean; // fixtures/local debugging only; never enabled by production
  timeoutMs?: number;
  maxTokens?: number;
  requestsPerMinute?: number;
}
const MAX_BODY = 256_000;
// Agent currently exposes 18 tools. Keep a bounded limit without rejecting its own toolset.
// DeepSeek function calling supports up to 128 functions:
// https://api-docs.deepseek.com/news/news0725/
export const MAX_TOOLS = 128;
const publicView = (p: ServerProvider) => ({
  id: p.id, name: p.name, baseUrl: p.baseUrl, protocol: p.protocol,
  model: p.model, hasKey: Boolean(p.apiKey),
});

function validProvider(p: ServerProvider, loopback: boolean): boolean {
  if (p.protocol !== "openai" || !p.id || !p.model || !p.apiKey) return false;
  try {
    const url = new URL(p.baseUrl);
    if (url.username || url.password || url.search || url.hash) return false;
    const host = url.hostname.toLowerCase();
    if (loopback && ["localhost", "127.0.0.1", "[::1]"].includes(host)) {
      return ["http:", "https:"].includes(url.protocol);
    }
    // Production URLs are administrator-controlled secrets, never visitor-supplied.
    return url.protocol === "https:" && !/^(localhost|.*\.(local|internal)|\[.*|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  } catch { return false; }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("415");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("400");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error("413"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error("400"); }
}

export function createHandler(options: HandlerOptions) {
  const fetcher = options.fetch ?? fetch;
  const buckets = new Map<string, { start: number; count: number }>();
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const requestUrl = new URL(request.url);
    const cors: Record<string, string> = origin && options.allowedOrigins?.includes(origin) ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Vary": "Origin",
    } : {};
    const json = (status: number, body: unknown) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store", ...cors },
    });
    if (origin && origin !== requestUrl.origin && !options.allowedOrigins?.includes(origin)) {
      return json(403, { error: "origin_not_allowed" });
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const route = requestUrl.pathname.replace(/^\/(?:functions\/v1\/app|api)(?=\/|$)/, "");
    if (!(route === "/providers" || route.startsWith("/providers/") || route === "/llm")) {
      return json(404, { error: "not_found" });
    }
    try {
      const identity = await options.authorize?.(request);
      if (!identity) return json(401, { error: "authentication_required" });
      const providers = await options.providers();
      const mutable = Boolean(options.saveProvider && options.removeProvider);
      if (request.method === "GET" && route === "/providers") {
        return json(200, { providers: providers.map(publicView), mutable });
      }
      if (route === "/providers" && request.method === "POST") {
        if (!mutable) return json(405, { error: "providers_managed_by_server_secrets" });
        const data = await readJson(request);
        const id = String(data.id ?? "");
        const previous = providers.find((p) => p.id === id);
        const provider: ServerProvider = {
          id, name: String(data.name || id).slice(0, 100),
          baseUrl: String(data.baseUrl ?? "").replace(/\/$/, ""),
          protocol: String(data.protocol || "openai"), model: String(data.model || ""),
          apiKey: String(data.apiKey || previous?.apiKey || ""),
        };
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || id === "builtin-deepseek" ||
            !validProvider(provider, options.allowLoopbackUpstream === true)) {
          return json(400, { error: "invalid_provider_openai_https_key_and_model_required" });
        }
        await options.saveProvider!(provider);
        return json(200, { ok: true, provider: publicView(provider) });
      }
      if (route.startsWith("/providers/") && request.method === "DELETE") {
        if (!mutable) return json(405, { error: "providers_managed_by_server_secrets" });
        const id = decodeURIComponent(route.slice("/providers/".length));
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || id === "builtin-deepseek") {
          return json(400, { error: "invalid_provider_id" });
        }
        await options.removeProvider!(id);
        return json(200, { ok: true });
      }
      if (route !== "/llm" || request.method !== "POST") return json(405, { error: "method_not_allowed" });
      const now = Date.now();
      for (const [key, b] of buckets) if (now - b.start >= 60_000) buckets.delete(key);
      const bucket = buckets.get(identity) ?? { start: now, count: 0 };
      if (bucket.count >= (options.requestsPerMinute ?? 20) || buckets.size >= 1000 && !buckets.has(identity)) {
        return json(429, { error: "rate_limit_exceeded" });
      }
      bucket.count++; buckets.set(identity, bucket);
      const payload = await readJson(request);
      const provider = payload.providerId
        ? providers.find((p) => p.id === payload.providerId)
        : providers.find((p) => p.apiKey);
      if (!provider || !validProvider(provider, options.allowLoopbackUpstream === true)) {
        return json(503, { error: "model_not_configured" });
      }
      if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 50 ||
          payload.messages.some((m) => !m || !["system", "user", "assistant", "tool"].includes(m.role) ||
            !(typeof m.content === "string" || m.role === "assistant" && m.content === null))) {
        return json(400, { error: "invalid_messages" });
      }
      if (payload.tools !== undefined && (!Array.isArray(payload.tools) || payload.tools.length > MAX_TOOLS ||
          payload.tools.some((t) => !t || t.type !== "function" || typeof t.function?.name !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(t.function.name) || !t.function?.parameters ||
            typeof t.function.parameters !== "object" || Array.isArray(t.function.parameters)) ||
          new Set(payload.tools.map((t) => t.function.name)).size !== payload.tools.length)) {
        return json(400, { error: "invalid_tools" });
      }
      if (payload.responseFormat !== undefined &&
          (payload.responseFormat as { type?: string })?.type !== "json_object") {
        return json(400, { error: "invalid_response_format" });
      }
      const temperature = typeof payload.temperature === "number" && Number.isFinite(payload.temperature)
        ? Math.min(2, Math.max(0, payload.temperature)) : 0.2;
      try {
        const upstream = await fetcher(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
          body: JSON.stringify({
            model: provider.model, messages: payload.messages, temperature,
            ...(/^(o1|o3|o4|gpt-5)/i.test(provider.model)
              ? { reasoning_effort: ["low", "medium", "high"].includes(String(payload.reasoning)) ? payload.reasoning : "low" }
              : /qwen|qwq/i.test(provider.model) ? { enable_thinking: payload.reasoning === "medium" || payload.reasoning === "high" } : {}),
            max_tokens: options.maxTokens ?? 2048,
            ...(payload.tools ? { tools: payload.tools, tool_choice: "auto" } : {}),
            ...(payload.responseFormat ? { response_format: payload.responseFormat } : {}),
          }),
        });
        if (!upstream.ok) return json(502, { error: `upstream_http_${upstream.status}` });
        return json(200, await upstream.json());
      } catch (e) {
        const timeout = e instanceof Error && ["TimeoutError", "AbortError"].includes(e.name);
        return json(timeout ? 504 : 502, { error: timeout ? "upstream_timeout" : "upstream_unavailable" });
      }
    } catch (e) {
      const code = e instanceof Error ? Number(e.message) : NaN;
      if ([400, 413, 415].includes(code)) return json(code, { error: "invalid_request_body" });
      // Never return exception messages or upstream bodies that might contain secrets.
      return json(503, { error: "service_unavailable" });
    }
  };
}

export function supabaseAuthorizer(url: string, anonKey: string, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<string | null> => {
    const authorization = request.headers.get("Authorization") ?? "";
    if (!url || !anonKey || !/^Bearer \S+$/i.test(authorization)) return null;
    const response = await fetcher(`${url.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
      signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user.id === "string" && user.id ? user.id : null;
  };
}
