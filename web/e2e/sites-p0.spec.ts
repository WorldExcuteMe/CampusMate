import { expect, test, type Page } from "@playwright/test";

// Every request below is a fixture. Real same-origin API, artifact storage and third parties are never contacted.
const ORIGIN = "http://127.0.0.1:5173";
const API = "/functions/v1/app";
const RUN_ID = "run_fixture_p0_000001";
const FILE_ID = "file_fixture_notice_0001";
const ARTIFACT_URL = "https://fixture.campusmate.invalid/notice.md";
const NOTICE = "关于期中考试安排的通知\n时间：11月25日 9:00\n地点：一教 101";

const EVENTS = [
  { id: "evt-user", type: "user.message", content: [{ type: "text", text: NOTICE }] },
  { id: "evt-tool", type: "agent.tool_use", name: "Write" },
  { id: "evt-tool-result", type: "agent.tool_result", tool_use_id: "evt-tool" },
  { id: "evt-artifact", type: "agent.artifact_delivered", file_id: FILE_ID, original_filename: "通知整理.md", content_type: "text/markdown", size: 2048 },
  { id: "evt-message", type: "agent.message", content: [{ type: "text", text: "## 整理完成\n\n- 时间：11月25日 9:00\n- 地点：一教 101" }] },
  { id: "evt-done", type: "session.status_idle", stop_reason: { type: "end_turn" } }
];

const SSE = EVENTS.map((event) => `event: cloud_event\ndata: ${JSON.stringify(event)}\n\n`).join("");

const ARTIFACT_MD = [
  "# 通知整理结果",
  "",
  "考试安排如下。",
  "",
  "- 时间：11月25日 9:00",
  "- 地点：一教 101",
  "",
  "<script>window.__sitesP0Executed = true</script>",
  "",
  '<img src="https://tracker.example/pixel.png" onerror="window.__sitesP0Img = true">'
].join("\n");

type FixtureStats = {
  posts: string[];
  apiCalls: string[];
  streams: number;
  artifactReads: number;
  external: string[];
};

async function installFixtures(page: Page, options: { unauthorized?: boolean } = {}): Promise<FixtureStats> {
  const stats: FixtureStats = { posts: [], apiCalls: [], streams: 0, artifactReads: 0, external: [] };

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.href.startsWith("http") && url.origin !== ORIGIN && !url.href.startsWith(ARTIFACT_URL)) {
      stats.external.push(url.href);
    }
  });

  // Guard first so later, more specific routes win. Anything outside the page origin and the artifact fixture is blocked.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith("http") || url.origin === ORIGIN || url.href.startsWith(ARTIFACT_URL)) {
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });

  await page.route((url) => url.origin === ORIGIN && url.pathname.startsWith(`${API}/`), (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice(API.length);
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });

    stats.apiCalls.push(`${method} ${path}`);
    if (method !== "GET") stats.posts.push(`${method} ${path}`);

    if (path === "/me") {
      return options.unauthorized ? json({ error: "login_required" }, 401) : json({ user: { id: "user_fixture_p0" } });
    }
    if (method === "POST" && path === "/initialize") return json({ ready: true });
    if (method === "POST" && path === "/runs") return json({ run: { id: RUN_ID, state: "ready" } });
    if (method === "POST" && path === `/runs/${RUN_ID}/message`) {
      return json({ run: { id: RUN_ID, state: "submitted" }, events: [] });
    }
    if (method === "GET" && path === `/runs/${RUN_ID}/stream`) {
      stats.streams += 1;
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
        body: SSE
      });
    }
    if (method === "GET" && path === `/runs/${RUN_ID}`) {
      return json({ run: { id: RUN_ID, state: "submitted" }, session: { status: "terminated" } });
    }
    if (method === "GET" && path === `/runs/${RUN_ID}/events`) return json({ events: EVENTS });
    if (method === "GET" && path === `/runs/${RUN_ID}/artifacts/${FILE_ID}`) {
      return json({ url: ARTIFACT_URL, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return json({ error: "unexpected_fixture_request", method, path }, 500);
  });

  await page.route((url) => url.href === ARTIFACT_URL, (route) => {
    stats.artifactReads += 1;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" },
      body: ARTIFACT_MD
    });
  });

  return stats;
}

