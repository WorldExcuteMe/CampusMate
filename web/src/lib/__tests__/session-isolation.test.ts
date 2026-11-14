import { beforeEach, describe, expect, it } from "vitest";
import { loadSessions, saveSessions, newSession } from "../agent/sessions";
import { setPlan, getPlan, appendMemory, getMemory, memoryPrompt } from "../agent/memory";
beforeEach(() => localStorage.clear());
describe("account/session storage isolation", () => {
  it("does not expose account A chats to B or Demo", () => {
    const a = newSession(); a.messages.push({ role: "user", content: "private A" });
    saveSessions([a], "user-a");
    expect(loadSessions("user-a")[0].messages[0].content).toBe("private A");
    expect(loadSessions("user-b")).toEqual([]);
    expect(loadSessions("demo")).toEqual([]);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("keeps unidentified legacy chats in Demo only", () => {
    localStorage.setItem("campusmate.sessions.v1", JSON.stringify([newSession()]));
    expect(loadSessions("demo")).toHaveLength(1);
    expect(loadSessions("user-a")).toEqual([]);
  });
  it("isolates plans and memory by principal AND chat", () => {
    const plan = { goal: "private", steps: ["one"], done: [], createdAt: "now" };
    setPlan(plan, "user-a/chat-1"); appendMemory("private memory", "user-a/chat-1");
    expect(getPlan("user-a/chat-1")).toEqual(plan);
    expect(getMemory("user-a/chat-1")).toEqual(["private memory"]);
    for (const scope of ["user-a/chat-2", "user-b/chat-1", "demo-user"]) {
      expect(memoryPrompt(scope)).toBe("");
    }
  });
});
