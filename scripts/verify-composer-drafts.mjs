// Local real auth/API + IndexedDB + isolated browser. All model task POSTs are
// intercepted and rejected by the test: no paid calls, no existing user data.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { DOCUMENT_CHROMIUM_OPTIONS } from '../backend/src/core/document-renderer.ts';
const root = new URL('../', import.meta.url), require = createRequire(new URL('web/package.json', root));
const { chromium, expect } = require('@playwright/test'), { createClient } = require('@supabase/supabase-js');
const info = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/supabase/dist/supabase.js', root)), '--workdir', fileURLToPath(new URL('.local/dev', root)), 'status', '-o', 'json'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
assert.equal(new URL(info.API_URL).hostname, '127.0.0.1');
const admin = createClient(info.API_URL, info.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const out = new URL('.local/dev/composer-drafts/', root), users = [], writes = [], submissions = [];
const pass = label => console.log('PASS ' + label);
let browser, page;
try {
  await mkdir(out, { recursive: true });
  async function account() {
    const email = `composer-draft-${randomUUID()}@example.com`, password = randomBytes(24).toString('hex');
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw Error('Fixture account creation failed'); users.push(created.data.user.id); return { email, password };
  }
  const alice = await account(), bob = await account();
  browser = await chromium.launch(DOCUMENT_CHROMIUM_OPTIONS); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    const original = File.prototype.text;
    window.__draftParsedNames = [];
    File.prototype.text = function () { return this.name.startsWith('slow-') ? new Promise((resolve, reject) => setTimeout(() => original.call(this).then(text => { window.__draftParsedNames.push(this.name); resolve(text); }, reject), 1800)) : original.call(this); };
  });
  await page.route('**/v1/tasks', route => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push(route.request().postDataJSON()); return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '隔离验证：不提交模型任务' }) });
  });
  page.on('request', request => { if (/\/v1\/sessions(?:\/|$)/.test(request.url()) && ['POST', 'PATCH'].includes(request.method())) writes.push(request.postDataJSON()); });
  const input = () => page.getByPlaceholder(/输入消息 \/ 粘贴群通知/);
  const saved = () => expect(page.getByText('草稿按会话保存在本机，不跨设备同步', { exact: true })).toBeVisible();
  async function login(user) {
    await page.goto('http://127.0.0.1:5173/login'); await page.getByLabel('邮箱', { exact: true }).fill(user.email); await page.getByLabel('密码', { exact: true }).fill(user.password); await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/app'); await page.goto('http://127.0.0.1:5173/app/agent'); await expect(input()).toBeEnabled({ timeout: 20000 }); await saved();
  }
  async function rename(name) { await page.locator('header button[title="点击重命名"]').click(); await page.getByLabel('会话名称', { exact: true }).fill(name); await page.getByLabel('会话名称', { exact: true }).press('Enter'); await expect(page.locator('header').last()).toContainText(name); await saved(); }
  const row = id => page.locator(`[data-session-id="${id}"]`);
  async function attach(name, text = '测试附件正文') { await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) }); }
  async function logout() { await saved(); await page.getByRole('button', { name: '用户与设置' }).click(); const response = page.waitForResponse(r => r.url().includes('/auth/v1/logout')); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await response; }
  await login(alice); await rename('草稿隔离A');
  const a = await page.locator('[data-session-id]').filter({ hasText: '草稿隔离A' }).getAttribute('data-session-id');
  await input().fill('A私有草稿7391'); await attach('A.txt');
  await page.locator('input[type=file]').setInputFiles({ name: 'A.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByText('正在解析…', { exact: true })).toHaveCount(0); await saved();
  await page.getByRole('button', { name: '新会话', exact: true }).click(); await expect(input()).toBeEnabled(); await rename('草稿隔离B');
  const b = await page.locator('[data-session-id]').filter({ hasText: '草稿隔离B' }).getAttribute('data-session-id');
  await expect(input()).toHaveValue(''); await expect(page.getByRole('button', { name: '移除附件 A.txt' })).toHaveCount(0);
  await input().fill('B私有草稿8426'); await attach('B.txt'); await expect(page.getByText('正在解析…', { exact: true })).toHaveCount(0); await saved();
  await page.reload(); await expect(input()).toHaveValue('B私有草稿8426'); await expect(page.getByRole('button', { name: '移除附件 B.txt' })).toBeVisible(); await saved();
  await row(a).click(); await expect(input()).toHaveValue('A私有草稿7391'); await expect(page.getByRole('button', { name: '移除附件 A.png' })).toBeVisible(); await expect(page.getByRole('button', { name: '移除附件 B.txt' })).toHaveCount(0);
  pass('Real IndexedDB restores separate text/document/image drafts and active session after refresh');
  await attach('slow-A.txt'); await expect(page.getByText('正在解析…', { exact: true })).toBeVisible(); await row(b).click();
  await page.waitForFunction(() => window.__draftParsedNames.includes('slow-A.txt'));
  await expect(input()).toHaveValue('B私有草稿8426'); await expect(page.getByRole('button', { name: '移除附件 slow-A.txt' })).toHaveCount(0);
  await row(a).click(); await expect(page.getByRole('button', { name: '移除附件 slow-A.txt' })).toBeVisible(); await expect(page.getByText('正在解析…', { exact: true })).toHaveCount(0); await saved();
  await attach('slow-refresh.txt'); await expect(page.getByText('正在解析…', { exact: true })).toBeVisible(); await saved(); await page.reload();
  await expect(page.getByRole('button', { name: '移除附件 slow-refresh.txt' })).toBeVisible(); await expect(page.getByText('正在解析…', { exact: true })).toHaveCount(0); await saved();
  pass('Late attachment completion stays in A; persisted original File resumes parsing after reload');
  await page.locator('header button[title="点击重命名"]').click(); await page.getByLabel('会话名称', { exact: true }).fill('只改A不改B'); await row(b).click();
  await expect(row(a)).toContainText('只改A不改B'); await expect(page.locator('header').last()).toContainText('草稿隔离B');
  await rename('B名称只提交一次'); assert.equal(writes.filter(w => w?.title === 'B名称只提交一次' && 'expectedRevision' in w).length, 1);
  pass('Switching during rename commits to original target; Enter + blur causes only one metadata write');
  await row(a).click(); await expect(input()).toHaveValue('A私有草稿7391'); await saved();
  await page.screenshot({ path: fileURLToPath(new URL('verified.png', out)), fullPage: true });
  assert(!JSON.stringify(writes).includes('A私有草稿7391') && !JSON.stringify(writes).includes('B私有草稿8426'));
  await page.getByRole('button', { name: '发送', exact: true }).click(); await expect(page.getByRole('button', { name: '重试提交同一轮次', exact: true })).toBeVisible();
  await input().fill('新写的草稿不能被重试清掉'); await saved(); await page.getByRole('button', { name: '重试提交同一轮次', exact: true }).click();
  await expect.poll(() => submissions.length).toBeGreaterThanOrEqual(2); await expect(input()).toHaveValue('新写的草稿不能被重试清掉'); assert.equal(submissions[0].turnId, submissions[1].turnId); assert.equal(submissions[0].intent, submissions[1].intent);
  pass('Sending clears only that composer; retry uses old turn and preserves the new unsent draft');
  await logout(); await login(bob); await expect(input()).toHaveValue(''); await expect(page.getByRole('button', { name: /移除附件/ })).toHaveCount(0);
  await input().fill('Bob独立草稿'); await saved(); await logout(); await login(alice); await row(a).click(); await expect(input()).toHaveValue('新写的草稿不能被重试清掉');
  pass('Same browser logout/account switch keeps drafts isolated; returning owner restores own draft');
  await writeFile(new URL('result.json', out), JSON.stringify({ verified: true, interceptedTaskSubmissions: submissions.length, paidModelCalls: 0 }, null, 2));
  console.log('LOCAL_COMPOSER_DRAFTS_VERIFIED');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: fileURLToPath(new URL('failure.png', out)), fullPage: true }).catch(() => {}); await writeFile(new URL('failure-ui.txt', out), await page.locator('body').innerText()).catch(() => {}); }
  throw error;
} finally {
  await browser?.close();
  const failed = []; for (const id of users) { const removed = await admin.auth.admin.deleteUser(id); if (removed.error) failed.push(id); }
  assert.equal(failed.length, 0, 'Fixture cleanup failed'); pass('Only generated temporary accounts/data cleaned; existing users untouched');
}
