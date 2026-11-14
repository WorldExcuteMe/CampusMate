import { describe, expect, it, vi, afterEach } from "vitest";
import { llmChat } from "../llm/proxy";
import { LlmRequestError } from "../llm/errors";

afterEach(() => vi.unstubAllGlobals());

describe("llm 错误透传：上游错误对象不得变成 [object Object]", () => {
  it("invalid_tools is a request error and is never retried or failed over", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "invalid_tools" }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(llmChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(LlmRequestError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("上游 error 为对象时提取 message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "maximum context length exceeded", type: "invalid_request_error" } }),
    })));
    await expect(llmChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/maximum context length exceeded/);
  });
  it("上游 error 为字符串时直接透传", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "invalid api key" }),
    })));
    await expect(llmChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/invalid api key/);
  });
  it("网络失败重试后仍失败抛真实错误（非 [object Object]）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(llmChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/Failed to fetch/);
  }, 20000);
});
