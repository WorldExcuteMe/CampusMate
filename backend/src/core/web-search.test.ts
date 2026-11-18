import {test} from "node:test";
import assert from "node:assert/strict";
import {executeCloudTool} from "./cloud-tools.ts";
test("broad contest discovery rejects year-calendar drift instead of accepting it as source quota",async t=>{
  t.mock.method(globalThis,"fetch",async()=>new Response('<h2><a href="https://www.gov.cn/holiday.html">国务院2026年节假日安排</a></h2><h2><a href="https://football.example/">2026国际足联世界杯比赛赛程</a></h2><h2><a href="https://icpc.pku.edu.cn/">ICPC International Collegiate Programming Contest</a></h2>'));
  const result=JSON.parse(await executeCloudTool("web_search",{query:"2026年大学生计算机竞赛 官网"}));
  assert.equal(result.results.length,1); assert.equal(result.results[0].url,"https://icpc.pku.edu.cn/");
});
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

test("short contest name is retained when the first search drifts to enrollment pages", async t => {
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    queries.push(new URL(String(input)).searchParams.get("q")!);
    return new Response(queries.length === 1 ? '<h2><a href="https://gaokao.chsi.com.cn/">2026高考报名时间</a></h2>' : '<h2><a href="https://dasai.lanqiao.cn/">蓝桥杯官网</a></h2>');
  });
  const result = JSON.parse(await executeCloudTool("web_search", { query: "2026 蓝桥杯 报名时间 官网" }));
  assert.deepEqual(queries, ["2026 蓝桥杯 报名时间 官网", '"蓝桥杯"']); assert.equal(result.results[0].title, "蓝桥杯官网");
});

test("compound English queries retain subject terms in the fallback and reject single-qualifier drift", async t => {
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    queries.push(new URL(String(input)).searchParams.get("q")!);
    const unrelated = '<h2><a href="https://example.org/access">Open access license guide</a></h2>';
    const relevant = '<h2><a href="https://example.edu/transit">Transit deserts and bicycle infrastructure</a></h2>';
    return new Response(queries.length === 1 ? unrelated : unrelated + relevant);
  });
  const result = JSON.parse(await executeCloudTool("web_search", { query: 'urban transit bicycle infrastructure "open access" filetype:pdf' }));
  assert.equal(queries.length, 2);
  assert.match(queries[1], /transit.*bicycle.*infrastructure/);
  assert.deepEqual(result.results.map((hit: { url: string }) => hit.url), ["https://example.edu/transit"]);
});

test("scholarly search returns DOI metadata leads through the same authorized search tool", async t => {
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.crossref.org");
    assert.equal(url.searchParams.get("query.bibliographic"), "transit deserts");
    assert.equal(url.searchParams.get("filter"), "from-pub-date:2021-01-01");
    return Response.json({ message: { items: [
      { DOI: "10.1234/a/b", title: ["Transit deserts"], published: { "date-parts": [[2024]] } },
      { DOI: "", title: ["Record without an identifier"] },
    ] } });
  });
  const result = JSON.parse(await executeCloudTool("web_search", { query: "transit deserts", scope: "scholarly", fromYear: 2021 }));
  assert.equal(result.engine, "crossref");
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], { title: "Transit deserts", url: "https://doi.org/10.1234/a/b", doi: "10.1234/a/b", year: 2024, snippet: "" });
  assert.equal(result.evidence, "metadata");
});

test("open scholarly search returns readable-source candidates without promoting metadata to evidence", async t => {
  let endpoint = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    endpoint = url.origin;
    assert.equal(url.searchParams.get("search"), "urban transport");
    assert.equal(url.searchParams.get("filter"), "is_oa:true,from_publication_date:2021-01-01");
    return Response.json({ results: [
      { display_name: "Urban transport", doi: "https://doi.org/10.1234/a", publication_year: 2024, best_oa_location: { landing_page_url: "https://journal.example/transport", is_oa: true } },
      { display_name: "Duplicate copy", best_oa_location: { landing_page_url: "https://journal.example/transport", is_oa: true } },
      { display_name: "Index entry only", best_oa_location: { landing_page_url: "https://doi.org/10.1234/b", is_oa: true } },
      { display_name: "Credentialed link", best_oa_location: { landing_page_url: "https://user:pass@journal.example/missing", is_oa: true } },
    ] });
  });
  const result = JSON.parse(await executeCloudTool("web_search", { query: "urban transport", scope: "scholarly", fromYear: 2021, openAccessOnly: true }));
  assert.equal(endpoint, "https://api.openalex.org");
  assert.equal(result.evidence, "metadata");
  assert.deepEqual(result.results.map((hit: { url: string }) => hit.url), ["https://journal.example/transport"]);
  assert.equal(result.results[0].sourceId, undefined);
});

test("open scholarly search exposes a distinct public repository entry for the same work", async t => {
  t.mock.method(globalThis, "fetch", async (input: string | URL) => {
    assert.match(new URL(String(input)).searchParams.get("select") ?? "", /locations/);
    return Response.json({ results: [{
      display_name: "Public procurement",
      best_oa_location: { landing_page_url: "https://publisher.example/article", is_oa: true },
      locations: [
        { landing_page_url: "https://publisher.example/article", is_oa: true },
        { landing_page_url: "https://repo.example/manuscript", is_oa: true },
        { landing_page_url: "https://repo.example/restricted", is_oa: false },
      ],
    }] });
  });
  const result = JSON.parse(await executeCloudTool("web_search", { query: "Public procurement", scope: "scholarly", openAccessOnly: true }));
  assert.equal(result.results[0]?.alternativeUrl, "https://repo.example/manuscript");
  assert.equal(result.results[0]?.sourceId, undefined);
});
