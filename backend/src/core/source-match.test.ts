import { test } from "node:test";
import assert from "node:assert/strict";
import { informationTopic, matchesTopic, normalizeInformationRequest } from "./source-match.ts";

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
