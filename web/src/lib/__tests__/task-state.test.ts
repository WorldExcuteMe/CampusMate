import { expect, it } from "vitest";
import { mergeTask, mergeEvent, taskReply } from "../agent/task-state";
import { newSession } from "../agent/sessions";
import type { AgentTask } from "../agent/api-client";
import type { ChatSession } from "../agent/sessions";
it("任务恢复只替换本轮回复，按turn插入且累计用量不重复", () => {
  const a: AgentTask = { id: "a", userId: "u", title: "A", turnId: "turn-a", status: "paused", usage: { tokens: 10, toolCalls: 0, wallMs: 0, costUsd: 0 }, result: { summary: "草稿", artifactIds: [], partial: true, completion: { state: "partial", reason: "output_incomplete" } } };
  let s: ChatSession = { ...newSession(), messages: [{ role: "user" as const, content: "A", turnId: "turn-a" }, { role: "user" as const, content: "B", turnId: "turn-b" }] };
  s = mergeTask(s, a);
  s = mergeTask(s, a);
  expect(s.tokens).toBe(10); expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  s = mergeTask(s, { ...a, status: "succeeded", usage: { ...a.usage, tokens: 18 }, result: { summary: "完整结果", artifactIds: [] } });
  expect(s.tokens).toBe(18); expect(s.messages[1].content).toBe("完整结果"); expect(s.messages).toHaveLength(3);
  s = mergeEvent(s, { id: 1, taskId: "a", seq: 1, type: "tool.called", payload: {}, createdAt: 1 });
  expect(mergeEvent(s, { id: 1, taskId: "a", seq: 1, type: "tool.called", payload: {}, createdAt: 1 })).toBe(s);
  expect(taskReply({ ...a, result: undefined, status: "needs_input" }, [])).toMatch(/等待处理/);
});
