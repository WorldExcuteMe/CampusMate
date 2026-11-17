import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveModelCapabilities} from "./model-capabilities.ts";
import {DeepSeekTransport} from "./llm.ts";
test("R3 endpoint contract is exact; explicit operator overrides and unrelated endpoints are preserved",()=>{
  const base="https://developer.amd.com.cn/radeon/api/v1";
  assert.equal(resolveModelCapabilities(base,"Gemma-4-31B-IT",{vision:"unknown"}).capabilities.vision,true);
  assert.equal(resolveModelCapabilities(base,"Gemma-4-31B-IT",{vision:false}).capabilities.vision,false);
  for(const host of ["https://other.example/v1","https://developer.amd.com.cn.attacker.example/radeon/api/v1",base+"/other"]){const result=resolveModelCapabilities(host,"Gemma-4-31B-IT",{});assert.equal(result.capabilities.vision,"unknown");assert.equal(result.profile,undefined);}
});
test("R1 raw Gemma call from a native endpoint becomes a real tool envelope for the next turn",async()=>{
  const tools:any=[{type:"function",function:{name:"web_search",description:"fixture",parameters:{type:"object"}}}];
  const transport=new DeepSeekTransport({apiKey:"fixture-secret-only",capabilities:{tools:"native"},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'<|tool_call>call:web_search{query:"fixture"}<tool_call|>'},finish_reason:"stop"}]}))});
  const result=await transport.chat({messages:[{role:"user",content:"search"}],tools});
  assert.equal(result.content,"");assert.equal(result.toolCalls[0].function.name,"web_search");assert.equal(result.toolCalls[0].function.arguments,'{"query":"fixture"}');assert(result.toolCalls[0].id);
});
