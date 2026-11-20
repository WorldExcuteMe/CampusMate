import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/app/config", () => ({ isCloudRuntime: false, supabaseClient: { auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } } }));
import { listProviders, saveProvider } from "../llm/proxy";
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("模型列表与保存都走认证后端，省略新key，不走遗留明文文件代理", async () => {
  vi.stubEnv("VITE_BACKEND_URL", "http://backend.test");
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return { ok: true, text: async () => JSON.stringify(init.method === "POST" ? { provider: {} } : { providers: [{ id: "builtin", displayName: "Gemma", modelId: "gemma-4", hasKey: true }] }) };
  }));
  expect((await listProviders())[0].model).toBe("gemma-4");
  await saveProvider({ id: "custom", name: "编辑", model: "a", baseUrl: "https://custom.example", protocol: "openai", apiKey: "" });
  expect(requests.every((r) => r.url.startsWith("http://backend.test/v1/providers"))).toBe(true);
  expect(JSON.parse(requests[1].init.body as string)).not.toHaveProperty("apiKey");
  expect((requests[1].init.headers as Record<string, string>).Authorization).toBe("Bearer fixture-token");
});
