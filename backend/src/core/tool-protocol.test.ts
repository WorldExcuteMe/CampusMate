import {test} from "node:test";
import assert from "node:assert/strict";
import {parseTextToolCall,looksLikeToolCall} from "./tool-protocol.ts";
const known=new Set(["web_search"]);
test("R2 strict JSON envelope is string-aware, bounded and does not extract code examples",()=>{
  assert.deepEqual(parseTextToolCall('```json\n{"tool":"web_search","args":{"query":"a } { \\\"nested\\\""}}}\n```',known),{name:"web_search",args:{query:'a } { "nested"'}});
  for(const value of [
    '{"tool":"web_search","args":[]}', '{"tool":"web_search","args":null}',
    '{"tool":"web_search","args":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"tool":"other","args":{}}', '这是示例 {"tool":"web_search","args":{}}',
    '{"tool":"web_search","args":{}} {"tool":"web_search","args":{}}',
    '<|tool_call>call:web_search{query:"a",query:"b"}<tool_call|>',
    '<|tool_call>call:web_search{query:globalThis.secret}<tool_call|>',
    'x'.repeat(64001),
  ]) assert.equal(parseTextToolCall(value,known),null,value.slice(0,120));
  assert.equal(looksLikeToolCall('{"name":"张同学","major":"计算机"}'),false);
});
test("R2 Gemma finite grammar preserves nested data without evaluating expressions",()=>{
  assert.deepEqual(parseTextToolCall('<|tool_call>call:web_search{query:"a\\nb",options:{limit:2,active:true,empty:null,tags:["x",1]}}<tool_call|>',known),{name:"web_search",args:{query:"a\nb",options:{limit:2,active:true,empty:null,tags:["x",1]}}});
});

test("R2 标签包裹的 JSON 工具调用可恢复，未知工具与散文示例不执行", () => {
  const known = new Set(["web_search", "workspace_list"]);
  assert.deepEqual(parseTextToolCall('</think>\n<{"tool":"workspace_list","args":{"path":"."}}>', known), { name: "workspace_list", args: { path: "." } });
  assert.deepEqual(parseTextToolCall('<tool_call>{"function":{"name":"web_search","arguments":"{\\"query\\":\\"a\\"}"}}</tool_call>', known), { name: "web_search", args: { query: "a" } });
  assert.equal(looksLikeToolCall('</think>\n<{"tool":"workspace_list","args":{"path":"."}}>'), true);
  assert.equal(parseTextToolCall('<{"tool":"rm_rf","args":{}}>', known), null);
  assert.equal(parseTextToolCall('示例如下：{"tool":"web_search","args":{}} 仅供参考', known), null);
  assert.equal(parseTextToolCall('<{"tool":"web_search","args":{"query":"a"}}> 然后继续聊天', known), null);
});
