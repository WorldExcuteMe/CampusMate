import {test,expect} from '@playwright/test';
test('80轮先加载30轮，旧页与增量并发不漏不重复、用量不倒退且保持滚动位置',async({page,request},info)=>{
  const seeded=await (await request.post('http://127.0.0.1:8738/fixture/history',{data:{}})).json();
  await page.goto('/login');await page.locator('input[type="email"]').fill('fixture@campusmate.test');await page.locator('input[type="password"]').fill('fixture-only-password');
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page).toHaveURL(/\/app$/);
  const requests:string[]=[];page.on('request',req=>{if(req.url().includes('/history'))requests.push(req.url());});
  await page.goto('/app/agent');
  await expect(page.getByText('分页回答79',{exact:true})).toBeVisible();await expect(page.getByText('分页问题0',{exact:true})).toHaveCount(0);
  await expect(page.locator('[data-message-key]')).toHaveCount(60);
  const older=page.getByRole('button',{name:'加载更早消息',exact:true});await older.scrollIntoViewIfNeeded();
  const anchor=page.getByText('分页问题50',{exact:true});const before=await anchor.evaluate(el=>el.getBoundingClientRect().top);
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});let held=false;
  await page.route('**/history/page?*',async route=>{
    if(!held && new URL(route.request().url()).searchParams.has('before')){held=true;const response=await route.fetch();started();await gate;await route.fulfill({response});}
    else await route.continue();
  });
  try {
    await older.click();await ready;
    await request.post('http://127.0.0.1:8738/fixture/history',{data:{op:'update',id:seeded.id}});
    await expect(page.getByText('分页最后回答已更新',{exact:true})).toBeVisible({timeout:15_000});
  } finally {release?.();}
  await expect(page.getByText('分页问题20',{exact:true})).toBeVisible();await expect(page.locator('[data-message-key]')).toHaveCount(120);
  expect(Math.abs(await anchor.evaluate(el=>el.getBoundingClientRect().top)-before)).toBeLessThan(4);
  await expect(page.getByText(/累计 3,167 tok/)).toBeVisible();
  await older.scrollIntoViewIfNeeded();await older.click();
  await expect(page.getByText('分页问题0',{exact:true})).toBeVisible();await expect(page.locator('[data-message-key]')).toHaveCount(160);await expect(older).toHaveCount(0);
  await expect(page.getByText('分页最后回答已更新',{exact:true})).toHaveCount(1);await expect(page.getByText(/累计 3,167 tok/)).toBeVisible();
  expect(requests.some(url=>new URL(url).pathname.endsWith('/history'))).toBe(false);expect(requests.some(url=>url.includes('/history/changes?'))).toBe(true);
  await page.screenshot({path:info.outputPath('history-pagination.png')});
});
