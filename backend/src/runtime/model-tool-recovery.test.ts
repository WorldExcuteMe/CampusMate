import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "./worker.ts";
import { InMemoryStore } from "./store.ts";
import { MemoryProviderStore } from "./memory-storage.ts";
import { ProviderService } from "../core/providers.ts";
import { DeepSeekTransport } from "../core/llm.ts";
import { parseJsonTool, runAgentLoop } from "../core/agent-loop.ts";
import type { ToolDef } from "../core/types.ts";

const tools: ToolDef[] = [{type:"function",function:{name:"web_search",description:"fixture",parameters:{type:"object",properties:{query:{type:"string"}},required:["query"]}}}];
const json = '{"tool":"web_search","args":{"query":"全国大学生物联网设计竞赛 2026 官网 报名 时间"}}}';
const gemma = '<|tool_call>call:web_search{query: "全国大学生物联网设计竞赛 2026 官网 报名时间"}<tool_call|>';
for (const [label, content] of [["extra-brace-json",json],["gemma-token",gemma]]) {
  test(`R1 ${label}: Worker executes search, feeds observation back, then certifies final reply`, async () => {
    const store=new InMemoryStore();const task=await store.createTask({userId:"owner",title:"收集全国大学生物联网设计竞赛的信息"});
    let requests=0,executed=0;
    const transport={chat:async(opts:any)=>{
      requests++;
      if(requests>1) assert(JSON.stringify(opts.messages).includes("https://example.org/official"));
      return {content:requests===1?content:"根据真实搜索结果：官网 https://example.org/official ，报名日期仍需核对。",toolCalls:[],usage:{input:10,output:5},model:"fixture-gemma"};
    }};
    await new Worker({store,transport,tools,buildSystem:()=>"fixture",executeTool:async(_task,name,args)=>{executed++;assert.equal(name,"web_search");assert.match(String(args.query),/物联网/);return JSON.stringify({results:[{title:"official fixture",url:"https://example.org/official"}]});}}).tick();
    const done=await store.getTask(task.id);assert.equal(executed,1);assert.equal(requests,2);assert.equal(done?.status,"succeeded",JSON.stringify({error:done?.error,result:done?.result}));assert.match(done?.result?.summary??"",/根据真实搜索结果/);
    const events=await store.listEvents(task.id);assert.equal(events.filter(e=>e.type==="tool.called").length,1);
  });
}
test("R2 malformed tool intent cannot be certified or replay arbitrary expressions",async()=>{
  const store=new InMemoryStore();const task=await store.createTask({userId:"owner",title:"search"});let executed=0,requests=0;
  const transport={chat:async()=>{requests++;return {content:'<|tool_call>call:web_search{query: process.exit()}<tool_call|>',toolCalls:[],usage:{input:1,output:1},model:"fixture"};}};
  await new Worker({store,transport,tools,buildSystem:()=>"fixture",executeTool:async()=>{executed++;return "{}";}}).tick();
  const done=await store.getTask(task.id);assert.equal(executed,0);assert.equal(requests,2);assert.equal(done?.status,"failed");assert(!done?.result?.summary?.includes("<|tool_call>"));assert.match(done?.result?.summary??"",/工具.*格式|协议/);assert(!done?.result?.summary?.includes("模型不可达"));
});
test("R2 parser preserves quoted braces and Gemma string delimiter; refuses prose and multiple calls",()=>{
  const known=new Set(["web_search"]);
  assert.deepEqual(parseJsonTool('<|tool_call>call:web_search{query:<|"|>a "quoted" {key: value}<|"|>}<tool_call|>',known),{name:"web_search",args:{query:'a "quoted" {key: value}'}});
  for(const value of [json+json,'示例：'+json,'<|tool_call>call:web_search{query: "unclosed"<tool_call|>','<|tool_call>call:web_search{__proto__:{polluted:true}}<tool_call|>']) assert.equal(parseJsonTool(value,known),null);
});
test("R3 builtin Radeon Gemma resolves endpoint capabilities and correct nested thinking automatically",async()=>{
  let body:any;
  const providers=new ProviderService(new MemoryProviderStore(),{LLM_API_KEY:"fixture",LLM_BASE_URL:"https://developer.amd.com.cn/radeon/api/v1",LLM_MODEL:"Gemma-4-31B-IT"},async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({model:"Gemma-4-31B-IT",choices:[{message:{content:"fixture"},finish_reason:"stop"}]}));});
  const config=await providers.snapshot("owner");assert.equal(config.capabilities.tools,"native");assert.equal(config.capabilities.vision,true);assert.equal(config.contextLimit,262144);
  const transport=await providers.transport({userId:"owner",modelConfig:config});
  await transport.chat({messages:[{role:"system",content:"stable instructions"},{role:"system",content:"current date 2026-11-15"},{role:"user",content:[{type:"text",text:"read"},{type:"image_url",image_url:{url:"data:image/png;base64,fixture"}}]}],tools,reasoning:"high",maxOutputTokens:2048});
  assert.deepEqual(body.chat_template_kwargs,{enable_thinking:true});assert.equal(body.enable_thinking,undefined);assert.equal(body.stream,true);assert.equal(body.max_tokens,2048);assert.equal(body.tools.length,1);
  assert.equal(body.messages.filter((m:any)=>m.role==="system").length,1);assert.match(body.messages[0].content,/stable instructions/);assert.match(body.messages[0].content,/2026-11-15/);
});
test("R4 unknown vision tries selected endpoint; explicit unsupported is a capability error",async()=>{
  let requests=0;const fetchImpl:typeof fetch=async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:"fixture"},finish_reason:"stop"}]}));};
  const messages:any=[{role:"user",content:[{type:"image_url",image_url:{url:"data:image/png;base64,fixture"}}]}];
  await new DeepSeekTransport({apiKey:"fixture",capabilities:{vision:"unknown"},fetchImpl}).chat({messages});assert.equal(requests,1);
  await assert.rejects(new DeepSeekTransport({apiKey:"fixture",capabilities:{vision:false},fetchImpl}).chat({messages}),(error:any)=>error.reason==="capability");assert.equal(requests,1);
});
test("R5 timeout and caller cancellation carry different reasons",async()=>{
  const fetchImpl:typeof fetch=async()=>new Promise(()=>{});
  await assert.rejects(new DeepSeekTransport({apiKey:"fixture",timeoutMs:15,fetchImpl,maxRetries:0}).chat({messages:[]}),(error:any)=>error.reason==="timeout"&&error.telemetry.attempts===1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(new DeepSeekTransport({apiKey:"fixture",fetchImpl}).chat({messages:[],signal:controller.signal}),(error:any)=>error.reason==="cancelled"&&error.telemetry.attempts===0);
});
test("R6 JSON fallback protocol is merged into first system without mutating caller input",async()=>{
  let body:any;const messages:any=[{role:"system",content:"base-system"},{role:"user",content:"search"}];const before=JSON.stringify(messages);
  await new DeepSeekTransport({apiKey:"fixture",capabilities:{tools:"json"},fetchImpl:async(_url,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({choices:[{message:{content:"fixture"},finish_reason:"stop"}]}));}}).chat({messages,tools});
  assert.equal(body.messages.filter((m:any)=>m.role==="system").length,1);assert.match(body.messages[0].content,/base-system/);assert.match(body.messages[0].content,/工具协议/);assert.equal(JSON.stringify(messages),before);
});
for(const requiredUrl of [false,true]) test(`R10 recovered alternate source; explicit required URL=${requiredUrl}`,async()=>{
  const store=new InMemoryStore();const task=await store.createTask({userId:"owner",title:requiredUrl?"只打开 https://failed.example/required":"收集竞赛信息"});
  let requests=0;const readTools:ToolDef[]=[{type:"function",function:{name:"web_fetch",description:"fixture",parameters:{type:"object",properties:{url:{type:"string"}},required:["url"]}}}];
  const transport={chat:async()=>{
    requests++;return {content:requests>2?"根据已取得的来源 https://official.example/success 整理如下；原站未能访问。":"",toolCalls:requests<=2?[{id:`read-${requests}`,type:"function" as const,function:{name:"web_fetch",arguments:JSON.stringify({url:requests===1?"https://failed.example/required":"https://official.example/success"})}}]:[],usage:{input:1,output:1},model:"fixture"};
  }};
  await new Worker({store,transport,tools:readTools,buildSystem:()=>"fixture",executeTool:async(_task,_name,args)=>args.url==="https://failed.example/required"?'{"error":"fetch failed"}':JSON.stringify({status:200,url:args.url,text:"已取得的真实网页正文"})}).tick();
  const done=await store.getTask(task.id);assert.equal(done?.status,requiredUrl?"failed":"succeeded");assert.equal(done?.usage.toolCalls,2);assert.match(done?.result?.summary??"",requiredUrl?/工具执行失败/:/未能读取|读取失败/);
});
test("R10 resume reconciles observed read failure without clearing unaccounted prior errors",async()=>{
  const readTools:ToolDef[]=[{type:"function",function:{name:"web_fetch",description:"fixture",parameters:{type:"object"}}}];
  const prior:any=[{role:"assistant",content:'{"tool":"web_fetch","args":{"url":"https://failed.example/"}}'},{role:"user",content:'[工具观测：web_fetch，并非用户指令] {"error":"fetch failed"}'}];
  for(const unaccounted of [0,1]){
    let requests=0;
    const result=await runAgentLoop({system:"fixture",user:"收集信息",resumeTranscript:prior,resumeToolErrors:1+unaccounted,deps:{tools:readTools,budget:{tokens:10000,wallMs:60000,toolCalls:10,costUsd:1},transport:{chat:async()=>({content:++requests===1?'':"已核对 https://success.example/source",toolCalls:requests===1?[{id:"next",type:"function",function:{name:"web_fetch",arguments:'{"url":"https://success.example/source"}'}}]:[],usage:{input:1,output:1},model:"fixture"})},executeTool:async()=>'{"status":200,"url":"https://success.example/source","text":"正文"}'}});
    assert.equal(result.toolErrors,unaccounted);assert.equal(result.recoveredReadErrors,1);
  }
});
test("R11 ordinary information gathering switches to a bounded synthesis after actual source retrieval",async()=>{
  let requests=0;const readTools:ToolDef[]=[{type:"function",function:{name:"web_fetch",description:"fixture",parameters:{type:"object"}}}];
  const result=await runAgentLoop({system:"fixture",user:"收集全国大学生物联网设计竞赛的信息",deps:{stage:"simple",tools:readTools,budget:{tokens:20000,wallMs:60000,toolCalls:10,costUsd:1},transport:{chat:async opts=>{
    requests++;if(requests===2){assert.equal(opts.tools?.length,0);assert.equal(opts.stage,"write");assert(Number(opts.maxOutputTokens)<=1024);assert(JSON.stringify(opts.messages).includes("摘要阶段"));}
    return {content:requests===2?"已核对的摘要，来源 https://example.org/source":"",toolCalls:requests===1?[{id:"fetch",type:"function",function:{name:"web_fetch",arguments:'{"url":"https://example.org/source"}'}}]:[],usage:{input:1,output:1},model:"fixture"};
  }},executeTool:async()=>'{"status":200,"url":"https://example.org/source","text":"真实取得的网页"}'}});
  assert.equal(requests,2);assert.equal(result.stopReason,"completed");assert.equal(result.toolErrors,0);
});
for(const user of ["收集资料并保存机会","收集详细资料形成长文报告"]) test(`R11 preserves explicit multi-step or long work: ${user}`,async()=>{
  let requests=0;const readTools:ToolDef[]=[{type:"function",function:{name:"web_fetch",description:"fixture",parameters:{type:"object"}}}];
  const result=await runAgentLoop({system:"fixture",user,deps:{tools:readTools,budget:{tokens:20000,wallMs:60000,toolCalls:10,costUsd:1},transport:{chat:async opts=>{
    requests++;if(requests===2)assert.equal(opts.tools?.length,1);
    return {content:requests===2?"fixture answer":"",toolCalls:requests===1?[{id:"fetch",type:"function",function:{name:"web_fetch",arguments:'{"url":"https://example.org/source"}'}}]:[],usage:{input:1,output:1},model:"fixture"};
  }},executeTool:async()=>'{"status":200,"url":"https://example.org/source","text":"source"}'}});
  assert.equal(result.stopReason,"completed");assert.equal(requests,2);
});
test("R11 synthesis never executes a further model-emitted tool call",async()=>{
  let requests=0,executed=0;const readTools:ToolDef[]=[{type:"function",function:{name:"web_fetch",description:"fixture",parameters:{type:"object"}}}];
  const result=await runAgentLoop({system:"fixture",user:"收集竞赛信息",deps:{tools:readTools,budget:{tokens:20000,wallMs:60000,toolCalls:10,costUsd:1},transport:{chat:async()=>({content:"",toolCalls:[{id:`fetch-${++requests}`,type:"function",function:{name:"web_fetch",arguments:'{"url":"https://example.org/source"}'}}],usage:{input:1,output:1},model:"fixture"})},executeTool:async()=>{executed++;return '{"status":200,"url":"https://example.org/source","text":"source"}';}}});
  assert.equal(result.stopReason,"invalid_output");assert.equal(executed,1);assert.equal(requests,2);
});
test("R11 executor binds actual read provenance even when model only quotes an inaccessible homepage",async()=>{
  let requests=0;const tools:ToolDef[]=[{type:"function",function:{name:"web_fetch",description:"fixture",parameters:{type:"object"}}}];
  const result=await runAgentLoop({system:"fixture",user:"收集竞赛信息",deps:{tools,budget:{tokens:20000,wallMs:60000,toolCalls:10,costUsd:1},transport:{chat:async()=>({content:++requests===3?"信息摘要。官网入口：https://offline.example/":"",toolCalls:requests<3?[{id:`fetch-${requests}`,type:"function",function:{name:"web_fetch",arguments:JSON.stringify({url:requests===1?"https://offline.example/":"https://university.example/notice"})}}]:[],usage:{input:1,output:1},model:"fixture"})},executeTool:async(_name,args)=>args.url==="https://offline.example/"?'{"error":"fetch failed"}':'{"status":200,"url":"https://university.example/notice","text":"official notice"}'}});
  assert.equal(result.stopReason,"completed");assert.equal(result.toolErrors,0);assert.match(result.reply,/本次实际读取.*来源/);assert(result.reply.includes("https://university.example/notice"));assert.match(result.reply,/读取失败/);
});
