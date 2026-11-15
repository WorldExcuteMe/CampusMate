import { describe, expect, it } from "vitest";
import {
  trimToBudget, compactionThreshold, retainTokens, messagesTokens, HEADROOM_TOKENS,
} from "../agent/context";
import type { ChatMessage } from "../llm/proxy";

describe("DSH kernel: 压缩阈值公式", () => {
  it("threshold=min(窗口*0.8, 窗口-预留-headroom)；retain=16%", () => {
    const cap = 200000, reserve = 8000;
    expect(compactionThreshold(cap, reserve)).toBe(Math.floor(Math.min(cap * 0.8, cap - reserve - HEADROOM_TOKENS)));
    expect(retainTokens(cap, reserve)).toBe(Math.floor((cap - reserve) * 0.16));
    expect(retainTokens(cap, reserve)).toBeLessThan(compactionThreshold(cap, reserve));
  });
});

describe("DSH kernel: spill/prune/compaction 三层分离", () => {
  it("旧工具结果 spill(head+tail+省略量+取回提示)，最新保留完整；不标历史压缩", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "tool", content: "A".repeat(30000), tool_call_id: "t1" },
      { role: "user", content: "q" },
      { role: "tool", content: "B".repeat(30000), tool_call_id: "t2" },
      { role: "user", content: "new" },
    ];
    const r = trimToBudget(msgs, 200000, 0);
    expect(r.pruned).toBe(true);
    expect(r.compressed).toBe(false);
    const old = r.messages[1];
    expect(old.content).toContain("省略");
    expect(old.content).toContain("rag_search");
    expect((old.content ?? "").length).toBeLessThan(30000);
    expect(r.messages[3].content).toBe("B".repeat(30000));
  });

  it("超阈值且超预算才历史压缩，占用有界", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 400 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `轮${i} ` + "内容".repeat(300),
      } as ChatMessage)),
      { role: "user", content: "new" },
    ];
    const r = trimToBudget(msgs, 200000, 0);
    expect(r.compressed).toBe(true);
    expect(messagesTokens(r.messages)).toBeLessThanOrEqual(200000);
    expect(r.messages[r.messages.length - 1].content).toBe("new");
  });
});