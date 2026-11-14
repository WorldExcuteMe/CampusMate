import { describe, expect, it, beforeEach } from "vitest";
import { DemoRepository, resetDemo } from "../data/demo";
import { mergeInbox, clusterNotices, noticeSimilarity } from "../ingest/dedupe";
import { ruleExtract } from "../llm/mock";
import { uid, type InboxItem } from "../data/types";

// 用户真实群通知语料（群881289395）调校：完全重复/同事件变体合并，跨轮次/跨事件保留。
const FORMAL = "关于举办计算机科学与技术学院（大数据学院）2026年模拟面试大赛院级选拔赛的通知(1)";
const MINI = "[QQ小程序]模拟面试大赛";
const PROMO = "模拟面试大赛获奖率很高，可以加综测、积累面试经验等等，大家积极报名参加";
const ZHIgui = "关于举办第四届全国大学生职业规划大赛校内选拔赛的通知";
const SCH_MAR = "关于做好2026年3月单项奖学金申报工作的通知";
const SCH_SEP = "关于做好2026年9-11月本科生单项奖学金申报工作的通知";

describe("dedupe: 语义相似度（语料调校）", () => {
  it("完全重复=1", () => {
    expect(noticeSimilarity({ title: ZHIgui }, { title: ZHIgui })).toBe(1);
  });
  it("同事件变体（正式/小程序/宣传）>=阈值", () => {
    expect(noticeSimilarity({ title: FORMAL }, { title: MINI })).toBeGreaterThanOrEqual(0.6);
    expect(noticeSimilarity({ title: MINI }, { title: PROMO })).toBeGreaterThanOrEqual(0.6);
  });
  it("跨轮次（3月 vs 9-11月）不合并", () => {
    expect(noticeSimilarity({ title: SCH_MAR }, { title: SCH_SEP })).toBeLessThan(0.6);
  });
  it("跨事件（模拟面试 vs 职业规划）不合并", () => {
    expect(noticeSimilarity({ title: FORMAL }, { title: ZHIgui })).toBeLessThan(0.6);
  });
  it("聚类：模拟面试三变体归一，奖学金两轮次分开", () => {
    const clusters = clusterNotices([
      { title: FORMAL }, { title: MINI }, { title: PROMO },
      { title: ZHIgui }, { title: ZHIgui },
      { title: SCH_MAR }, { title: SCH_SEP },
    ]);
    const mian = clusters.find((c) => c.some((x) => x.title === FORMAL));
    expect(mian?.length).toBe(3);
    const sch = clusters.filter((c) => c.some((x) => x.title === SCH_MAR || x.title === SCH_SEP));
    expect(sch.length).toBe(2);
  });
});

describe("dedupe: mergeInbox 合并历史通知", () => {
  beforeEach(() => resetDemo());

  function item(title: string): InboxItem {
    const extracted = ruleExtract(title, null);
    return {
      id: uid(), userId: "demo-user", rawText: title, sourceUrl: null, sourceType: "text",
      extracted, classification: { class: "normal", priorityScore: 50, priorityReason: "t", riskSignals: [] },
      status: "pending_review", createdAt: new Date().toISOString(), demo: true,
    };
  }

  it("同源同事件归一：规范条富化、重复条归档", async () => {
    const repo = new DemoRepository();
    const a = item(FORMAL);
    const b = item(MINI);
    const c = item(PROMO);
    const d = item(ZHIgui);
    for (const it of [a, b, c, d]) await repo.createInbox(it);
    const mg = await mergeInbox(repo);
    expect(mg.merged).toBe(2);
    expect(mg.clusters).toBe(1);
    const inbox = await repo.listInbox();
    const archived = inbox.filter((i) => i.status === "archived");
    expect(archived.length).toBe(2);
    const canon = inbox.find((i) => (i.mergedFrom ?? []).length === 2);
    expect(canon).toBeTruthy();
    expect(canon?.extracted.summary).toContain("已合并");
  });
});