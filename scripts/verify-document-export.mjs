// Real local Docker + authenticated API + browser downloads. No model calls.
// All seeded rows belong to newly generated disposable accounts, cleaned in finally.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PgPool, transactionPool } from '../backend/src/runtime/sql.ts';
import { buildContext } from '../backend/src/app-context.ts';
import { canonicalArgs, sha256 } from '../backend/src/runtime/idempotency.ts';
import { inspectExport, DOCUMENT_CHROMIUM_OPTIONS } from '../backend/src/core/document-renderer.ts';
import { richDocument } from '../backend/tests/fixtures/document.ts';

const root = new URL('../', import.meta.url), require = createRequire(new URL('web/package.json', root));
const { chromium, expect } = require('@playwright/test'), { createClient } = require('@supabase/supabase-js');
const info = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/supabase/dist/supabase.js', root)), '--workdir', fileURLToPath(new URL('.local/dev', root)), 'status', '-o', 'json'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
for (const url of [info.API_URL, info.DB_URL]) assert.equal(new URL(url).hostname, '127.0.0.1', 'Local fixture must never connect to a remote database');
const admin = createClient(info.API_URL, info.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new URL(info.DB_URL); db.searchParams.set('sslmode', 'disable'); const pool = new PgPool(db.href, { ssl: false });
const ctx = buildContext({}, { pool }), users = [], clients = [], out = new URL('.local/dev/document-live/', root);
const api = 'http://127.0.0.1:8788', pass = label => console.log('PASS ' + label);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let browser, page;
try {
  assert.equal((await fetch(api + '/v1/health')).status, 200);
  await mkdir(out, { recursive: true });
  async function account() {
    const email = `document-export-${randomUUID()}@example.com`, password = randomBytes(24).toString('hex');
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw Error('Fixture account creation failed'); users.push(created.data.user);
    const client = createClient(info.API_URL, info.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); clients.push(client);
    const login = await client.auth.signInWithPassword({ email, password });
    if (login.error) throw Error('Fixture sign-in failed');
    return { id: created.data.user.id, email, password, headers: { Authorization: `Bearer ${login.data.session.access_token}` } };
  }
  const owner = await account(), other = await account(), ast = richDocument();
  const session = await ctx.sessionStore.create({ userId: owner.id, title: '文档真实下载隔离测试' });
  const artifact = await pool.transaction(async client => {
    const nested = buildContext({}, { pool: transactionPool(client) });
    const { task } = await nested.store.createSessionTask({ userId: owner.id, sessionId: session.id, turnId: randomUUID(), title: '导出环境验收', intent: '测试中文、长表格、图片及图表的实际文档下载。' }, nested.sessionStore);
    const source = await nested.artifactStore.create({ userId: owner.id, taskId: task.id, kind: 'document', inline: ast, sha256: sha256(canonicalArgs(ast)) });
    await client.query("update agent_tasks set status='succeeded',result=$2::jsonb where id=$1", [task.id, JSON.stringify({ summary: '合成测试文档已准备，未请求付费模型。请从文档预览下载。', artifactIds: [source.id], completion: { state: 'complete', checks: [] } })]);
    return source;
  });
  const meta = await fetch(`${api}/v1/artifacts/${artifact.id}`, { headers: owner.headers }); assert.equal(meta.status, 200);
  assert.deepEqual((await meta.json()).availableFormats, ['md', 'docx', 'pdf']); pass('Running API exposes all three real document formats');
  const results = [];
  for (const format of ['docx', 'pdf']) {
    const url = `${api}/v1/artifacts/${artifact.id}/download?format=${format}`;
    const response = await fetch(url, { headers: owner.headers }); assert.equal(response.status, 200, `${format}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, format === 'pdf' ? 5 : 2).toString(), format === 'pdf' ? '%PDF-' : 'PK');
    assert.equal(digest(bytes), response.headers.get('x-file-sha256')); assert.match(response.headers.get('content-disposition'), /attachment/);
    const result = await inspectExport(ast, bytes, format); assert.equal(result.passed, true, JSON.stringify(result)); results.push(result);
    await writeFile(new URL(`api.${format}`, out), bytes);
    const repeat = await fetch(url, { headers: owner.headers }); assert.equal(repeat.status, 200); assert.equal(digest(Buffer.from(await repeat.arrayBuffer())), digest(bytes));
    assert.equal((await fetch(url)).status, 401); assert.equal((await fetch(url, { headers: other.headers })).status, 404);
    pass(`${format.toUpperCase()} real API download/readback/hash/cache/owner isolation`);
  }
  assert.equal((await ctx.artifactStore.listByTask(owner.id, artifact.taskId)).filter(a => a.kind === 'document-export').length, 2);
  browser = await chromium.launch(DOCUMENT_CHROMIUM_OPTIONS);
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('http://127.0.0.1:5173/login'); await page.getByLabel('邮箱', { exact: true }).fill(owner.email); await page.getByLabel('密码', { exact: true }).fill(owner.password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/app'); await page.goto('http://127.0.0.1:5173/app/agent');
  await page.getByRole('button', { name: /查看文档/ }).click({ timeout: 20000 });
  await expect(page.getByRole('dialog')).toContainText(ast.title);
  for (const format of ['docx', 'pdf']) {
    const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: `下载 ${format.toUpperCase()}`, exact: true }).click();
    const download = await downloadEvent; assert.equal(await download.failure(), null);
    const target = fileURLToPath(new URL(`browser.${format}`, out)); await download.saveAs(target);
    assert.equal(digest(await readFile(target)), results.find(r => r.format === format).sha256);
    pass(`${format.toUpperCase()} button downloaded the exact verified file in an isolated browser`);
  }
  await page.screenshot({ path: fileURLToPath(new URL('download-preview.png', out)), fullPage: true });
  await writeFile(new URL('inspection.json', out), JSON.stringify(results, null, 2));
  console.log('LOCAL_DOCUMENT_EXPORT_VERIFIED (real Docker/API/browser, no paid model calls)');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: fileURLToPath(new URL('failure.png', out)), fullPage: true }).catch(() => {});
    await writeFile(new URL('failure-ui.txt', out), await page.locator('body').innerText()).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  for (const client of clients) client.auth.stopAutoRefresh();
  const failures = [];
  for (const user of users) { const deleted = await admin.auth.admin.deleteUser(user.id); if (deleted.error) failures.push(user.id); }
  await pool.end();
  assert.equal(failures.length, 0, 'Temporary fixture account cleanup failed');
  console.log('PASS Temporary accounts/data cleaned; existing accounts untouched');
}
