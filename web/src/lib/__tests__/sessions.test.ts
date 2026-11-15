import { beforeEach, expect, it } from "vitest";
import { loadSessions, saveSessions, newSession, backendSessionId } from "../agent/sessions";
import { getMemory, appendMemory, getPlan, setPlan } from "../agent/memory";

beforeEach(() => localStorage.clear());
it("旧本地历史仅在Demo可读，真实账号和新ID隔离", () => {
  const old = { ...newSession(), id: "old-local", messages: [{ role: "user", content: "旧身份" }] };
  localStorage.setItem("campusmate.sessions.v1", JSON.stringify([old]));
  expect(loadSessions()[0].id).toBe("old-local");
  expect(loadSessions("alice")).toEqual([]);
  saveSessions([newSession()], "alice");
  expect(loadSessions("alice")).toHaveLength(1);
  expect(loadSessions("bob")).toEqual([]);
  expect(newSession().id).toMatch(/^[a-f0-9-]{36}$/);
  const mapped = backendSessionId("alice", "old-local");
  expect(mapped).toBe(backendSessionId("alice", "old-local"));
  expect(mapped).not.toBe(backendSessionId("bob", "old-local"));
});
it("会话计划和记忆按owner及session隔离，迟到写入仍留在原scope", () => {
  const a = "alice:one", b = "bob:one";
  appendMemory("计算机大二", a);
  setPlan({ goal: "比赛", steps: ["搜索"], done: [], createdAt: "today" }, a);
  expect(getMemory(b)).toEqual([]);
  expect(getPlan(b)).toBeNull();
  expect(getMemory(a)).toEqual(["计算机大二"]);
  expect(getPlan(a)?.goal).toBe("比赛");
});
