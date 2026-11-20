#!/usr/bin/env node
// Sites 静态托管只对“目录/尾斜杠”做 SPA 回退；为已知路由目录复制 index.html，
// 让 /app、/app/inbox 等直链在刷新时仍能加载应用。动态详情页由前端路由接管。
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(WEB_ROOT, "dist");
const ROUTES = [
  "app", "app/agent", "app/inbox", "app/inbox/new", "app/daily", "app/calendar",
  "app/radar", "app/trust", "app/growth", "app/profile", "app/settings", "login",
];

const index = await readFile(join(DIST, "index.html"));
if (!index.length) throw new Error("dist/index.html 为空");
for (const route of ROUTES) {
  const target = join(DIST, ...route.split("/"), "index.html");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(DIST, "index.html"), target);
}
console.log(`[spa-fallbacks] 已生成 ${ROUTES.length} 个路由回退页`);