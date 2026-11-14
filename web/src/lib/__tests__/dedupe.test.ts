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

function permutations<T>(items: T[]): T[][] {
  if (!items.length) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]));
}

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
  it.each(permutations([FORMAL, MINI, PROMO]).map((titles, index) => ({ index, titles })))("桥接通知的全部顺序 $index 都归成一组", ({ titles }) => {
    expect(noticeSimilarity({ title: FORMAL }, { title: PROMO })).toBeLessThan(0.6);
    const clusters = clusterNotices(titles.map((title) => ({ title })));
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });
  it("同标题/共用链接也不能覆盖截止或轮次冲突", () => {
    const sourceUrl = "https://example.org/notices";
    expect(noticeSimilarity(
      { title: "奖学金申报", deadline: "2026-03-31", sourceUrl },
      { title: "奖学金申报", deadline: "2026-11-30", sourceUrl },
    )).toBeLessThan(0.6);
    expect(noticeSimilarity({ title: SCH_MAR, sourceUrl }, { title: SCH_SEP, sourceUrl })).toBeLessThan(0.6);
  });
  it("无日期桥接不能串联两个已知不同截止，全部排列分组一致", () => {
    const entries = [
      { title: "奖学金申报", deadline: "2026-03-31", id: "march" },
      { title: "奖学金申报", deadline: null, id: "unknown" },
      { title: "奖学金申报", deadline: "2026-11-30", id: "november" },
    ];
    const partitions = permutations(entries).map((order) => {
      const clusters = clusterNotices(order);
      expect(clusters).toHaveLength(2);
      for (const cluster of clusters) {
        expect(new Set(cluster.map((entry) => entry.deadline).filter(Boolean)).size).toBeLessThanOrEqual(1);
      }
      return clusters.map((cluster) => cluster.map((entry) => entry.id).sort().join(",")).sort().join("|");
    });
    expect(new Set(partitions).size).toBe(1);
  });
  it("空标题不误匹配，输入顺序和对象不被修改，调用方阈值仍生效", () => {
    expect(noticeSimilarity({ title: "" }, { title: "奖学金申报" })).toBe(0);
    const input = [{ title: PROMO }, { title: MINI }, { title: FORMAL }];
    const before = JSON.stringify(input);
    expect(clusterNotices(input, 1)).toHaveLength(3);
    expect(JSON.stringify(input)).toBe(before);
    expect(clusterNotices([])).toEqual([]);
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

  it("不同毫秒时间戳导致的倒序也能完整合并，重跑不再写入", async () => {
    const repo = new DemoRepository();
    // listInbox sorts newest first: FORMAL, PROMO, MINI. The bridge arrives last.
    const entries = [item(MINI), item(PROMO), item(FORMAL), item(ZHIgui)];
    for (const [index, entry] of entries.entries()) {
      entry.createdAt = `2026-11-14T10:00:00.00${index}Z`;
      await repo.createInbox(entry);
    }
    expect(await mergeInbox(repo)).toEqual({ merged: 2, clusters: 1 });
    const after = await repo.listInbox();
    const ids = new Set(entries.map((entry) => entry.id));
    const ours = after.filter((entry) => ids.has(entry.id));
    expect(ours.filter((entry) => entry.status === "archived")).toHaveLength(2);
    expect(ours.find((entry) => entry.id === entries[3].id)?.status).toBe("pending_review");
    expect(ours.find((entry) => entry.id === entries[2].id)?.mergedFrom).toHaveLength(2);
    const snapshot = JSON.stringify(after);
    expect(await mergeInbox(repo)).toEqual({ merged: 0, clusters: 0 });
    expect(JSON.stringify(await repo.listInbox())).toBe(snapshot);
  });
  it("24 种入库顺序都合并两条、保留同一规范条及其他通知", async () => {
    const entries = [item(FORMAL), item(MINI), item(PROMO), item(ZHIgui)];
    for (const order of permutations(entries)) {
      resetDemo();
      const repo = new DemoRepository();
      const original = await repo.listInbox();
      for (const [index, entry] of order.entries()) {
        await repo.createInbox({ ...entry, createdAt: `2026-11-14T10:00:00.00${index}Z` });
      }
      expect(await mergeInbox(repo)).toEqual({ merged: 2, clusters: 1 });
      const after = await repo.listInbox();
      const canon = after.find((entry) => entry.id === entries[0].id)!;
      expect(canon.status).toBe("pending_review");
      expect(canon.rawText).toBe(FORMAL);
      expect(canon.mergedFrom?.slice().sort()).toEqual([entries[1].id, entries[2].id].sort());
      expect(after.find((entry) => entry.id === entries[3].id)?.status).toBe("pending_review");
      for (const entry of original) expect(after.find((stored) => stored.id === entry.id)).toEqual(entry);
    }
  });
});
