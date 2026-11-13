import { ruleExtract } from "../lib/llm/mock";
import { classify } from "../lib/agent/classifier";
import type {
  InboxItem,
  Opportunity,
  Profile,
  Task,
  VerificationReport,
} from "../lib/data/types";

export const DEMO_USER = "demo-user";

export const demoProfile: Profile = {
  id: DEMO_USER,
  name: "林晓（虚拟档案）",
  major: "计算机科学与技术",
  grade: "大二",
  interests: ["人工智能", "开源", "机器人"],
  skills: ["Python", "TypeScript", "机器学习基础"],
  goals: ["参加一次学科竞赛", "获得一段实习经历"],
  timeBudgetHours: 10,
  bio: "用于演示的虚拟大学生档案，非真实个人数据。",
};

const NOTICE_TEXTS = [
  `关于举办2026年全国大学生人工智能创新大赛的通知
主办单位：教务处
参赛条件：全日制在校本科生，组队不超过3人
报名截止：2026年11月25日
所需材料：项目计划书、团队成员信息
地点：线上初赛，决赛在校本部
请各学院积极组织学生报名参赛。`,
  `计算机学院关于招募科研助理的通知
发布单位：计算机学院
要求：大二及以上，熟悉Python，每周投入不少于8小时
报名截止：2026年11月20日
课题方向：自然语言处理与知识图谱
联系：计算机学院实验室办公室`,
  `关于2026年秋季奖学金评选的通知
发布单位：学生工作办公室
评选条件：综测排名前30%，无违纪记录
提交截止：2026年11月18日
所需材料：成绩单、获奖证明、申请表`,
  `校园开源技术沙龙活动报名
主办：开源协会
活动：开源项目贡献入门讲座
时间：2026年11月16日 19:00
地点：图书馆报告厅
报名截止：2026年11月15日`,
  `关于提交实习实践报告的通知
发布单位：教务处
要求：已完成暑期实习的同学提交实践报告
提交截止：2026年11月30日
材料：实习证明、实践报告`,
];

function makeInbox(text: string, i: number): InboxItem {
  const extracted = ruleExtract(text, null);
  const classification = classify(extracted, text);
  return {
    id: `demo-inbox-${i}`,
    userId: DEMO_USER,
    rawText: text,
    sourceUrl: null,
    sourceType: "text",
    extracted,
    classification,
    status: "confirmed",
    createdAt: new Date(Date.now() - i * 3_600_000).toISOString(),
    demo: true,
  };
}

export const demoInbox: InboxItem[] = NOTICE_TEXTS.map(makeInbox);

export const demoOpportunities: Opportunity[] = [
  {
    id: "demo-opp-c1",
    title: "全国大学生人工智能创新大赛",
    type: "competition",
    organizer: "教务处",
    description: "面向在校本科生的 AI 创新竞赛，组队参赛，含初赛与决赛。",
    conditions: ["全日制在校本科生", "组队不超过3人"],
    deadline: "2026-11-25",
    sourceUrl: "https://example.edu.cn/notice/ai-contest-2026",
    sourceType: "official",
    collectedAt: new Date().toISOString(),
    status: "active",
    demo: true,
  },
  {
    id: "demo-opp-c2",
    title: "中国大学生程序设计竞赛（CCPC）",
    type: "competition",
    organizer: "CCPC 组委会",
    description: "算法程序设计竞赛，分校赛与区域赛。",
    conditions: ["在校大学生", "3人组队"],
    deadline: "2026-12-05",
    sourceUrl: "https://example.edu.cn/notice/ccpc-2026",
    sourceType: "official",
    collectedAt: new Date().toISOString(),
    status: "active",
    demo: true,
  },
  {
    id: "demo-opp-c3",
    title: "全国大学生机器人锦标赛",
    type: "competition",
    organizer: "机器人学会",
    description: "机器人设计与竞技比赛，含多个赛道。",
    conditions: ["在校大学生", "可跨校组队"],
    deadline: "2026-12-10",
    sourceUrl: "https://example.org/robotics-2026",
    sourceType: "official",
    collectedAt: new Date().toISOString(),
    status: "active",
    demo: true,
  },
  {
    id: "demo-opp-i1",
    title: "某科技公司后端开发实习生",
    type: "internship",
    organizer: "某科技公司",
    description: "后端开发实习，参与 API 与数据服务开发。",
    conditions: ["本科及以上", "熟悉一门后端语言", "每周4天"],
    deadline: "2026-11-28",
    sourceUrl: "https://example.com/careers/backend-intern",
    sourceType: "company",
    collectedAt: new Date().toISOString(),
    status: "active",
    demo: true,
  },
  {
    id: "demo-opp-i2",
    title: "某研究院算法实习生",
    type: "internship",
    organizer: "某研究院",
    description: "机器学习算法实习，参与模型实验。",
    conditions: ["熟悉Python", "有ML基础"],
    deadline: "2026-12-01",
    sourceUrl: "https://example.org/careers/ml-intern",
    sourceType: "company",
    collectedAt: new Date().toISOString(),
    status: "active",
    demo: true,
  },
  {
    id: "demo-opp-r1",
    title: "计算机学院 NLP 课题组科研助理",
    type: "research",
    organizer: "计算机学院",
    description: "自然语言处理与知识图谱方向科研助理。",
    conditions: ["大二及以上", "熟悉Python", "每周≥8小时"],
    deadline: "2026-11-20",
    sourceUrl: "https://example.edu.cn/lab/nlp-ra",
    sourceType: "official",
    collectedAt: new Date().toISOString(),
    status: "active",
    demo: true,
  },
];

