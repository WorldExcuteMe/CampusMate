import {test} from "node:test";
import assert from "node:assert/strict";
import {executeCloudTool} from "./cloud-tools.ts";
test("R9 unrelated generic Bing results trigger one exact-entity search, rather than misleading the model",async t=>{
  const queries:string[]=[];
  t.mock.method(globalThis,"fetch",async(input:string|URL)=>{
    const query=new URL(String(input)).searchParams.get("q")!;queries.push(query);
    const html=queries.length===1?'<h2><a href="https://www.gfbzb.gov.cn/">中国征兵网</a></h2><div class="b_caption"><p>全国征兵服务平台</p>':'<h2><a href="https://iot.sjtu.edu.cn/Default.aspx">2026年全国大学生物联网设计竞赛</a></h2><div class="b_caption"><p>竞赛组委会</p>';
    return new Response(html,{headers:{"content-type":"text/html"}});
  });
  const result=JSON.parse(await executeCloudTool("web_search",{query:"全国大学生物联网设计竞赛 2026 官网 报名时间"}));
  assert.equal(queries.length,2);assert.equal(queries[1],'"全国大学生物联网设计竞赛"');assert.equal(result.results[0].url,"https://iot.sjtu.edu.cn/Default.aspx");assert.equal(result.attempts,2);
});
test("R9 relevant results need no extra request; escaped link query is decoded",async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response('<h2><a href="https://example.org/?a=1&amp;b=2">蓝桥杯竞赛报名</a></h2><div class="b_caption"><p>蓝桥杯报名通知</p>');});
  const result=JSON.parse(await executeCloudTool("web_search",{query:"蓝桥杯竞赛 2026 官网"}));
  assert.equal(calls,1);assert.equal(result.results[0].url,"https://example.org/?a=1&b=2");
});

test("employment portal sharing 全国大学生 cannot suppress exact-event fallback", async t => {
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    queries.push(new URL(String(input)).searchParams.get("q")!);
    return new Response(queries.length === 1
      ? '<h2><a href="https://www.ncss.cn/">国家大学生就业服务平台</a></h2><div class="b_caption"><p>全国大学生就业创业服务</p>'
      : '<h2><a href="https://example.edu/notice">全国大学生物联网设计竞赛参赛通知</a></h2>');
  });
  const result = JSON.parse(await executeCloudTool("web_search", { query: "全国大学生物联网设计竞赛官网报名时间" }));
  assert.equal(queries.length, 2);
  assert.equal(queries[1], '"全国大学生物联网设计竞赛"');
  assert.equal(result.results[0].url, "https://example.edu/notice");
});
test("R9 still-unrelated results stay empty with an uncertainty warning; HTTP errors are explicit",async t=>{
  let calls=0;const fetchMock=t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response('<h2><a href="https://example.org/">中国征兵网</a></h2>');});
  const result=JSON.parse(await executeCloudTool("web_search",{query:"物联网设计竞赛 2026 官网"}));assert.equal(calls,2);assert.deepEqual(result.results,[]);assert.match(result.warning,/不代表.*不存在/);
  fetchMock.mock.mockImplementation(async()=>new Response("blocked",{status:403}));
  const denied=JSON.parse(await executeCloudTool("web_search",{query:"物联网设计竞赛"}));assert.match(denied.error,/403/);assert.equal(denied.attempts,1);
});
