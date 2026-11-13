import { describe, expect, it } from "vitest";
import { ruleExtract } from "../llm/mock";

const contest = `关于举办2026年全国大学生人工智能创新大赛的通知
主办单位：教务处
参赛条件：全日制在校本科生，组队不超过3人
报名截止：2026年11月25日
所需材料：项目计划书、团队成员信息`;

describe("ruleExtract", () => {
  it("提取标题、类别与截止日期", () => {
    const r = ruleExtract(contest, null);
    expect(r.title).toContain("人工智能创新大赛");
    expect(r.category).toBe("competition");
    expect(r.deadline).toBe("2026-11-25");
    expect(r.org).toContain("教务处");
    expect(r.materials.length).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("识别 ISO 日期", () => {
    const r = ruleExtract("报名截止：2026-12-01，欢迎参加实习招聘", null);
    expect(r.deadline).toBe("2026-12-01");
    expect(r.category).toBe("internship");
  });

  it("无日期时 deadline 为 null", () => {
    const r = ruleExtract("校园开源技术沙龙，欢迎参加", null);
    expect(r.deadline).toBeNull();
  });

  it("识别风险收费信号", () => {
    const r = ruleExtract("兼职打字员，先交押金200元，高额回报", null);
    expect(r.cost).toContain("需核验");
  });
});