import { describe, expect, it, beforeEach } from "vitest";
import { DemoRepository, resetDemo } from "../data/demo";
import { syncGroupRecords, type GroupRecord } from "../ingest/qq";

describe("attachment notice ingestion: PDF/DOCX/图片通知收纳", () => {
  beforeEach(() => resetDemo());

  it("PDF 文件通知按真实文件名收纳为机会+Inbox", async () => {
    const repo = new DemoRepository();
    const rec: GroupRecord = {
      time: "2026-11-11 11:02:26", sender: "s", type: 3,
      text: "关于举办第四届全国大学生职业规划大赛校内选拔赛的通知",
      display: "关于举办第四届全国大学生职业规划大赛校内选拔赛的通知",
      reasons: ["file"],
      attachment: { kind: "file", name: "关于举办第四届全国大学生职业规划大赛校内选拔赛的通知.pdf", source: null },
    };
    const sum = await syncGroupRecords([rec], repo);
    expect(sum.opportunity).toBe(1);
    const opps = await repo.listOpportunities();
    expect(opps.some((o) => o.title.includes("职业规划大赛"))).toBe(true);
  });

  it("图片 OCR 通知文本（讲座+未来日期）收纳为日常任务", async () => {
    const repo = new DemoRepository();
    const rec: GroupRecord = {
      time: "2026-11-11 17:43:57", sender: "s", type: 2,
      text: "备赛交流讲座 培训时间 2027年1月1日 线上直播",
      display: "备赛交流讲座 培训时间 2027年1月1日 线上直播",
      reasons: ["keyword"],
      attachment: { kind: "image", name: "poster.png", source: "image-local" },
    };
    const sum = await syncGroupRecords([rec], repo);
    expect(sum.inbox + sum.daily + sum.opportunity).toBeGreaterThan(0);
  });

  it("图片通知事件已过期（相对消息时间）则过滤", async () => {
    const repo = new DemoRepository();
    const rec: GroupRecord = {
      time: "2026-11-11 17:43:57", sender: "s", type: 2,
      text: "备赛交流讲座 培训时间 本周四晚7点",
      display: "备赛交流讲座 培训时间 本周四晚7点",
      reasons: ["keyword"],
      attachment: { kind: "image", name: "poster.png", source: "image-local" },
    };
    const sum = await syncGroupRecords([rec], repo);
    expect(sum.expired).toBe(1);
    expect(sum.daily).toBe(0);
  });
});