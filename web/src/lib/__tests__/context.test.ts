import { describe, expect, it } from "vitest";
import {
  estimateTokens, messagesTokens, modelMaxContext, resolveContextCap,
  composeContext, trimToBudget, WORKING_CAP,
} from "../agent/context";
import type { ChatMessage } from "../llm/proxy";

describe("context: 模型感知上限", () => {
  it("DeepSeek V4 官方 1M，工作上限 200K 可行", () => {
    expect(modelMaxContext("deepseek-v4-flash")).toBe(1_000_000);
    expect(resolveContextCap("deepseek-v4-flash")).toBe(WORKING_CAP);
    expect(resolveContextCap("deepseek-chat")).toBe(200_000);
  });
  it("小上下文模型不被抬到 200K", () => {
    expect(resolveContextCap("gpt-4o")).toBe(128_000);
    expect(resolveContextCap("some-unknown-model")).toBe(128_000);
    expect(resolveContextCap("gpt-4o", 300_000)).toBe(128_000);
  });
  it("override 不超过模型上限", () => {
    expect(resolveContextCap("deepseek-chat", 500_000)).toBe(500_000);
    expect(resolveContextCap("claude-3", 500_000)).toBe(200_000);
  });
});

describe("context: token 估算", () => {
  it("CJK 约 1/字，ASCII 约 4 字符/token", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdabcd")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("context: 组装与压缩", () => {
  const history: ChatMessage[] = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `第${i}轮通知内容：竞赛报名截止 2026-12-01，` + "详情".repeat(200),
  }));

  it("超预算裁剪旧轮次并生成预算内历史摘要，占用不超 cap", () => {
    const c = composeContext({ system: "sys", history, user: "hi", cap: 20000 });
    expect(c.compressed).toBe(true);
    expect(c.droppedTurns).toBeGreaterThan(0);
    expect(c.usedTokens).toBeLessThanOrEqual(20000);
    expect(c.messages.some((m) => m.content.includes("历史摘要"))).toBe(true);
    expect(c.messages[c.messages.length - 1].content).toBe("hi");
  });

  it("极小 cap 也不超窗（摘要按预算省略）", () => {
    const c = composeContext({ system: "sys", history, user: "hi", cap: 3000 });
    expect(c.usedTokens).toBeLessThanOrEqual(3000);
    expect(c.compressed).toBe(true);
  });

  it("大 cap 保留全部历史，不压缩", () => {
    const c = composeContext({ system: "sys", history, user: "hi", cap: 200_000 });
    expect(c.compressed).toBe(false);
    expect(c.droppedTurns).toBe(0);
    expect(c.messages.length).toBe(history.length + 2);
  });

  it("工具结果截断 + 超预算丢弃最旧轮次", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "a" },
      { role: "tool", content: "x".repeat(20000), tool_call_id: "t1" },
      { role: "user", content: "new" },
    ];
    const r = trimToBudget(msgs, 3000, 0);
    expect(r.compressed).toBe(true);
    expect(messagesTokens(r.messages)).toBeLessThanOrEqual(3000);
    const tool = r.messages.find((m) => m.role === "tool");
    if (tool) expect((tool.content ?? "").length).toBeLessThan(20000);
    expect(r.messages[r.messages.length - 1].content).toBe("new");
  });
});