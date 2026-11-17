// Two isolated Chromium contexts, one disposable account, real local Docker/API.
// Seeds completed synthetic records atomically; never invokes a paid model.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PgPool, transactionPool } from '../backend/src/runtime/sql.ts';
import { buildContext } from '../backend/src/app-context.ts';
const root = new URL('../', import.meta.url), req = createRequire(new URL('web/package.json', root));
const { chromium, expect } = req('@playwright/test'), { createClient } = req('@supabase/supabase-js');
const info = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/supabase/dist/supabase.js', root)), '--workdir', fileURLToPath(new URL('.local/dev', root)), 'status', '-o', 'json'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
assert.equal(new URL(info.API_URL).hostname, '127.0.0.1');
const admin = createClient(info.API_URL, info.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new URL(info.DB_URL); db.searchParams.set('sslmode', 'disable'); const pool = new PgPool(db.href, { ssl: false });
const ctx = buildContext({}, { pool });
let user, browser;
const pass = label => console.log('PASS '+label);
try {
  const email = `session-sync-${randomUUID()}@example.com`, password = randomBytes(24).toString('hex');
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw Error('Fixture account creation failed'); user = created.data.user;
  const initial = '会话同步隔离测试', renamed = '双浏览器重命名已同步';
  const s = await ctx.sessionStore.create({ userId: user.id, title: initial });
  const task = await pool.transaction(async client => {
    const nested = buildContext({}, { pool: transactionPool(client) });
    const { task: t } = await nested.store.createSessionTask({ userId: user.id, sessionId: s.id, turnId: randomUUID(), title: '合成验证任务', intent: '跨浏览器恢复完整测试问题7391' }, nested.sessionStore);
    await client.query("update agent_tasks set status='succeeded',result=$2::jsonb where id=$1", [t.id, JSON.stringify({ summary: '完整测试答复已恢复7391', artifactIds: [] })]); return t;
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const a = await browser.newContext(), b = await browser.newContext();
  async function open(context) {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5173/login'); await page.getByLabel('邮箱', { exact: true }).fill(email); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/app'); await page.goto('http://127.0.0.1:5173/app/agent'); return page;
  }
  const pa = await open(a), pb = await open(b);
  const row = (page, title) => page.locator('[data-session-id]').filter({ hasText: title });
  await expect(row(pa, initial)).toHaveCount(1, { timeout: 15000 }); await expect(row(pb, initial)).toHaveCount(1, { timeout: 15000 });
  await expect(pb.getByText('跨浏览器恢复完整测试问题7391', { exact: true })).toBeVisible(); await expect(pb.getByText('完整测试答复已恢复7391', { exact: true })).toBeVisible(); pass('Two clean isolated browsers recover the same complete conversation');
  await pa.getByRole('button', { name: initial, exact: true }).click(); await pa.locator('header input').fill(renamed); await pa.locator('header input').press('Enter');
  await expect(row(pb, renamed)).toHaveCount(1, { timeout: 15000 }); pass('Rename in A propagates to B');
  await pa.screenshot({ path: fileURLToPath(new URL('.local/dev/session-sync-browser-a.png', root)), fullPage: true });
  await pb.screenshot({ path: fileURLToPath(new URL('.local/dev/session-sync-browser-b.png', root)), fullPage: true });
  await row(pa, renamed).hover(); await row(pa, renamed).getByRole('button', { name: '归档会话', exact: true }).click();
  await expect(row(pb, renamed)).toHaveCount(0, { timeout: 15000 }); await pb.getByRole('button', { name: '归档（1）', exact: true }).click();
  await expect(row(pb, renamed)).toHaveCount(1); pass('Archive in A appears in B archived list');
  await row(pb, renamed).hover(); await row(pb, renamed).getByRole('button', { name: '恢复会话', exact: true }).click();
  await pb.getByRole('button', { name: '返回活跃会话', exact: true }).click();
  await expect(row(pa, renamed)).toHaveCount(1, { timeout: 15000 }); await expect(row(pb, renamed)).toHaveCount(1); pass('Restore in B propagates to A');
  await pb.getByRole('button', { name: '日常', exact: true }).click();
  await expect.poll(async () => (await ctx.sessionStore.get(user.id, s.id)).mode).toBe('daily');
  await expect(pa.getByRole('button', { name: '日常', exact: true })).toHaveClass(/bg-background/, { timeout: 15000 }); pass('Conversation mode also synchronizes');
  await row(pb, renamed).hover(); await row(pb, renamed).getByRole('button', { name: '删除会话', exact: true }).click(); await row(pb, renamed).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(row(pa, renamed)).toHaveCount(0, { timeout: 15000 }); await expect(row(pb, renamed)).toHaveCount(0); pass('Delete in B removes the session from A');
  const c = await browser.newContext(), pc = await open(c); await expect(pc.getByRole('button', { name: '新会话', exact: true }).first()).toBeVisible();
  await expect(row(pc, renamed)).toHaveCount(0); assert((await ctx.sessionStore.get(user.id, s.id)).deletedAt); assert(await ctx.store.getTask(task.id));
  await assert.rejects(() => ctx.sessionStore.create({ userId: user.id, id: s.id })); pass('Fresh browser and stale POST cannot resurrect tombstone; original task retained');
  console.log('LOCAL_SESSION_SYNC_VERIFIED (real Docker/API, two browser contexts, no paid model request)');
} finally {
  await browser?.close();
  if (user) { const deleted = await admin.auth.admin.deleteUser(user.id); if (deleted.error) throw Error('Temporary account cleanup failed'); pass('Temporary account/data cleaned; existing accounts untouched'); }
  await pool.end();
}
