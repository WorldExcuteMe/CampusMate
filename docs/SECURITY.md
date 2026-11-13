# CampusMate · SECURITY.md

版本 0.1 · 2026-11-12 · 主提示词 §13 · Member A 负责安全审计

## 1. 威胁面与对策

| 威胁 | 对策 |
|---|---|
| 用户隐私泄露 | RLS 按 auth.uid 隔离；聊天记录/简历为敏感材料；明确隐私说明 + 数据删除机制 |
| 上传文件恶意 | 类型白名单（txt/png/jpg/pdf/docx）、体积上限、Storage 私有桶、不执行上传内容 |
| SSRF | 见 §2 URL 抓取防护 |
| Prompt Injection | 抓取/上传内容视为数据非指令；提取 prompt 限定只抽字段；输出 Zod 白名单过滤 |
| XSS | React 默认转义；富文本/原文展示用 textContent 或 DOMPurify；不 innerHTML 注入用户内容 |
| SQL Injection | 全部参数化（Supabase client / migration）；不拼 SQL |
| 权限绕过 | RLS 强制；Agent 不绕业务层改库；服务端校验 owner |
| API Key 泄露 | Key 仅 Edge Function 环境变量；前端只 anon key；.env 不入库 |
| 恶意网页/不可信源 | 官方白名单优先；来源类型标注；证据带 retrievedAt/confidence |

## 2. URL 抓取防护（Data Collection）

禁止访问 localhost、内网地址（10/172.16/192.168/127/169.254 等）、云元数据地址（169.254.169.254）；校验重定向目标；限制响应体积与请求时间；仅允许 http/https 公开协议；不执行未知网页脚本。实现于 `web/src/lib/security/urlGuard.ts`（采集侧服务端同样校验）。

## 3. 认证与授权

Supabase Auth；每表 RLS owner 策略；公共参考数据（opportunities/evidence/reports/白名单）public read；写操作仅服务端角色。Demo 模式只读真实数据、不可写。

## 4. 隐私与数据删除

- Settings 提供「导出我的数据」「删除我的数据」。
- 删除 cascade 用户表 + 清理 Storage `uploads/{uid}/`。
- 隐私说明页：收集什么、为何、存哪、如何删。

## 5. 安全测试

RLS 测试（跨用户访问必须拒绝）；URL Guard 单测（内网/元数据/重定向拦截）；上传校验单测；XSS 渲染测试；详见 TEST_PLAN.md。

## 6. 禁止项（与 PRODUCT_SPEC 一致）

不未授权读私聊、不自动登录/投递/报名/付款、不伪造官方信息、不把未核验判诈骗、不虚构业务结果。