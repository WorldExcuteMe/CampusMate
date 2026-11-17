import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

async function open(page: Page) {
  await page.addInitScript(() => localStorage.setItem('campusmate.onboarded', 'true'));
  await page.route(/\/(?:api|functions\/v1\/app)\/providers$/, route => route.fulfill({ json: { providers: [{ id: 'fixture', name: '测试模型', model: 'fixture', hasKey: true }] } }));
  await page.goto('/app/agent'); await expect(page.getByPlaceholder(/输入消息/)).toBeEnabled();
}
async function word(text: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return { name: 'normal.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await zip.generateAsync({ type: 'nodebuffer' }) };
}
function pdf(pages: number) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 12 Tf 40 760 Td (pdf-fixture-page-${i + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let data = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return { name: `${pages}-pages.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(data) };
}

test('EXE、32MB和9个附件整批拒绝，原文字与合法附件不被覆盖', async ({ page }) => {
  await open(page);
  const picker = page.locator('input[type="file"]'), input = page.getByPlaceholder(/输入消息/);
  await input.fill('不要清空我的草稿');
  await picker.setInputFiles([{ name: 'ok.txt', mimeType: 'text/plain', buffer: Buffer.from('原来的附件') }]);
  await expect(page.getByText('ok.txt', { exact: true })).toBeVisible();
  await picker.setInputFiles([{ name: 'app.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('binary') }]);
  await expect(page.getByText(/不支持附件「app.exe」/)).toBeVisible();
  await picker.setInputFiles([{ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(32 * 1024 ** 2) }]);
  await expect(page.getByText(/large.txt.*超过单文件5MB/)).toBeVisible();
  await picker.setInputFiles(Array.from({ length: 8 }, (_, i) => ({ name: `${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') })));
  await expect(page.getByText(/每条消息最多8个附件/)).toBeVisible();
  await expect(input).toHaveValue('不要清空我的草稿'); await expect(page.getByRole('button', { name: /^移除附件/ })).toHaveCount(1);
});

test('真实PDF/DOCX后台Worker解析成功，发送包含两份完整正文', async ({ page }) => {
  await open(page); const requests: Record<string, any>[] = [];
  await page.route(/\/(?:api|functions\/v1\/app)\/llm$/, route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { model: 'fixture', choices: [{ message: { content: '两份附件均已收到。' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  });
  await page.locator('input[type="file"]').setInputFiles([await word('docx-fixture-完整中文正文'), pdf(2)]);
  await expect(page.getByRole('button', { name: /^移除附件/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByPlaceholder(/输入消息/).fill('请概括两份附件'); await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('两份附件均已收到。', { exact: true })).toBeVisible();
  const messages = JSON.stringify(requests[0].messages);
  for (const text of ['docx-fixture-完整中文正文', 'pdf-fixture-page-1', 'pdf-fixture-page-2']) expect(messages).toContain(text);
});

test('51页PDF与过长文档明确报错，不能发送且刷新后原文字/错误附件保留', async ({ page }, testInfo) => {
  await open(page); let calls = 0;
  await page.route(/\/(?:api|functions\/v1\/app)\/llm$/, route => { calls++; return route.fulfill({ status: 500 }); });
  const input = page.getByPlaceholder(/输入消息/); await input.fill('保留这段草稿');
  await page.locator('input[type="file"]').setInputFiles([pdf(51), { name: 'long.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(100_001)) }]);
  await expect(page.getByText(/PDF超过50页/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/文档超过10万字符/)).toBeVisible();
  await input.press('Enter'); expect(calls).toBe(0); await expect(input).toHaveValue('保留这段草稿');
  await expect(page.getByText('草稿按会话保存在本机，不跨设备同步', { exact: true })).toBeVisible();
  await page.reload(); await expect(input).toHaveValue('保留这段草稿');
  await expect(page.getByText(/PDF超过50页/)).toBeVisible(); await expect(page.getByRole('button', { name: /^移除附件/ })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('attachment-budget.png') });
});
