import { expect,it } from 'vitest';
import { newSession,type ChatSession } from '../agent/sessions';
import { mergeHistoryPage,type HistoryItem,type RemotePage } from '../agent/session-sync';
import { mergeTask } from '../agent/task-state';
const remote={id:'s',title:'分页会话',mode:'auto' as const,revision:0,createdAt:1,updatedAt:1};
const item=(n:number,version='1'):HistoryItem=>({key:`t:${n}`,order:[1,n,n,`t:${n}`],version,messages:[{role:'user',content:`问题${n}`,taskId:`task${n}`,turnId:`turn${n}`},{role:'assistant',content:`回答${n}-${version}`,taskId:`task${n}`,turnId:`turn${n}`}],task:{id:`task${n}`,userId:'alice',title:`轮${n}`,status:'succeeded',turnId:`turn${n}`,createdAt:n,updatedAt:n,historyRevision:version,usage:{tokens:n,toolCalls:0,wallMs:0,costUsd:0},result:{summary:`回答${n}-${version}`,artifactIds:[]}}});
const page=(items:HistoryItem[],extra:Partial<RemotePage>={}):RemotePage=>({session:remote,items,after:'watch',before:'older',hasMore:true,totalTokens:1000,...extra});
const empty=():ChatSession=>({...newSession(),id:'s',backendId:'s',remoteRevision:0,name:remote.title});
it('先显示最近页，旧页前插不重复，累计用量不变且最新任务仍被选中',()=>{
  const initial=mergeHistoryPage(empty(),page([item(8),item(9),item(10)]),'initial');
  expect(initial.messages).toHaveLength(6);expect(initial.tokens).toBe(1000);expect(initial.currentTaskId).toBe('task10');
  const older=page([item(5),item(6),item(7)],{after:'must-not-advance',before:'old2'});
  const loaded=mergeHistoryPage(initial,older,'older');
  expect(loaded.messages[0].content).toBe('问题5');expect(loaded.messages.at(-1)?.content).toBe('回答10-1');expect(loaded.historyPage?.after).toBe('watch');
  expect(mergeHistoryPage(loaded,older,'older').messages).toHaveLength(12);expect(loaded.tokens).toBe(1000);expect(loaded.currentTaskId).toBe('task10');
});
it('增量只替换对应组，重复响应不重复消息；迟到旧页不能覆盖更新结果',()=>{
  let s=mergeHistoryPage(empty(),page([item(8),item(9)]),'initial');
  s=mergeHistoryPage(s,page([item(8,'10'),item(10,'10')],{after:'watch2',hasMore:false,totalTokens:1010}),'changes');
  expect(s.messages).toHaveLength(6);expect(s.messages[1].content).toBe('回答8-10');
  s=mergeHistoryPage(s,page([item(7),item(8,'1')]),'older');
  expect(s.messages.find(m=>m.taskId==='task8'&&m.role==='assistant')?.content).toBe('回答8-10');expect(s.messages).toHaveLength(8);
  expect(s.tokens).toBe(1010);
});
it('空增量不改对象、不触发全历史缓存重写；分批增量全部消费前不推进游标',()=>{
  const s=mergeHistoryPage(empty(),page([item(8)]),'initial');
  expect(mergeHistoryPage(s,page([],{after:'new-empty-watch',totalTokens:undefined,hasMore:false}),'changes')).toBe(s);
  const midway=mergeHistoryPage(s,page([item(9)],{next:'next-page',after:'future-watch',hasMore:true}),'changes');
  expect(midway.historyPage?.after).toBe('watch');expect(midway.historyPage?.next).toBe('next-page');
  const done=mergeHistoryPage(midway,page([item(10)],{after:'future-watch',hasMore:false}),'changes');
  expect(done.historyPage?.after).toBe('future-watch');expect(done.historyPage?.next).toBeUndefined();
});
it('初始快照不吞正在提交的新轮次，执行面板不生成未加载旧轮次的孤立回复或重复计量',()=>{
  const local=empty();local.pendingTurn={turnId:'pending',content:'新问题'};local.messages=[{role:'user',turnId:'pending',content:'新问题'}];
  const s=mergeHistoryPage(local,page([item(10)]),'initial');
  expect(s.messages.at(-1)?.content).toBe('新问题');expect(s.pendingTurn?.turnId).toBe('pending');
  const monitored=mergeTask(s,item(1).task!);expect(monitored.messages).toEqual(s.messages);expect(monitored.tokens).toBe(s.tokens);
});
it('旧浏览器本地轮次保留，之后读到相同导入记录时只显示一份',()=>{
  const local=empty();local.messages=[{role:'user',content:'本地问题',turnId:'local-turn'},{role:'assistant',content:'本地回答',turnId:'local-turn',taskId:'local:task'}];
  let s=mergeHistoryPage(local,page([item(10)]),'initial');expect(s.messages.some(m=>m.content==='本地问题')).toBe(true);
  s=mergeHistoryPage(s,page([{key:'l:1',order:[0,0,1,'l:1'],version:'1',messages:[{role:'user',content:'本地问题',imported:true}]},{key:'l:2',order:[0,0,2,'l:2'],version:'1',messages:[{role:'assistant',content:'本地回答',imported:true}]}]),'older');
  expect(s.messages.filter(m=>m.content==='本地回答')).toHaveLength(1);expect(s.messages.filter(m=>m.content==='本地问题')).toHaveLength(1);
});
