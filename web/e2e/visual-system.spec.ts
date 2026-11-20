import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

// 视觉基线：固定数据 + 固定视口，输出到 test-results/visual/，用于设计系统 before/after 对比。
const OUT = path.join("test-results", "visual");
const ISO = new Date("2026-11-20T08:00:00+08:00").toISOString();
mkdirSync(OUT, { recursive: true });

const task = {
  id: "task-visual", userId: "demo", title: "整理本周群通知并生成待办", status: "succeeded",
  usage: { tokens: 12400, toolCalls: 4, wallMs: 82000, costUsd: 0.0002 },
  promptUsage: { inputTokens: 12400, contextLimit: 200000, outputReserve: 8000, source: "reported" },
  modelRuntime: {
    actualModel: "DeepSeek-V4-Flash",
    lastRequest: { attempts: 1, ttftMs: 1200, totalMs: 8000, reasoning: { requested: "max", effective: "max", reason: "任务内锁定" }, usage: { cacheRead: 11000, inputTotal: 12400, output: 800, reasoning: 320, costUsd: 0.0002 } },
  },
  createdAt: Date.parse(ISO) - 60_000, updatedAt: Date.parse(ISO),
};
const events = [
  { id: 1, taskId: "task-visual", seq: 1, type: "tool.called", payload: { name: "web_search", callInstanceId: "c1" }, createdAt: Date.parse(ISO) - 50_000 },
  { id: 2, taskId: "task-visual", seq: 2, type: "tool.result", payload: { name: "web_search", callInstanceId: "c1", ok: true, durationMs: 1200, summary: "找到 6 条本周通知", sourceUrls: ["https://example.org/notice"] }, createdAt: Date.parse(ISO) - 49_000 },
  { id: 3, taskId: "task-visual", seq: 3, type: "tool.called", payload: { name: "document_create", callInstanceId: "c2" }, createdAt: Date.parse(ISO) - 40_000 },
  { id: 4, taskId: "task-visual", seq: 4, type: "tool.result", payload: { name: "document_create", callInstanceId: "c2", ok: true, durationMs: 900, summary: "已生成 data/待办清单.docx" }, createdAt: Date.parse(ISO) - 39_000 },
  { id: 5, taskId: "task-visual", seq: 5, type: "run.summary", payload: { rounds: 4, toolCalls: 4, tokens: 12400, cacheRead: 11000 }, createdAt: Date.parse(ISO) },
];
const sessions = [
  {
    id: "visual-1", name: "整理本周群通知", mode: "auto", createdAt: ISO, tokens: 12400,
    contextUsed: 12400, contextCap: 200000, promptSource: "reported", actualModel: "DeepSeek-V4-Flash",
    currentTaskId: "task-visual",
    messages: [
      { role: "user", content: "帮我整理这周的群通知，把有截止时间的做成待办。" },
      { role: "assistant", taskId: "task-visual", content: "### 本周待办,\n\n- **实验课签到**：11/21 09:30，一教 116\n- **竞赛报名截止**：11/30 18:00（来源：[官方通知](https://example.org/notice)）\n\n已生成 `data/待办清单.docx`，可直接打开核对。" },
    ],
    taskViews: { "task-visual": { task, events, lastSeq: 5, connection: "live" } },
  },
  { id: "visual-2", name: "课表导入（CSV）", mode: "auto", createdAt: ISO, tokens: 3200, messages: [{ role: "user", content: "导入这学期课表" }, { role: "assistant", content: "已解析 12 门课程，发现 2 处时间冲突。" }] },
  { id: "visual-3", name: "竞赛机会筛选", mode: "auto", createdAt: ISO, tokens: 1800, archived: true, messages: [] },
];

async function seed(page: import("@playwright/test").Page, theme: "light" | "dark") {
  await page.addInitScript(({ sessions, theme }) => {
    localStorage.setItem("campusmate.onboarded", "true");
    localStorage.setItem("campusmate.appearance", JSON.stringify({ theme, fontSize: 14, stepDensity: "standard", stepCollapseTiming: "after_answer", stepReplyRetention: "all", language: "zh" }));
    localStorage.setItem("campusmate.sessions.v2:demo", JSON.stringify(sessions));
    localStorage.setItem("campusmate.reasoning:demo", "max");
  }, { sessions, theme });
  await page.route("**/api/providers", (route) => route.fulfill({ json: { providers: [{ id: "fixture", name: "DeepSeek V4 Flash", model: "DeepSeek-V4-Flash", baseUrl: "https://api.example/v1", hasKey: true, isDefault: true, contextLimit: 200000 }] } }));
}

for (const theme of ["light", "dark"] as const) {
  test(`视觉基线 · 对话页 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page, theme);
    await page.goto("/app/agent");
    await page.getByText("整理本周群通知", { exact: false }).first().waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `agent-${theme}-1440.png`) });
    const stepsSummary = page.getByText(/工作步骤 · \d+ 步/).first();
    if (await stepsSummary.count()) { await stepsSummary.click(); await page.waitForTimeout(200); await page.screenshot({ path: path.join(OUT, `agent-${theme}-1440-steps.png`) }); }
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `agent-${theme}-1024.png`) });
  });
  test(`视觉基线 · 设置页 ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page, theme);
    await page.goto("/app/settings");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `settings-${theme}-1440.png`) });
  });
}

test("视觉基线 · 对话页移动端", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, "light");
  await page.goto("/app/agent");
  await page.getByText("本周待办").first().waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "agent-light-390.png") });
});

