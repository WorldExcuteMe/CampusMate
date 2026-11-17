import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchHits, relevantSearchHits, searchPublicWeb } from './web-search.ts';
const hit = (title: string, url = 'https://school.example/notice', snippet = '') => ({ title, url, snippet });
const html = (title: string, url = 'https://school.example/notice', snippet = '') => `<li class="b_algo"><h2 class="result"><a target="_blank" href="${url}">${title}</a></h2><div class="b_caption"><p>${snippet}</p></div></li>`;

test('中文完整主题匹配，不把只含第一个汉字的字典/百科当相关结果', () => {
  const hits = [hit('蓝（汉语文字）_百度百科'), hit('蓝色是什么颜色'), hit('蓝桥杯 - 全国大学生TMT行业赛事', 'https://dasai.lanqiao.cn')];
  assert.deepEqual(relevantSearchHits('蓝桥杯大赛 2027 报名 官网', hits).map(h => h.url), ['https://dasai.lanqiao.cn']);
  assert.equal(relevantSearchHits('中国大学生计算机设计大赛 官网', [hit('计算机设计大赛报名通知')]).length, 1);
  assert.equal(relevantSearchHits('全国大学生数学建模竞赛', [hit('全国大学生数学建模竞赛官网')]).length, 1);
  assert.equal(relevantSearchHits('Lanqiao competition official', [hit('lanqiao - 蓝桥杯大赛')]).length, 1);
});
test('site查询约束域名，不接受伪造后缀和JS/带凭证链接', () => {
  assert.equal(relevantSearchHits('site:school.example', [hit('学校首页'), hit('假学校', 'https://school.example.evil.test')]).length, 1);
  assert.equal(parseSearchHits(html('x', 'javascript:alert(1)') + html('x', 'https://user:password@evil.example'), 6).length, 0);
});
test('解析属性/实体/摘要与Bing包装链接；不重复计数', () => {
  const target = 'https://school.example/competition?a=1&b=2', wrapped = 'https://www.bing.com/ck/a?u=a1' + Buffer.from(target).toString('base64url');
  const hits = parseSearchHits(html('蓝桥杯 &amp; &#x4E2D;文', wrapped, '<b>报名</b>通知') + html('重复', wrapped), 6);
  assert.equal(hits.length, 1); assert.equal(hits[0].url, target); assert.equal(hits[0].title, '蓝桥杯 & 中文'); assert.equal(hits[0].snippet, '报名 通知');
});
test('HTTP错误、无法解析、低相关结果不再伪装成正常的五条结果', async () => {
  const failed = await searchPublicWeb('蓝桥杯', 5, async () => new Response('rate limited', { status: 429 })); assert.match(failed.error ?? '', /429/);
  const empty = await searchPublicWeb('蓝桥杯', 5, async () => new Response('<html>challenge</html>')); assert.equal(empty.quality, 'degraded'); assert.deepEqual(empty.results, []);
  const polluted = await searchPublicWeb('蓝桥杯大赛', 5, async () => new Response(html('蓝（汉语文字）'))); assert.equal(polluted.quality, 'degraded'); assert.equal(polluted.rejectedCount, 1); assert.deepEqual(polluted.results, []);
  const good = await searchPublicWeb('蓝桥杯大赛', 5, async () => new Response(html('蓝桥杯官网'))); assert.equal(good.results.length, 1); assert.equal(good.warning, undefined);
});
test('有相关结果时只保留相关条目；超大响应/请求失败明确返回错误', async () => {
  const mixed = await searchPublicWeb('蓝桥杯', 6, async () => new Response(html('蓝色定义') + html('蓝桥杯官网', 'https://lanqiao.example'))); assert.equal(mixed.quality, 'filtered'); assert.equal(mixed.results.length, 1);
  const huge = await searchPublicWeb('蓝桥杯', 6, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))); assert.ok(huge.error); assert.deepEqual(huge.results, []);
  const thrown = await searchPublicWeb('蓝桥杯', 6, async () => { throw Error('secret token in transport error'); }); assert.ok(thrown.error); assert.doesNotMatch(thrown.error, /secret/);
});
