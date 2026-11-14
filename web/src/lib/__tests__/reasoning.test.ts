import { describe, expect, it } from "vitest";
import { DEFAULT_REASONING, tierForTask, reasoningParams, THINKING_BUDGET } from "../llm/reasoning";

describe("reasoning: 思考强度策略", () => {
  it("默认 low；仅核验/冲突升级 medium", () => {
    expect(DEFAULT_REASONING).toBe("low");
    for (const t of ["extract", "classify", "route", "summarize", "dedupe", "retrieve"] as const) {
      expect(tierForTask(t)).toBe("low");
    }
    expect(tierForTask("verify")).toBe("medium");
    expect(tierForTask("conflict")).toBe("medium");
  });

  it("OpenAI 推理系列映射 reasoning_effort", () => {
    expect(reasoningParams("o3-mini", "low")).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams("gpt-5", "medium")).toEqual({ reasoning_effort: "medium" });
  });

  it("Qwen 映射 enable_thinking（low 关闭省 token）", () => {
    expect(reasoningParams("qwen-max", "low")).toEqual({ enable_thinking: false });
    expect(reasoningParams("qwen-plus", "medium")).toEqual({ enable_thinking: true });
  });

  it("DeepSeek/非思考模型不下发非法参数（零开销/模型选择决定）", () => {
    expect(reasoningParams("deepseek-chat", "low")).toEqual({});
    expect(reasoningParams("deepseek-v4-flash", "medium")).toEqual({});
    expect(reasoningParams("gpt-4o", "low")).toEqual({});
    expect(reasoningParams(undefined, "low")).toEqual({});
  });

  it("thinking 预算上限递增", () => {
    expect(THINKING_BUDGET.low).toBeLessThan(THINKING_BUDGET.medium);
    expect(THINKING_BUDGET.medium).toBeLessThan(THINKING_BUDGET.high);
  });
});