export const demoTasks: Task[] = [
  {
    id: "demo-task-1",
    userId: DEMO_USER,
    title: "准备 AI 大赛项目计划书",
    dueAt: "2026-11-22",
    status: "in_progress",
    priority: 80,
    inboxItemId: "demo-inbox-0",
    estimateHours: 6,
    kind: "opportunity",
    createdAt: new Date().toISOString(),
    demo: true,
  },
  {
    id: "demo-task-2",
    userId: DEMO_USER,
    title: "提交奖学金申请材料",
    dueAt: "2026-11-18",
    status: "todo",
    priority: 90,
    inboxItemId: "demo-inbox-2",
    estimateHours: 2,
    kind: "general",
    createdAt: new Date().toISOString(),
    demo: true,
  },
  {
    id: "demo-task-3",
    userId: DEMO_USER,
    title: "报名开源技术沙龙",
    dueAt: "2026-11-15",
    status: "todo",
    priority: 55,
    inboxItemId: "demo-inbox-3",
    estimateHours: 1,
    kind: "general",
    createdAt: new Date().toISOString(),
    demo: true,
  },
  {
    id: "demo-task-d1",
    userId: DEMO_USER,
    title: "参加班会（辅导员通知）",
    dueAt: "2026-11-14",
    status: "todo",
    priority: 70,
    inboxItemId: null,
    estimateHours: 1,
    kind: "daily",
    timeText: "周五 19:00",
    createdAt: new Date().toISOString(),
    demo: true,
  },
  {
    id: "demo-task-d2",
    userId: DEMO_USER,
    title: "高数调课：改到周三 3-4 节",
    dueAt: "2026-11-18",
    status: "todo",
    priority: 65,
    inboxItemId: null,
    estimateHours: 2,
    kind: "daily",
    timeText: "周三 10:00",
    createdAt: new Date().toISOString(),
    demo: true,
  },
];

export const demoReports: VerificationReport[] = [
  {
    id: "demo-report-1",
    opportunityId: "demo-opp-i1",
    status: "PARTIALLY_VERIFIED",
    summary:
      "招聘主体与官网域名一致，岗位信息可在官方招聘页核对；实习补贴细节未在官方页面明确，标记为待补充。演示数据，来源为示例域名。",
    findings: [
      { item: "主办方身份", result: "pass", note: "公司官网可查" },
      { item: "官方来源", result: "pass", note: "来源为公司招聘官网" },
      { item: "域名", result: "pass", note: "example.com 与主体一致（示例）" },
      { item: "收费要求", result: "pass", note: "未发现收费要求" },
      { item: "报名要求", result: "warn", note: "补贴细节未明确" },
    ],
    evidence: [
      {
        sourceUrl: "https://example.com/careers/backend-intern",
        sourceType: "company",
        excerpt: "后端开发实习生，负责 API 与数据服务开发……",
        retrievedAt: new Date().toISOString(),
        supports: "岗位真实存在",
        confidence: 0.7,
      },
    ],
    createdAt: new Date().toISOString(),
  },
];