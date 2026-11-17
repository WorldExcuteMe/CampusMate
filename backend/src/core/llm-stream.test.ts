import {test} from "node:test";
import assert from "node:assert/strict";
import {DeepSeekTransport} from "./llm.ts";
import {readSse} from "./llm-stream.ts";
const frame=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
test("TTFT ignores empty role/content frames and includes the first meaningful tool delta",async()=>{
  let clock=0,index=0; const encoder=new TextEncoder();
  const frames=[
    [5,frame({choices:[{delta:{role:"assistant",content:""}}]})],
    [17,frame({choices:[{delta:{tool_calls:[{index:0,id:"tool",function:{name:"web_fetch",arguments:'{"url":"https://example.edu/"}'}}]}}]})],
    [30,frame({choices:[{delta:{},finish_reason:"tool_calls"}]})+"data: [DONE]\n\n"],
  ] as const;
  const body=new ReadableStream({pull(controller){if(index===frames.length){controller.close();return;} const item=frames[index++];clock=item[0];controller.enqueue(encoder.encode(item[1]));}},{highWaterMark:0});
  const result=await readSse(new Response(body),{signal:new AbortController().signal,start:0,now:()=>clock,redact:text=>text});
  assert.equal(result.ttftMs,17); assert.equal(result.toolCalls.length,1);
});
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

test("early EOF is identified separately from a length stop or caller cancellation",async()=>{
  const early=await new DeepSeekTransport({apiKey:"fixture",capabilities:{streaming:true},fetchImpl:async()=>new Response(frame({choices:[{delta:{content:"未完成正文"}}]}),{headers:{"content-type":"text/event-stream"}})}).chat({messages:[]});
  assert.equal(early.truncated,true);assert.equal(early.streamInterrupted,true);
  const length=await new DeepSeekTransport({apiKey:"fixture",capabilities:{streaming:true},fetchImpl:async()=>new Response(frame({choices:[{delta:{content:"长度用完"},finish_reason:"length"}]})+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}})}).chat({messages:[]});
  assert.equal(length.truncated,true);assert.equal(length.streamInterrupted,false);
  const abort=new AbortController();let part=0;
  const body=new ReadableStream({pull(controller){if(!part++){controller.enqueue(new TextEncoder().encode(frame({choices:[{delta:{content:"草稿"}}]})));}else{abort.abort();}}},{highWaterMark:0});
  const cancelled=await readSse(new Response(body),{signal:abort.signal,start:Date.now(),now:Date.now,redact:text=>text});
  assert.equal(cancelled.truncated,true);assert.equal(cancelled.streamInterrupted,false);
});

test("malformed SSE after a draft remains a protocol error, not a resumable network interruption",async()=>{
  const text=frame({choices:[{delta:{content:"草稿"}}]})+"data: {broken JSON}\n\n";
  await assert.rejects(new DeepSeekTransport({apiKey:"fixture",capabilities:{streaming:true},fetchImpl:async()=>new Response(text,{headers:{"content-type":"text/event-stream"}})}).chat({messages:[]}),(error:any)=>error.reason==="protocol");
});
