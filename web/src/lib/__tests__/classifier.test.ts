import { describe, expect, it } from "vitest";
import { ruleExtract } from "../llm/mock";
import { classify } from "../agent/classifier";

describe("classify", () => {
  it("风险信号优先判为 risk", () => {
    const text = "兼职刷单，先交保证金，稳赚高额回报";
    const c = classify(ruleExtract(text, null), text);
    expect(c.class).toBe("risk");
    expect(c.riskSignals.length).toBeGreaterThan(0);
  });

  it("高价值竞赛类别", () => {
    const text = "全国大学生程序设计竞赛报名，截止2026年12月30日";
    const c = classify(ruleExtract(text, null), text);
    expect(["high_value", "must_act"]).toContain(c.class);
    expect(c.priorityScore).toBeGreaterThan(40);
  });

  it("普通通知无截止归为 normal", () => {
    const text = "图书馆开放时间调整告知";
    const c = classify(ruleExtract(text, null), text);
    expect(c.class).toBe("normal");
  });
});