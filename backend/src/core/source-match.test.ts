import { test } from "node:test";
import assert from "node:assert/strict";
import { informationTopic, matchesTopic, normalizeInformationRequest } from "./source-match.ts";
test("a broad yearly contest discovery does not invent an event named 年大学生计算机竞赛", () => {
  assert.equal(informationTopic("搜索 2026 年大学生计算机竞赛，给出 3 个带官网链接的，并标明来源；不要编造。"), undefined);
  assert.equal(informationTopic("中国大学生计算机设计大赛 2026 官网"), "中国大学生计算机设计大赛");
});

test("named competitions require the distinctive subject, not a generic university prefix", () => {
  const topic = informationTopic("收集全国大学生物联网设计竞赛的信息");
  assert.equal(topic, "全国大学生物联网设计竞赛");
  assert.equal(matchesTopic(topic, "国家大学生就业服务平台 全国大学生就业创业服务"), false);
  assert.equal(matchesTopic(topic, "全国大学生物联网创新设计竞赛"), false);
  assert.equal(matchesTopic(topic, "2026年全国大学生物联网设计竞赛参赛通知"), true);
  assert.equal(matchesTopic(topic, "物联网设计竞赛组委会发布参赛安排"), true);
  assert.equal(matchesTopic(informationTopic("蓝桥杯竞赛 2026 官网"), "蓝桥杯竞赛报名"), true);
});
test("continuation wrapper does not change the information subject", () => {
  const text = "请基于已有记录继续：收集全国大学生物联网设计竞赛的信息";
  assert.equal(normalizeInformationRequest(text), "收集全国大学生物联网设计竞赛的信息");
  assert.equal(informationTopic(text), "全国大学生物联网设计竞赛");
});

test("real recommendation queries preserve short contest names and English entities", () => {
  assert.equal(informationTopic("收集竞赛的信息"), undefined);
  for (const [query, topic] of [["2026 蓝桥杯 报名时间 官网", "蓝桥杯"], ["2026 天梯赛 报名时间 官网", "天梯赛"], ["2026 Kaggle 竞赛 报名", "Kaggle"]]) {
    assert.equal(informationTopic(query), topic);
    assert.equal(matchesTopic(topic, "2026普通高考报名时间和录取信息"), false);
    assert.equal(matchesTopic(topic, `${topic} 官方报名规则`), true);
  }
});
