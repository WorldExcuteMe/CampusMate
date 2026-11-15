import {test} from "node:test";
import assert from "node:assert/strict";
import {DeepSeekTransport} from "./llm.ts";
const frame=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
test("R12 repeated stream index with distinct complete IDs represents two calls, never concatenated names/JSON",async()=>{
  const data=frame({choices:[{delta:{tool_calls:[{index:0,id:"call_a",function:{name:"web_fetch",arguments:'{"url":"https://a.example/"}'}}]}}]})+frame({choices:[{delta:{tool_calls:[{index:0,id:"call_b",function:{name:"web_fetch",arguments:'{"url":"https://b.example/"}'}}]},finish_reason:"tool_calls"}]})+"data: [DONE]\n\n";
  const result=await new DeepSeekTransport({apiKey:"fixture-key",capabilities:{streaming:true},fetchImpl:async()=>new Response(data,{headers:{"content-type":"text/event-stream"}})}).chat({messages:[]});
  assert.deepEqual(result.toolCalls.map(c=>({id:c.id,name:c.function.name,args:JSON.parse(c.function.arguments)})),[{id:"call_a",name:"web_fetch",args:{url:"https://a.example/"}},{id:"call_b",name:"web_fetch",args:{url:"https://b.example/"}}]);
});
test("R12 HTTP200 SSE error is a protocol error rather than an empty paused response",async()=>{
  const data=frame({error:{message:"Assistant tool call function.arguments must be valid JSON.",type:"BadRequest",code:"client_error"}})+"data: [DONE]\n\n";
  await assert.rejects(new DeepSeekTransport({apiKey:"fixture-key",capabilities:{streaming:true},fetchImpl:async()=>new Response(data,{headers:{"content-type":"text/event-stream"}})}).chat({messages:[]}),(error:any)=>error.reason==="protocol"&&/valid JSON/.test(error.message));
});
test("R12 DONE terminates a complete stream even when upstream keeps its HTTP body open",async()=>{
  let cancelled=false;const encoder=new TextEncoder();const stream=new ReadableStream({start(controller){controller.enqueue(encoder.encode(frame({choices:[{delta:{content:"完成"},finish_reason:"stop"}]} )+"data: [DONE]\n\n"));},cancel(){cancelled=true;}});
  const result=await new DeepSeekTransport({apiKey:"fixture-key",timeoutMs:50,maxRetries:0,capabilities:{streaming:true},fetchImpl:async()=>new Response(stream,{headers:{"content-type":"text/event-stream"}})}).chat({messages:[]});
  assert.equal(result.truncated,false);assert.equal(result.content,"完成");assert.equal(cancelled,true);
});
test("R12 standard interleaved indices, fragmented name and repeated complete IDs remain distinct",async()=>{
  const data=frame({choices:[{delta:{tool_calls:[{index:0,id:"a",function:{name:"web_",arguments:'{"url":'}},{index:1,id:"b",function:{name:"web_fetch",arguments:'{"url":'}}]}}]})+frame({choices:[{delta:{tool_calls:[{index:0,id:"a",function:{name:"web_fetch",arguments:'"https://a.example/"}'}},{index:1,id:"b",function:{name:"web_fetch",arguments:'"https://b.example/"}'}}]},finish_reason:"tool_calls"}]})+"data: [DONE]\n\n";
  const result=await new DeepSeekTransport({apiKey:"fixture-key",capabilities:{streaming:true},fetchImpl:async()=>new Response(data,{headers:{"content-type":"text/event-stream"}})}).chat({messages:[]});
  assert.deepEqual(result.toolCalls.map(c=>c.id),["a","b"]);assert.deepEqual(result.toolCalls.map(c=>c.function.name),["web_fetch","web_fetch"]);assert.deepEqual(result.toolCalls.map(c=>JSON.parse(c.function.arguments).url),["https://a.example/","https://b.example/"]);
});