test("401 时只展示 Qoder 登录入口，加载阶段不发起任何 POST", async ({ page }) => {
  const stats = await installFixtures(page, { unauthorized: true });
  await page.goto("/sites-ui/index.html");

  await expect(page.locator("#auth-slot")).toBeVisible();
  await expect(page.locator("#auth-title")).toHaveText("需要 Qoder 账号");
  await expect(page.getByRole("link", { name: "使用 Qoder 登录" }))
    .toHaveAttribute("href", /^\/__qoder_auth\/start\?return_path=/);
  await expect(page.locator("#submit-button")).toBeDisabled();
  await expect(page.locator("#submit-button")).toHaveText("登录后可开始");
  await expect(page.locator("#init-status")).toHaveAttribute("data-state", "idle");

  expect(stats.posts).toEqual([]);
  expect(stats.streams).toBe(0);
});

test("P0 全流程 fixture：SSE 工具与产物、MD 安全预览、390px 无溢出、刷新只读恢复", async ({ page }) => {
  const stats = await installFixtures(page);
  await page.goto("/sites-ui/index.html");

  await expect(page.locator("#init-status")).toHaveAttribute("data-state", "idle");
  expect(stats.posts).toEqual([]);
  await page.screenshot({ path: "test-results/sites-p0/before-desktop.png", fullPage: true, animations: "disabled" });

  await page.locator("#notice").fill(NOTICE);
  await page.locator("#submit-button").click();
  await expect(page.locator("#run-status-label")).toHaveText("已完成");
  expect(stats.posts).toEqual([`POST /initialize`, `POST /runs`, `POST /runs/${RUN_ID}/message`]);

  const timeline = page.locator("#tool-timeline");
  await expect(timeline.getByText("写入文件", { exact: true })).toBeVisible();
  await expect(timeline.getByText("交付产物 · 通知整理.md", { exact: true })).toBeVisible();
  await expect(page.locator("#artifact-count")).toHaveText("1 个");
  await expect(page.locator("#artifact-list")).toContainText("通知整理.md");
  await expect(page.locator("#message-list")).toContainText("整理完成");

  await page.getByRole("button", { name: "预览 通知整理.md" }).click();
  await expect(page.locator("#preview-status")).toContainText("已加载");
  await expect(page.locator("#preview-body").getByRole("heading", { name: "通知整理结果" })).toBeVisible();
  await expect(page.locator("#preview-body")).toContainText("<script>");
  await expect(page.locator("#preview-body").locator("script, img, iframe")).toHaveCount(0);
  const xss = await page.evaluate(() => ({
    script: Boolean((window as Window & { __sitesP0Executed?: boolean }).__sitesP0Executed),
    image: Boolean((window as Window & { __sitesP0Img?: boolean }).__sitesP0Img)
  }));
  expect(xss).toEqual({ script: false, image: false });
  expect(stats.artifactReads).toBe(1);
  await page.screenshot({ path: "test-results/sites-p0/after-desktop.png", fullPage: true, animations: "disabled" });

  await page.locator("#theme-button").click();
  await page.locator("#theme-button").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "test-results/sites-p0/after-dark.png", fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: 390, height: 760 });
  const widths = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth
  }));
  expect(widths.doc).toBeLessThanOrEqual(widths.win);
  expect(widths.body).toBeLessThanOrEqual(widths.win);
  const panel = (await page.locator("#run-panel").boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/sites-p0/after-mobile.png", fullPage: true, animations: "disabled" });

  const callsBefore = stats.apiCalls.length;
  const postsBefore = stats.posts.length;
  const streamsBefore = stats.streams;
  await page.reload();
  await expect(page.locator("#run-status-label")).toHaveText("已完成");
  await expect(page.locator("#message-list")).toContainText("整理完成");
  await expect(page.locator("#artifact-list")).toContainText("通知整理.md");

  const reloadCalls = stats.apiCalls.slice(callsBefore);
  expect(reloadCalls.length).toBeGreaterThan(0);
  expect(reloadCalls.every((call) => call.startsWith("GET "))).toBe(true);
  expect(reloadCalls).toContain("GET /me");
  expect(reloadCalls).toContain(`GET /runs/${RUN_ID}`);
  expect(reloadCalls).toContain(`GET /runs/${RUN_ID}/events`);
  expect(stats.posts.length).toBe(postsBefore);
  expect(stats.streams).toBe(streamsBefore);
  expect(stats.external).toEqual([]);
});
