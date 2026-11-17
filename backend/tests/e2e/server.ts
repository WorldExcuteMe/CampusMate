// Local integration fixture only. Does not import load-env or accept remote listeners.
import http from "node:http";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildContext, createApiServer } from "../../src/app-context.ts";
import { Worker } from "../../src/runtime/worker.ts";
import { CLOUD_TOOLS, executeCloudTool } from "../../src/core/cloud-tools.ts";
import { CAMPUS_SYSTEM } from "../../src/core/system-prompt.ts";
import { verifySupabaseJwt } from "../../src/api/jwt.ts";
import { localParts, monday, addDays } from "../../../shared/calendar.ts";

const OWNER = "11111111-aaaa-4111-8111-111111111111";
const SECRET = "campusmate-local-e2e-fixture-secret", ORIGIN = "http://127.0.0.1:8738";
const caps = { tools:"native", vision:false, streaming:true, reasoning:"reasoning_effort", temperature:true, outputParameter:"max_tokens" };
const fixtureFetch: typeof fetch = (url, init) => {
  const parsed = new URL(String(url));
  if (parsed.hostname !== "fixture.example") throw new Error("Fixture blocks external provider traffic");
  return fetch(ORIGIN + parsed.pathname, init);
};
const ctx = buildContext({ NODE_ENV:"test", LLM_API_KEY:"fixture-server-key", LLM_MODEL:"fixture-gemma", LLM_DISPLAY_NAME:"离线验收 Gemma", LLM_BASE_URL:"https://fixture.example/v1", LLM_CAPABILITIES:JSON.stringify(caps), LLM_CONTEXT_LIMIT:"65536", PROVIDER_MASTER_KEY:Buffer.alloc(32,7).toString("base64") }, {providerFetch:fixtureFetch});
const today = localParts(Date.now(), "Asia/Shanghai").date;
await ctx.personalContext.createTerm({userId:OWNER,institutionId:"fixture-school",name:"离线集成学期",startDate:addDays(monday(today),-70),endDate:addDays(today,70),weekAnchor:addDays(monday(today),-70),totalWeeks:24,timezone:"Asia/Shanghai"});
const sourceUrl = "https://school.example/competition";
const sourceId = "S" + createHash("sha256").update(sourceUrl).digest("hex").slice(0,10);
const metrics: {model:string; reasoning:unknown; stage:string; identity:boolean}[] = [];
const historyFixtures=new Map<string,string[]>();
const profile = {id:OWNER,name:"界面测试同学",major:"",grade:"",interests:[],skills:[],goals:[],time_budget_hours:8,bio:"离线虚构身份"};
const inbox=["离线夹具：校园创新竞赛项目征集与团队报名材料说明","离线夹具：图书馆开源交流活动"].map((title,index)=>({id:randomUUID(),user_id:OWNER,raw_text:title+"\n这是虚构的界面验收材料，仅用于检查通知层级、原文预览和长标题换行，不代表真实活动。",source_type:"text",source_url:null,created_at:new Date().toISOString(),status:"pending_review",extracted:{title,summary:"先核对报名条件与材料，再安排下一步行动。",org:"界面验收示例学校",category:index?"activity":"competition",deadline:addDays(today,4),location:"示例校区",requirements:[],materials:["项目策划书","团队信息"],riskFlags:[],missingFields:[],conditions:[]},classification:{class:index?"worth_watching":"high_value",priorityScore:index?60:85,priorityReason:"测试材料与项目目标相关，请核对原文。",riskSignals:[]}}));
const jwt = (id:string) => {
  const head = Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const body = Buffer.from(JSON.stringify({sub:id,role:"authenticated",aud:"authenticated",email:"fixture@campusmate.test",exp:Math.floor(Date.now()/1000)+3600})).toString("base64url");
  return head+"."+body+"."+createHmac("sha256",SECRET).update(head+"."+body).digest("base64url");
};
function json(res:http.ServerResponse, code:number, value:unknown) {res.writeHead(code,{"content-type":"application/json"});res.end(JSON.stringify(value));}
async function body(req:http.IncomingMessage) {let raw="";for await(const chunk of req) raw+=chunk;return raw ? JSON.parse(raw) : {};}
const delay = (ms:number) => new Promise(r=>setTimeout(r,ms));
const fixture = http.createServer(async (req,res) => {
  res.setHeader("Access-Control-Allow-Origin","http://127.0.0.1:5188");
  res.setHeader("Access-Control-Allow-Headers","authorization,apikey,content-type,x-client-info,x-supabase-api-version,accept-profile,content-profile,prefer,range");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,PATCH,DELETE,OPTIONS");
  if(req.method === "OPTIONS") {res.writeHead(204);res.end();return;}
  const url = new URL(req.url!,ORIGIN);
  try {
    if(url.pathname === "/fixture/metrics") return json(res,200,{metrics,today});
    if(url.pathname==='/fixture/history' && req.method==='POST') {
      const input=await body(req);
      if(input.op==='update') {
        const ids=historyFixtures.get(input.id);if(!ids)return json(res,404,{error:'Unknown fixture'});
        const task=await ctx.store.getTask(ids.at(-1)!);
        await ctx.store.updateTask(task!.id,{result:{summary:'分页最后回答已更新',artifactIds:[]},usage:{tokens:86,toolCalls:0,wallMs:0,costUsd:0}});
        return json(res,200,{ok:true});
      }
      const session=await ctx.sessionStore.create({userId:OWNER,title:'分页验收80轮'}),ids:string[]=[];
      for(let i=0;i<80;i++) {
        const task=await ctx.store.createTask({userId:OWNER,sessionId:session.id,turnId:randomUUID(),turnSeq:i+1,title:`分页轮${i}`,intent:`分页问题${i}`});
        await ctx.store.updateTask(task.id,{status:'running'});
        await ctx.store.updateTask(task.id,{status:'succeeded',transcriptCommitted:true,result:{summary:`分页回答${i}`,artifactIds:[]},usage:{tokens:i,toolCalls:0,wallMs:0,costUsd:0}});ids.push(task.id);
      }
      historyFixtures.set(session.id,ids);return json(res,200,{id:session.id,title:session.title});
    }
    if(url.pathname === "/auth/v1/token") {
      const input=await body(req); if(input.email !== "fixture@campusmate.test" || input.password !== "fixture-only-password") return json(res,400,{msg:"Fixture credentials required"});
      return json(res,200,{access_token:jwt(OWNER),refresh_token:"fixture-refresh",token_type:"bearer",expires_in:3600,user:{id:OWNER,aud:"authenticated",role:"authenticated",email:input.email,app_metadata:{provider:"email"},user_metadata:{},created_at:new Date().toISOString()}});
    }
    if(url.pathname === "/auth/v1/user") return json(res,200,{id:OWNER,aud:"authenticated",email:"fixture@campusmate.test",app_metadata:{},user_metadata:{}});
    if(url.pathname === "/auth/v1/logout") return json(res,200,{});
    if(url.pathname.startsWith("/rest/v1/")) {
      if(verifySupabaseJwt(String(req.headers.authorization??"").replace(/^Bearer /,""),SECRET)?.sub !== OWNER) return json(res,401,{message:"fixture auth required"});
      if(url.pathname === "/rest/v1/profiles") {
        if(req.method !== "GET") Object.assign(profile,await body(req));
        return json(res,200,profile);
      }
      if(url.pathname === "/rest/v1/inbox_items") return json(res,200,inbox);
      return json(res,200,[]);
    }
    if(url.pathname === "/v1/chat/completions") {
      const input = await body(req), messages=input.messages as {role:string;content:unknown;tool_calls?:unknown[]}[];
      const lastUser = [...messages].reverse().find(m=>m.role === "user" && String(m.content).includes("[document-stage:")) ?? [...messages].reverse().find(m=>m.role === "user");
      const prompt=String(lastUser?.content??""), stage=prompt.match(/\[document-stage:([^\]]+)\]/)?.[1]??"chat";
      const identity=messages.some(m=>String(m.content).includes("我是计算机专业大二学生"));
      metrics.push({model:input.model,reasoning:input.reasoning_effort,stage,identity});
      if(prompt.includes("故意失败")) return json(res,400,{error:{message:"离线故障夹具：拒绝此请求"}});
      if(prompt.includes("取消演示")) await delay(7000);
      let content="", calls:unknown[]=[];
      if(stage === "research") {
        if(messages.at(-1)?.role !== "tool") calls=[{id:randomUUID(),type:"function",function:{name:"web_fetch",arguments:JSON.stringify({url:sourceUrl})}}];
        else content="已取得离线主办方资料，下面按资料、提纲和分章正文产出。引用仅代表测试材料，预算和可行性待核对。";
      } else if(stage === "outline") content=JSON.stringify({title:"CampusMate校园信息助手项目策划书",outline:"围绕校园通知分散与机会筛选的实际问题，先验证信息整理和来源留存，再逐步完成课表、任务及文档交付。各章分别描述目标、技术、分工、进度、预算和风险，并明确验收标准。"});
      else if(stage.startsWith("chapter-")) {
        await delay(300);
        content=JSON.stringify({blocks:[{type:"paragraph",claimType:"proposal",sourceIds:[sourceId],text:"本章提出可验证的校园信息助手实施方案。"+"团队先访谈学生并整理通知样本，再实现带来源的信息收集、结构化课表、可追踪任务与文档交付。每周以固定样本验收完整性、错误提示和权限隔离，记录反馈并调整范围。费用为初步估算，团队分工、数据授权与学校具体要求仍需人工确认。".repeat(2)},{type:"table",claimType:"proposal",headers:["阶段","工作","验收"],rows:[["第一周","调研与原型","真实场景样本"],["第二周","接入与联调","任务和下载记录"]]}]});
      } else if(prompt.includes("推荐")) content=identity?"基于你已提供的计算机专业大二、Python和每周8小时，建议选择校园创新竞赛的信息助手方向；具体报名资格与截止时间仍需核对官方通知。":"缺少身份信息，请补充专业和年级。";
      else content="已记录你的计算机专业大二身份和每周8小时约束。";
      const choice={message:{role:"assistant",content,tool_calls:calls},finish_reason:calls.length?"tool_calls":"stop"};
      if(!input.stream) return json(res,200,{model:"fixture-actual-gemma",choices:[choice],usage:{prompt_tokens:120,completion_tokens:60,prompt_tokens_details:{cached_tokens:0}}});
      res.writeHead(200,{"content-type":"text/event-stream"});
      const event=(value:unknown)=>res.write("data: "+JSON.stringify(value)+"\n\n");
      event({model:"fixture-actual-gemma",choices:[{delta:{reasoning_content:"PRIVATE_REASONING_FIXTURE"}}]});
      if(calls.length) event({model:"fixture-actual-gemma",choices:[{delta:{tool_calls:calls.map((call:any,index)=>({...call,index}))}}]});
      for(let i=0;i<content.length;i+=160) {if(res.destroyed) break;event({model:"fixture-actual-gemma",choices:[{delta:{content:content.slice(i,i+160)}}]});await delay(12);}
      event({model:"fixture-actual-gemma",choices:[{delta:{},finish_reason:choice.finish_reason}],usage:{prompt_tokens:120,completion_tokens:60,prompt_tokens_details:{cached_tokens:0}}});
      res.end("data: [DONE]\n\n"); return;
    }
    return json(res,404,{error:"unknown fixture route"});
  } catch(error) {return json(res,500,{error:String(error)});}
});
fixture.listen(8738,"127.0.0.1"); await once(fixture,"listening");
const api=createApiServer({...ctx,jwtSecret:SECRET,corsOrigin:"http://127.0.0.1:5188"});api.listen(8737,"127.0.0.1");await once(api,"listening");
const worker=new Worker({...ctx,tools:CLOUD_TOOLS,resolveTransport:t=>ctx.providers.transport(t),buildSystem:()=>CAMPUS_SYSTEM,concurrency:1,executeTool:async(task,name,args)=>{
  if(name === "web_fetch") {await delay(800);return JSON.stringify({url:sourceUrl,status:200,title:"离线竞赛材料",retrievedAt:Date.now(),text:"这是明确标识的离线集成夹具。参赛项目应包含问题背景、实施方案、团队分工、进度、预算与风险，并展示可核查的系统流程及最终文档，不代表任何真实赛事报名通知。"});}
  if(name === "web_search") return JSON.stringify({results:[{title:"离线竞赛材料",url:sourceUrl}]});
  return executeCloudTool(name,args,{taskId:task.id,userId:task.userId,intent:task.intent,campusRecords:ctx.campusRecords,businessStore:ctx.businessStore,evidenceStore:ctx.evidenceStore,opportunityStore:ctx.opportunityStore,artifactStore:ctx.artifactStore,documents:ctx.documents});
}});
const ctrl=new AbortController();void worker.run({signal:ctrl.signal,pollMs:100});
const root=fileURLToPath(new URL("../../../",import.meta.url));
const envDir=await mkdtemp(path.join(os.tmpdir(),"campusmate-e2e-env-"));
process.env.VITE_SUPABASE_URL=ORIGIN;process.env.VITE_SUPABASE_ANON_KEY="fixture-anon";process.env.VITE_BACKEND_URL="http://127.0.0.1:8737";
const {createServer}=await import(pathToFileURL(path.join(root,"web/node_modules/vite/dist/node/index.js")).href);
const vite=await createServer({root:path.join(root,"web"),configFile:path.join(root,"web/vite.config.ts"),envDir,server:{host:"127.0.0.1",port:5188,strictPort:true}});await vite.listen();
async function close(){ctrl.abort();await vite.close();api.closeAllConnections();api.close();fixture.closeAllConnections();fixture.close();await ctx.dispose();process.exit(0);}
process.on("SIGINT",()=>void close());process.on("SIGTERM",()=>void close());
console.log("Local scripted integration fixture ready at 127.0.0.1:5188 (no external model/database)");
