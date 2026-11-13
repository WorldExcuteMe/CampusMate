import { expect, test } from "@playwright/test";

const EVIDENCE = "C:/Users/Asus/CodeBuddy/campusmate-evidence";

const NOTICE = `关于举办2026年校园程序设计大赛的通知
主办单位：教务处
报名截止：2026年11月25日
所需材料：报名表`;

test("第一条业务闭环：导入→提取→确认→待办→Dashboard→刷新仍在", async ({ page }) => {
  await page.goto("/app/inbox/new");
  await page.screenshot({ path: `${EVIDENCE}/03-inbox-new.png`, fullPage: true });

  await page.getByPlaceholder("粘贴校园通知文本…").fill(NOTICE);
  await page.getByRole("button", { name: "AI 提取" }).click();

  // 结构化结果出现，标题已被提取
  await expect(page.getByText("2. 审核结构化结果")).toBeVisible();
  await expect(page.locator("#notice-title")).toHaveValue(/程序设计大赛/);
  await expect(page.getByText("MOCK · 规则提取")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/04-extracted-review.png`, fullPage: true });

  // 保存并生成待办 → 跳转 Dashboard
  await page.getByRole("button", { name: "保存并生成待办" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText(/处理：.*程序设计大赛/)).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/05-dashboard-with-task.png`, fullPage: true });

  // 刷新后数据仍在（localStorage 持久化）
  await page.reload();
  await expect(page.getByText(/处理：.*程序设计大赛/)).toBeVisible();
});

test("URL 抓取防护与风险分类可见", async ({ page }) => {
  await page.goto("/app/inbox/new");
  await page.getByPlaceholder("粘贴校园通知文本…").fill("兼职刷单，先交保证金200元，稳赚高额回报");
  await page.getByRole("button", { name: "AI 提取" }).click();
  await expect(page.getByText("风险警告")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/06-risk-classified.png`, fullPage: true });
});

test("机会雷达与核验报告可浏览", async ({ page }) => {
  await page.goto("/app/radar");
  await expect(page.getByText("Opportunity Radar")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/07-radar.png`, fullPage: true });
  await page.goto("/app/trust");
  await expect(page.getByText("Trust Engine")).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/08-trust.png`, fullPage: true });
});

test("日常任务专区：群通知清洗+时间提取+导入", async ({ page }) => {
  await page.goto("/app/daily");
  await page.getByPlaceholder(/粘贴转发的群消息/).fill("@全体 周五19:00在教三101开班会，收到回复");
  await expect(page.getByText(/识别时间/)).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/09-daily-import.png`, fullPage: true });
  await page.getByRole("button", { name: "导入为日常任务" }).click();
  await expect(page.getByText(/开班会/)).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/10-daily-list.png`, fullPage: true });
});

test("会话页与供应商设置页可达", async ({ page }) => {
  await page.goto("/app/agent");
  await expect(page.getByPlaceholder(/输入消息/)).toBeVisible();
  await expect(page.getByText("上下文", { exact: false })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/11-agent-chat.png`, fullPage: true });
  await page.goto("/app/settings");
  await expect(page.getByText("模型供应商", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/12-provider-settings.png`, fullPage: true });
});