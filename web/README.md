# CampusMate Web

React + TypeScript + Vite 静态前端，业务数据库为 Supabase，模型调用经服务端代理。

```powershell
npm ci
npm run dev
```

`npm run dev` / `npm run preview` 自动监督本地 API；`npm run dev:api` 可独立调试（不要重复启动相同端口）。没有代理或密钥时，提取明确回退到 Mock。
配置 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 后可登录真实模式；匿名用户仍使用本地 Demo。

```powershell
npm run test
npm run build
npm run check:function
npx playwright install chromium
npm run test:e2e
```

支持 Node `^22.13.0 || >=24.0.0`。本地 Node 代理使用原生 TypeScript stripping；生产 Function 使用 Deno。
模型密钥只能放在 `.env.local`、本地 `.providers.local.json` 或生产服务端 Secret，不能放进 `VITE_*`。

部署时同时交付 `dist/` 与 `functions/`，开启 SPA 回退，配置生产 Secret 和函数路由。Vite 的代理配置不作用于生产。
生产 Function 验证 Supabase access token；供应商只读。**发布与公开访问仍需人工确认**。

数据库需依次执行仓库中的 0001、0002 migration。完整配置、限制、回归说明见仓库根 `docs/AI_BACKEND_SETUP.md`。
