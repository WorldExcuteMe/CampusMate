import { expect, test } from "@playwright/test";

test("Today 勾选先确认：取消/关闭不改状态，确认后刷新保持完成", async ({ page }) => {
  await page.goto("/app");
  const checkbox = page.getByRole("checkbox", { name: "完成 参加班会（辅导员通知）", exact: true });
  await checkbox.click();
  const dialog = page.getByRole("alertdialog", { name: "确认完成任务？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(checkbox).not.toBeChecked();
  await page.reload();
  await checkbox.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await dialog.getByRole("button", { name: "确认完成", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(checkbox).toHaveCount(0);
  await page.reload();
  await expect(checkbox).toHaveCount(0);
  await page.goto("/app/daily");
  await expect(page.getByRole("checkbox", { name: "撤销完成 参加班会（辅导员通知）", exact: true })).toBeChecked();
});

test("左右独立滚动，品牌和账号固定，切换页面仅重置内容滚动", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 540 });
  await page.addInitScript(() => {
    const sessions = Array.from({ length: 40 }, (_, i) => ({
      id: `scroll-fixture-${i}`, name: `滚动测试会话 ${i + 1}`, mode: "auto", createdAt: new Date().toISOString(), messages: [], tokens: 0,
    }));
    localStorage.setItem("campusmate.sessions.v1.demo", JSON.stringify(sessions));
  });
  await page.goto("/app/agent");
  await expect(page.getByPlaceholder(/输入消息/)).toBeVisible();
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  const main = page.getByRole("main");
  const sidebar = page.getByRole("complementary", { name: "主侧边栏" });
  await nav.getByRole("link", { name: "任务与目标", exact: true }).click();
  await expect(page.getByRole("heading", { name: "日常任务专区" })).toBeVisible();
  await nav.evaluate((el) => { el.scrollTop = 0; });
  await main.hover({ position: { x: 400, y: 30 } });
  await page.mouse.wheel(0, 900);
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await nav.evaluate((el) => el.scrollTop)).toBe(0);
  const rightScroll = await main.evaluate((el) => el.scrollTop);
  await nav.hover({ position: { x: 100, y: 50 } });
  await page.mouse.wheel(0, 700);
  await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await main.evaluate((el) => el.scrollTop)).toBe(rightScroll);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const brand = await sidebar.getByText("CampusMate", { exact: true }).boundingBox();
  const account = await sidebar.getByRole("button", { name: "用户与设置", exact: true }).boundingBox();
  expect(brand!.y).toBeGreaterThanOrEqual(0);
  expect(account!.y + account!.height).toBeLessThanOrEqual(540);
  await page.screenshot({ path: test.info().outputPath("independent-scroll.png"), fullPage: true });
  await nav.getByRole("link", { name: "信息中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Campus Inbox" })).toBeVisible();
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("移动端内容仍可滚动，确认框不超出屏幕", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 550 });
  await page.goto("/app/daily");
  await expect(page.getByRole("heading", { name: "日常任务专区" })).toBeVisible();
  const main = page.getByRole("main");
  await main.hover({ position: { x: 150, y: 20 } });
  await page.mouse.wheel(0, 800);
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole("navigation", { name: "移动导航" }).getByRole("link", { name: "Today", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /参加班会/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("navigation", { name: "移动导航" }).getByRole("link", { name: "智能体工作台", exact: true }).click();
  const input = page.getByPlaceholder(/输入消息/);
  await expect(input).toBeVisible();
  await expect.poll(async () => {
    const box = (await input.boundingBox())!;
    return box.y + box.height;
  }).toBeLessThanOrEqual(550);
});
