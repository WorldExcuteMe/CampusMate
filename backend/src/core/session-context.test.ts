import { test } from "node:test";
import assert from "node:assert/strict";
import { identityContext, committedPrefix } from "./session-context.ts";
import { composeContext } from "./context.ts";

test("压缩时保护带来源的身份及最新纠正，不让未来输入进入摘要", () => {
  const rows = [{ role: "user", content: "我是计算机大二，擅长Python", seq: 1, taskId: "first" }, { role: "user", content: "更正：我现在大三", seq: 4, taskId: "second" }, { role: "user", content: "我是未来信息", seq: 5, taskId: "future" }] as any;
  const tasks = [{ id: "first", turnSeq: 1, transcriptCommitted: true }, { id: "second", turnSeq: 2, transcriptCommitted: true }, { id: "future", turnSeq: 4, transcriptCommitted: false }] as any;
  const current = { id: "current", turnSeq: 3 } as any;
  const facts = identityContext(rows, tasks, current);
  const request = composeContext({ system: facts, history: Array.from({ length: 20 }, () => ({ role: "assistant", content: "长工具总结".repeat(200) })), user: "推荐竞赛", cap: 10000 });
  assert.equal(request.compressed, true);
  assert.match(JSON.stringify(request.messages), /计算机大二/);
  assert.match(JSON.stringify(request.messages), /更正：我现在大三/);
  assert.doesNotMatch(JSON.stringify(request.messages), /未来信息/);
  assert.match(facts, /seq=4/);
  assert.equal(committedPrefix(rows, tasks), 4);
  assert.equal(committedPrefix([{ ...rows[0], seq: 1 }, { ...rows[2], seq: 2 }, { ...rows[1], seq: 3 }], tasks), 1, "不能跨未来user空洞推进摘要");
});
