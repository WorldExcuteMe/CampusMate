# CampusMate 协作规则

## 分支模型
- `main`：受保护，仅接受来自 `develop` 的发布 PR；CI 全绿 + 评审通过才可合并；合并触发 CD（构建+Release+Sites 发布需人工确认）。
- `develop`：集成分支，受保护；feature PR 的目标分支；CI 全绿才可合并。
- `feature/<slug>` / `fix/<slug>`：从最新 `develop` 切出；完成后 PR 回 `develop`。
- 禁止直接 push `main`/`develop`；禁止 `git add -A` 提交无关文件；提交信息用约定式（feat/fix/docs/test/chore）。

## 标准工作流
1. `git fetch origin && git switch -c feature/<slug> origin/develop`
2. 实现 + 本地验证：`npm run build`、`npm run test`（单元+集成）、`npm run test:e2e`（核心闭环）。
3. 推送 feature 分支 → 开 PR 到 `develop`（用 PR 模板，附验证证据/截图）。
4. CI（build+单元+集成+E2E）全绿 + 至少 1 人评审 → 合并进 `develop`。
5. 发布：`develop` → `main` PR，CI 全绿 + 评审 → 合并触发 CD；Sites 公开访问变更需人工确认。

## 测试门槛（PR 必过）
- 单元：Vitest（extractor/classifier/urlGuard/orchestrator）。
- 集成：Vitest（agent+repository 闭环）。
- E2E：Playwright（第一条业务闭环+日常任务+页面可达）。
- 不得编造测试结果；未覆盖项如实列出。

## 文档与上传取舍
- 上传：源码、`docs/` 工程文档、`supabase/migrations`、`.github`、README、project.md。
- 不上传：`docs/research/`（内部审计）、`.qoder/`、`.env*`、`.providers.local.json`、本地证据/截图、主提示词存档。
- 密钥仅服务端；前端只含公开 anon/publishable key。

## 角色
- Member A：架构/Agent/Trust/后端/数据库/安全/集成。
- Member B：前端/交互/浏览器测试。
- Member C：数据工程/来源/测试集/推荐数据。