import './check-node.mjs';
// Set this before importing Vite: the desktop terminal can inherit development mode.
process.env.NODE_ENV = 'production';
const { build } = await import('vite');
await build({ mode: 'production' });
// Sites 静态托管没有通配回退：为已知路由目录生成 index.html，保证 /app 直链可刷新。
await import('./spa-fallbacks.mjs');
