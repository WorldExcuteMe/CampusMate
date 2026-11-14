import { expect, test } from "@playwright/test";

// Every test owns its output directory; portable across teammates and CI.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/providers", (route) => route.fulfill({
    json: { providers: [], mutable: false },
  }));
});

const NOTICE = `关于举办2026年校园程序设计大赛的通知
主办单位：教务处
报名截止：2026年11月25日
所需材料：报名表`;

test("第一条业务闭环：导入→提取→确认→待办→Dashboard→刷新仍在", async ({ page }) => {
  await page.goto("/app/inbox/new");
  await page.screenshot({ path: test.info().outputPath("03-inbox-new.png"), fullPage: true });

  await page.getByPlaceholder("粘贴校园通知文本…").fill(NOTICE);
  await page.getByRole("button", { name: "AI 提取" }).click();

  // 结构化结果出现，标题已被提取
  await expect(page.getByText("2. 审核结构化结果")).toBeVisible();
  await expect(page.locator("#notice-title")).toHaveValue(/程序设计大赛/);
  await expect(page.getByText("MOCK · 规则提取")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("04-extracted-review.png"), fullPage: true });

  // 保存并生成待办 → 跳转 Dashboard
  await page.getByRole("button", { name: "保存并生成待办" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText(/处理：.*程序设计大赛/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("05-dashboard-with-task.png"), fullPage: true });

  // 刷新后数据仍在（localStorage 持久化）
  await page.reload();
  await expect(page.getByText(/处理：.*程序设计大赛/)).toBeVisible();
});

test("URL 抓取防护与风险分类可见", async ({ page }) => {
  await page.goto("/app/inbox/new");
  await page.getByPlaceholder("粘贴校园通知文本…").fill("兼职刷单，先交保证金200元，稳赚高额回报");
  await page.getByRole("button", { name: "AI 提取" }).click();
  await expect(page.getByText("风险警告")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("06-risk-classified.png"), fullPage: true });
});

test("机会雷达与核验报告可浏览", async ({ page }) => {
  await page.goto("/app/radar");
  await expect(page.getByText("Opportunity Radar")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("07-radar.png"), fullPage: true });
  await page.goto("/app/trust");
  await expect(page.getByText("Trust Engine")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("08-trust.png"), fullPage: true });
});

test("日常任务专区：群通知清洗+时间提取+导入", async ({ page }) => {
  await page.goto("/app/daily");
  await page.getByPlaceholder(/粘贴转发的群消息/).fill("@全体 周五19:00在教三101开班会，收到回复");
  await expect(page.getByText(/识别时间/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("09-daily-import.png"), fullPage: true });
  await page.getByRole("button", { name: "导入为日常任务" }).click();
  await expect(page.getByText(/开班会/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("10-daily-list.png"), fullPage: true });
});

test("日常任务可完成与撤销完成，刷新后状态持久化", async ({ page }) => {
  await page.goto("/app/daily");
  const checkbox = page.getByRole("checkbox", { name: /参加班会/ });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await page.reload();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  await page.reload();
  await expect(checkbox).not.toBeChecked();
  await page.goto("/app");
  await expect(page.getByText("参加班会（辅导员通知）", { exact: true })).toBeVisible();
});

test("会话页与供应商设置页可达", async ({ page }) => {
  await page.goto("/app/agent");
  await expect(page.getByPlaceholder(/输入消息/)).toBeVisible();
  await expect(page.getByText("上下文", { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("11-agent-chat.png"), fullPage: true });
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "模型供应商", exact: true }).click();
  await expect(page.getByText("供应商管理为只读", { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("12-provider-settings.png"), fullPage: true });
});

test("服务端模型提取：真实来源标记、保存与刷新持久化", async ({ page }) => {
  await page.route("**/api/providers", (route) => route.fulfill({ json: {
    providers: [{ id: "fixture", name: "测试模型", hasKey: true, protocol: "openai", model: "fixture", baseUrl: "https://fixture.invalid" }], mutable: false,
  } }));
  await page.route("**/api/llm", (route) => route.fulfill({ json: {
    choices: [{ message: { content: JSON.stringify({
      title: "模型提取回归通知", category: "competition", org: "测试学校", summary: "测试摘要",
      deadline: "2026-11-25", conditions: [], materials: [], cost: null, location: null,
      sourceUrl: null, evidenceExcerpt: "模型提取回归通知", confidence: 0.9,
    }) } }], model: "fixture-model",
  } }));
  await page.goto("/app/inbox/new");
  await page.getByPlaceholder("粘贴校园通知文本…").fill("模型提取回归通知");
  await page.getByRole("button", { name: "AI 提取" }).click();
  await expect(page.getByText("真实模型提取", { exact: true })).toBeVisible();
  await expect(page.getByText("MOCK · 规则提取", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/inbox\/[0-9a-f-]{36}$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "模型提取回归通知" })).toBeVisible();
  await expect(page.getByText("MOCK · 规则提取", { exact: true })).toHaveCount(0);
});
