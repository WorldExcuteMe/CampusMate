// Two tabs in ONE browser context share real IndexedDB/auth. Notifications can
// deliberately be dropped to prove correctness comes from transactions, not timing.
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
const out = new URL('.local/dev/draft-tabs/', root), pass = label => console.log('PASS ' + label);
let user, browser, a, b, submitted = 0;
const input = page => page.getByPlaceholder(/输入消息 \/ 粘贴群通知/);
const saved = page => expect(page.getByText('草稿按会话保存在本机，不跨设备同步', { exact: true })).toBeVisible();
try {
  await mkdir(out, { recursive: true });
  const email = `draft-tabs-${randomUUID()}@example.com`, password = randomBytes(24).toString('hex');
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw Error('Fixture account creation failed'); user = created.data.user;
  browser = await chromium.launch(DOCUMENT_CHROMIUM_OPTIONS);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.route('**/v1/tasks', route => { if (route.request().method() !== 'POST') return route.continue(); submitted++; return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"fixture: no paid model calls"}' }); });
  a = await context.newPage(); await a.goto('http://127.0.0.1:5173/login'); await a.getByLabel('邮箱', { exact: true }).fill(email); await a.getByLabel('密码', { exact: true }).fill(password); await a.getByRole('button', { name: '登录', exact: true }).click(); await a.waitForURL('**/app');
  await a.goto('http://127.0.0.1:5173/app/agent'); await expect(input(a)).toBeEnabled();
  await a.locator('header button[title="点击重命名"]').click(); await a.getByLabel('会话名称', { exact: true }).fill('同会话双标签隔离验收'); await a.getByLabel('会话名称', { exact: true }).press('Enter'); await expect(a.locator('header').last()).toContainText('同会话双标签隔离验收'); await saved(a);
  b = await context.newPage();
  await b.addInitScript(() => {
    window.__holdDraftNotices = true;
    const stop = event => { if (window.__holdDraftNotices) event.stopImmediatePropagation(); };
    window.addEventListener('storage', stop, true); window.addEventListener('focus', stop, true); document.addEventListener('visibilitychange', stop, true);
    const Original = window.BroadcastChannel;
    window.BroadcastChannel = class extends Original { constructor(name) { super(name); this.addEventListener('message', stop, true); } };
  });
  await b.goto('http://127.0.0.1:5173/app/agent'); await expect(input(b)).toBeEnabled(); await saved(b);
  await input(a).fill('A独立草稿7391'); await a.locator('input[type=file]').setInputFiles({ name: 'A完整附件.txt', mimeType: 'text/plain', buffer: Buffer.from('A附件内容不能丢') }); await expect(a.getByText('正在解析…', { exact: true })).toHaveCount(0); await saved(a);
  await input(b).fill('B独立草稿8426'); await b.locator('input[type=file]').setInputFiles({ name: 'B完整附件.txt', mimeType: 'text/plain', buffer: Buffer.from('B附件内容不能丢') }); await expect(b.getByText('正在解析…', { exact: true })).toHaveCount(0); await saved(b);
  const conflict = b.getByRole('alert', { name: '草稿版本冲突' });
  await expect(conflict).toContainText('A独立草稿7391'); await expect(conflict).toContainText('B独立草稿8426');
  await expect(conflict).toContainText('A完整附件.txt'); await expect(conflict).toContainText('B完整附件.txt');
  await expect(b.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await expect(input(a)).toHaveValue('A独立草稿7391'); await b.screenshot({ path: fileURLToPath(new URL('conflict.png', out)), fullPage: true });
  pass('Dropped notifications cannot bypass real IndexedDB CAS; both text/files retained, conflicting send blocked');
  await b.getByRole('button', { name: '保留本页草稿', exact: true }).click(); await expect(conflict).toHaveCount(0); await saved(b);
  await expect(input(a)).toHaveValue('B独立草稿8426'); await expect(a.getByRole('button', { name: '移除附件 B完整附件.txt' })).toBeVisible();
  pass('Explicit choice is atomic; idle peer follows via metadata notifications');
  await b.reload(); await expect(input(b)).toHaveValue('B独立草稿8426'); await saved(b);
  await b.locator('summary').filter({ hasText: '保留的草稿版本' }).click();
  const oldA = b.locator('[data-draft-version]').filter({ hasText: 'A独立草稿7391' }).first();
  await expect(oldA).toContainText('A完整附件.txt'); await oldA.getByRole('button', { name: /恢复草稿版本/ }).click(); await saved(b);
  await expect(input(b)).toHaveValue('A独立草稿7391'); await expect(b.getByRole('button', { name: '移除附件 A完整附件.txt' })).toBeVisible();
  await expect(b.locator('[data-draft-version]').filter({ hasText: 'B独立草稿8426' }).first()).toBeVisible();
  pass('Refresh retains conflict versions; restoring A keeps B and both complete attachments');
  const atomic = await a.evaluate(async ({ owner, id }) => {
    const { createDraftPersistence } = await import('/src/lib/agent/draft-persistence.ts');
    const one = createDraftPersistence(), two = createDraftPersistence();
    const base1 = await one.read(owner, id), base2 = await two.read(owner, id);
    const results = await Promise.all([one.write(owner, id, { text: 'atomic-A', attachments: [] }, base1.current.revision, crypto.randomUUID(), 'one'), two.write(owner, id, { text: 'atomic-B', attachments: [] }, base2.current.revision, crypto.randomUUID(), 'two')]);
    const state = await one.read(owner, id); await one.remove(owner, id, 'one');
    const stale = await two.write(owner, id, { text: 'stale resurrection', attachments: [] }, 0, crypto.randomUUID(), 'two');
    const other = await one.read('another-owner', id);
    return { kinds: results.map(r => r.kind).sort(), all: [state.current.draft.text, ...state.versions.map(v => v.draft.text)].sort(), stale: stale.kind, other: other.current.draft.text, privateVersions: other.versions.length };
  }, { owner: user.id, id: 'atomic-fixture-' + randomUUID() });
  assert.deepEqual(atomic.kinds, ['conflict', 'saved']); assert.deepEqual(atomic.all, ['atomic-A', 'atomic-B']); assert.equal(atomic.stale, 'deleted'); assert.equal(atomic.other, ''); assert.equal(atomic.privateVersions, 0);
  pass('Simultaneous native IDB transactions serialize atomically; tombstone/owner boundaries hold');
  const migrationContext = await browser.newContext(), migration = await migrationContext.newPage(); await migration.goto('http://127.0.0.1:5173/login');
  const migrated = await migration.evaluate(async () => {
    await new Promise((resolve, reject) => { const request = indexedDB.open('campusmate-composer-v1', 1); request.onupgradeneeded = () => request.result.createObjectStore('drafts'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ text: 'v1 legacy must survive', attachments: [] }, JSON.stringify(['fixture-owner', 'old-local'])); tx.oncomplete = () => { db.close(); resolve(undefined); }; }; });
    const { ComposerDraftStore } = await import('/src/lib/agent/composer-drafts.ts');
    const store = new ComposerDraftStore('fixture-owner', () => true, () => {}, undefined, undefined, () => 'same-backend'); await store.load('old-local'); return store.snapshot('old-local').draft.text;
  });
  assert.equal(migrated, 'v1 legacy must survive'); await migrationContext.close(); pass('Real v1 database upgrades additively and migrates local aliases to canonical backend identity');
  assert.equal(submitted, 0); await writeFile(new URL('result.json', out), JSON.stringify({ verified: true, atomic, paidModelCalls: 0 }, null, 2));
  console.log('LOCAL_DRAFT_MULTITAB_VERIFIED');
} catch (error) {
  if (b && !b.isClosed()) { await b.screenshot({ path: fileURLToPath(new URL('failure.png', out)), fullPage: true }).catch(() => {}); await writeFile(new URL('failure-ui.txt', out), await b.locator('body').innerText()).catch(() => {}); }
  throw error;
} finally {
  await browser?.close(); if (user) { const deleted = await admin.auth.admin.deleteUser(user.id); assert(!deleted.error, 'Fixture cleanup failed'); }
  pass('Temporary account/data cleaned; existing browser/account data untouched');
}
