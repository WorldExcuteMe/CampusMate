import { expect, test } from '@playwright/test';

test('图片超限整批拒绝、累计计数，刷新仍保留完整4图草稿', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('campusmate.onboarded', 'true'));
  const modelRequests: string[] = [];
  await page.route('**/api/llm', route => { modelRequests.push(route.request().url()); return route.fulfill({ status: 500, json: { error: 'No model calls expected' } }); });
  await page.goto('/app/agent');
  const input = page.getByPlaceholder(/输入消息/), picker = page.locator('input[type="file"]');
  await expect(input).toBeEnabled(); await input.fill('图片必须全部保留');
  const images = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64') }));
  await picker.setInputFiles(images);
  await expect(page.getByText(/每条消息最多 4 张图片，当前共 6 张/)).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0); await expect(input).toHaveValue('图片必须全部保留');

  await picker.setInputFiles(images.slice(0, 4));
  await expect(page.getByRole('img')).toHaveCount(4);
  await expect(page.getByText('草稿按会话保存在本机，不跨设备同步', { exact: true })).toBeVisible();
  await page.reload();
  await expect(input).toHaveValue('图片必须全部保留'); await expect(page.getByRole('img')).toHaveCount(4);
  await picker.setInputFiles([images[4]]);
  await expect(page.getByText(/每条消息最多 4 张图片，当前共 5 张/)).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(4); await expect(input).toHaveValue('图片必须全部保留');
  expect(modelRequests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('image-limit.png') });
});
