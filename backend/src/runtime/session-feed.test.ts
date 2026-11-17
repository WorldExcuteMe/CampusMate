import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildContext,createApiServer } from '../app-context.ts';
import { storageFixture,OWNER,OTHER } from './storage-test-fixture.ts';
import { signJwt } from '../api/jwt.ts';
import type { AddressInfo } from 'node:net';

for (const kind of ['memory','sql']) test(`${kind}: 分页覆盖全部记录，增量不重传全历史，游标隔离且私有续传不外泄`,async t=>{
  const ctx=kind==='sql'?(await storageFixture(t)).first:buildContext({});
  const s=await ctx.sessionStore.create({userId:OWNER}), other=await ctx.sessionStore.create({userId:OTHER});
  const tasks=[];
  for(let i=0;i<65;i++) {
    const task=await ctx.store.createSessionTask!({userId:OWNER,sessionId:s.id,turnId:randomUUID(),title:`轮${i}`,intent:`问题${i}`},ctx.sessionStore);
    await ctx.store.updateTask(task.task.id,{status:'running'});
    await ctx.store.updateTask(task.task.id,{status:'succeeded',usage:{tokens:i,toolCalls:0,wallMs:0,costUsd:0},result:{summary:`回答${i}`,artifactIds:[]}});tasks.push(task.task);
  }
  await ctx.sessionStore.importLegacy(OWNER,s.id,[{role:'user',content:'旧问题'},{role:'assistant',content:'旧回答'}]);
  await ctx.sessionStore.appendMessage({userId:OWNER,sessionId:s.id,turnId:'opaque',messageKey:'opaque',role:'assistant',content:'独立记录',reasoning_content:'PRIVATE_REASONING'});
  ctx.store.listTasksByUser=async()=>{throw Error('must not scan all account tasks');};
  let page=await ctx.sessionFeed.read(OWNER,s.id,{limit:'7'}); const watch=page.after; const items=[...page.items];
  assert.equal(page.items.length,7);assert(page.hasMore);
  while(page.hasMore) { page=await ctx.sessionFeed.read(OWNER,s.id,{limit:'7',before:page.before});items.unshift(...page.items); }
  assert.equal(items.length,68);assert.equal(new Set(items.map(i=>i.key)).size,68);
  assert.equal(items.flatMap(i=>i.messages).length,133);assert.equal(items[0].messages[0].content,'旧问题');
  assert.equal((await ctx.sessionFeed.read(OWNER,s.id,{after:watch})).items.length,0);
  await ctx.store.updateTask(tasks[64].id,{result:{summary:'已更新回答',artifactIds:[]}});
  const delta=await ctx.sessionFeed.read(OWNER,s.id,{after:watch}); assert.equal(delta.items.length,1);assert.equal(delta.items[0].messages[1].content,'已更新回答');
  assert.equal((await ctx.sessionFeed.read(OWNER,s.id,{after:delta.after})).items.length,0);
  for(const task of tasks.slice(0,13))await ctx.store.updateTask(task.id,{result:{summary:'批量更新'+task.id,artifactIds:[]}});
  let batch=await ctx.sessionFeed.read(OWNER,s.id,{after:delta.after,limit:'3'}),changes=[...batch.items];
  while(batch.next){batch=await ctx.sessionFeed.read(OWNER,s.id,{after:delta.after,next:batch.next,limit:'3'});changes.push(...batch.items);}
  assert.equal(changes.length,13);assert.equal(new Set(changes.map(i=>i.key)).size,13);
  await assert.rejects(ctx.sessionFeed.read(OTHER,other.id,{after:watch}),/游标/);
  for(const bad of ['0','51','1.2','nope'])await assert.rejects(ctx.sessionFeed.read(OWNER,s.id,{limit:bad}),/页大小/);
  await assert.rejects(ctx.sessionFeed.read(OWNER,s.id,{before:'broken'}),/游标/);
  const server=createApiServer({...ctx,jwtSecret:'feed-fixture'});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/sessions/${s.id}/history/page?limit=50`;
  const response=await fetch(url,{headers:{Authorization:`Bearer ${signJwt({sub:OWNER,exp:Date.now()/1000+60},'feed-fixture')}`}});assert.equal(response.status,200);
  const text=await response.text();assert(!text.includes('PRIVATE_REASONING'));assert(!text.includes('reasoning_content'));assert(!text.includes('inputHash'));
});
