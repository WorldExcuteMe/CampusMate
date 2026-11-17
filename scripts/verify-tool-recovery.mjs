// Real local SQL/API/UI; scripted model + synthetic search. No paid model calls.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PgPool, transactionPool } from '../backend/src/runtime/sql.ts';
import { buildContext } from '../backend/src/app-context.ts';
import { Worker } from '../backend/src/runtime/worker.ts';
import { CLOUD_TOOLS, executeCloudTool } from '../backend/src/core/cloud-tools.ts';
import { searchPublicWeb } from '../backend/src/core/web-search.ts';
import { DOCUMENT_CHROMIUM_OPTIONS } from '../backend/src/core/document-renderer.ts';

const root = new URL('../', import.meta.url), require = createRequire(new URL('web/package.json', root));
const { chromium, expect } = require('@playwright/test'), { createClient } = require('@supabase/supabase-js');
const info = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('node_modules/supabase/dist/supabase.js', root)), '--workdir', fileURLToPath(new URL('.local/dev', root)), 'status', '-o', 'json'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
for (const url of [info.API_URL, info.DB_URL]) assert.equal(new URL(url).hostname, '127.0.0.1');
const admin = createClient(info.API_URL, info.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new URL(info.DB_URL); db.searchParams.set('sslmode', 'disable'); const pool = new PgPool(db.href, { ssl: false });
const ctx = buildContext({}, { pool }), workerId = 'recovery-fixture-' + randomUUID(), out = new URL('.local/dev/tool-recovery/', root);
const pass = label => console.log('PASS ' + label), call = (id, args, name = 'save_opportunity') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const args = (title, deadline = null) => ({ title, deadline, sourceUrl: 'https://fixture.example/competition', type: 'competition' });
let user, browser, page;
try {
  await mkdir(out, { recursive: true });
  const email = `tool-recovery-${randomUUID()}@example.com`, password = randomBytes(24).toString('hex');
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); if (created.error) throw Error('Fixture account creation failed'); user = created.data.user;
  async function run(title, script) {
    // Claim ONLY this fixture task atomically, never poll/claim the shared queue.
    // The ordinary Worker cannot pick it up or issue a real provider request.
    const task = await pool.transaction(async client => {
      const nested = buildContext({}, { pool: transactionPool(client) });
      const session = await nested.sessionStore.create({ userId: user.id, title });
      const { task } = await nested.store.createSessionTask({ userId: user.id, sessionId: session.id, turnId: randomUUID(), title, intent: '合成隔离测试：保存机会并核对执行状态，不代表真实赛事。' }, nested.sessionStore);
      await client.query("update agent_tasks set status='running',lease_owner=$2,lease_expires_at=$3,heartbeat_at=now() where id=$1", [task.id, workerId, new Date(Date.now() + 120000).toISOString()]);
      return nested.store.getTask(task.id);
    });
    let index = 0;
    const transport = { async chat() { const next = script[index++]; assert(next, 'Unexpected model request'); return { content: '', toolCalls: [], usage: { input: 1, output: 1 }, model: 'isolated-recovery-fixture', ...next }; } };
    const worker = new Worker({ store: ctx.store, sessionStore: ctx.sessionStore, workerId, transport, tools: CLOUD_TOOLS, buildSystem: () => 'Isolated test; no external credentials or model requests.', executeTool: (_task, name, input) => name === 'web_search' ? searchPublicWeb(String(input.query), 5, async () => new Response('<h2><a href="https://dictionary.example">蓝色的定义</a></h2>')).then(JSON.stringify) : executeCloudTool(name, input, { userId: user.id, taskId: task.id, opportunityStore: ctx.opportunityStore }) });
    await worker.executeTask(task);
    return ctx.store.getTask(task.id);
  }
  const recovered = await run('工具重试恢复验收', [
    { toolCalls: [call('search', { query: '蓝桥杯大赛' }, 'web_search')] },
    { toolCalls: [call('bad', args('合成测试机会A', 123))] },
    { toolCalls: [call('good', args('合成测试机会A'))] },
    { content: '测试机会已实际保存，截止日期未知留空。首次参数错误已修正；检索匹配不足，未把无关条目当证据。' },
  ]);
  assert.equal(recovered.status, 'succeeded', recovered.error);
  const events = await ctx.store.listEvents(recovered.id);
  assert.equal(events.filter(e => e.type === 'tool.recovered').length, 1);
  assert(events.some(e => e.type === 'tool.result' && e.payload.warning === true));
  const saved = await ctx.opportunityStore.listByUser(user.id); assert.equal(saved.length, 1); assert.equal(saved[0].deadline, null);
  pass('Real SQL saved unknown date; recovered retry succeeds with failed audit retained');
  const unresolved = await run('不同机会不能冲掉错误', [
    { toolCalls: [call('bad-other', args('未完成机会', 123))] },
    { toolCalls: [call('ok-other', args('另一条成功机会'))] }, { content: '只保存了另一条机会。' },
  ]);
  assert.equal(unresolved.status, 'failed'); assert.equal(unresolved.result.certificate.criteria.find(c => c.id === 'model_reachable').passed, true);
  assert.match(unresolved.error, /仍有1次工具失败未恢复/); assert.doesNotMatch(unresolved.error, /模型不可达/);
  pass('Other-target success cannot hide an unresolved error; model connection is not misreported');
  browser = await chromium.launch(DOCUMENT_CHROMIUM_OPTIONS); page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('http://127.0.0.1:5173/login'); await page.getByLabel('邮箱', { exact: true }).fill(email); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/app'); await page.goto('http://127.0.0.1:5173/app/agent');
  await page.locator('[data-session-id]').filter({ hasText: '工具重试恢复验收' }).click({ timeout: 20000 });
  const panel = page.getByRole('complementary', { name: '任务执行面板' });
  await expect(panel).toContainText('首次失败，后续同一操作已重试成功'); await expect(panel).toContainText('检索匹配不足'); await expect(panel).toContainText('已完成');
  await page.screenshot({ path: fileURLToPath(new URL('verified.png', out)), fullPage: true });
  await page.locator('[data-session-id]').filter({ hasText: '不同机会不能冲掉错误' }).click();
  await expect(panel).toContainText('仍有1次工具失败未恢复'); await expect(panel).not.toContainText('模型不可达');
  await writeFile(new URL('result.json', out), JSON.stringify({ recovered: recovered.status, unresolved: unresolved.status, deadline: saved[0].deadline, paidModelCalls: 0 }, null, 2));
  pass('Real browser shows recovery/quality warnings and accurate unresolved-error state');
  console.log('LOCAL_TOOL_RECOVERY_VERIFIED');
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: fileURLToPath(new URL('failure.png', out)), fullPage: true }).catch(() => {}); await writeFile(new URL('failure-ui.txt', out), await page.locator('body').innerText()).catch(() => {}); }
  throw error;
} finally {
  await browser?.close();
  let cleanupError; if (user) {
    // Private opportunity.created_by is RESTRICT, not CASCADE. Remove ONLY the
    // fixture's private parents before deleting its newly generated auth user.
    await pool.query("delete from opportunities where created_by=$1 and visibility='private' and source_url=$2", [user.id, 'https://fixture.example/competition']);
    const deleted = await admin.auth.admin.deleteUser(user.id); cleanupError = deleted.error;
  }
  await pool.end(); assert(!cleanupError, 'Fixture cleanup failed');
  pass('Temporary account/data cleaned; existing accounts and old task audit untouched');
}
