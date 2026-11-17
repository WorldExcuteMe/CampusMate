// Real local PostgreSQL/API check. One disposable account; no Worker/model call.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID,randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { PgPool,transactionPool } from '../backend/src/runtime/sql.ts';
import { buildContext,createApiServer } from '../backend/src/app-context.ts';
import { signJwt } from '../backend/src/api/jwt.ts';
const root=new URL('../',import.meta.url), require=createRequire(new URL('web/package.json',root));
const {createClient}=require('@supabase/supabase-js');
const info=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('node_modules/supabase/dist/supabase.js',root)),'--workdir',fileURLToPath(new URL('.local/dev',root)),'status','-o','json'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));
assert.equal(new URL(info.API_URL).hostname,'127.0.0.1');
const admin=createClient(info.API_URL,info.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const db=new URL(info.DB_URL);db.searchParams.set('sslmode','disable');const pool=new PgPool(db.href,{ssl:false,max:4});
const ctx=buildContext({}, {pool});let user,server,release,held;
try {
  const created=await admin.auth.admin.createUser({email:`history-${randomUUID()}@example.com`,password:randomBytes(24).toString('hex'),email_confirm:true});if(created.error)throw Error('Fixture account creation failed');user=created.data.user;
  const session=await ctx.sessionStore.create({userId:user.id,title:'Disposable history fixture'}), tasks=[];
  await pool.transaction(async client=>{
    const nested=buildContext({}, {pool:transactionPool(client)});
    for(let i=0;i<75;i++) {
      const {task}=await nested.store.createSessionTask({userId:user.id,sessionId:session.id,turnId:randomUUID(),title:`fixture-${i}`,intent:`问题${i}`},nested.sessionStore);
      await client.query("update agent_tasks set status='succeeded',transcript_committed=true,result=$2::jsonb where id=$1",[task.id,JSON.stringify({summary:`回答${i}`,artifactIds:[]})]);tasks.push(task);
    }
  });
  ctx.store.listTasksByUser=async()=>{throw Error('Forbidden account-wide scan');};
  const secret=randomBytes(32).toString('hex');
  server=createApiServer({...ctx,jwtSecret:secret});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}/v1/sessions/${session.id}/history`;
  const headers={Authorization:`Bearer ${signJwt({sub:user.id,exp:Date.now()/1000+120},secret)}`};
  const get=async suffix=>{const response=await fetch(base+suffix,{headers});assert.equal(response.status,200,await response.clone().text());return response.json();};
  let page=await get('/page?limit=7'), watch=page.after, items=[...page.items];
  while(page.hasMore){page=await get('/page?limit=7&before='+encodeURIComponent(page.before));items.unshift(...page.items);}
  assert.equal(new Set(items.map(i=>i.key)).size,75);assert.equal(items.flatMap(i=>i.messages).length,150);
  console.log('PASS real Postgres/API: 75 turns reached through bounded keyset pages; no account-wide scan');
  let started;const ready=new Promise(r=>{started=r;});const gate=new Promise(r=>{release=r;});
  held=pool.transaction(async client=>{await client.query("update agent_tasks set result=$2::jsonb,updated_at='2026-01-01T00:00:00Z' where id=$1",[tasks[74].id,JSON.stringify({summary:'old-transaction-committed-last',artifactIds:[]})]);started();await gate;});
  await ready;
  await pool.query("update agent_tasks set result=$2::jsonb,updated_at='2026-01-01T00:00:00Z' where id=$1",[tasks[73].id,JSON.stringify({summary:'new-transaction-committed-first',artifactIds:[]})]);
  async function delta(after){let next,items=[],result;do{result=await get('/changes?limit=5&after='+encodeURIComponent(after)+(next?'&next='+encodeURIComponent(next):''));items.push(...result.items);next=result.next;}while(next);return {items,after:result.after};}
  const first=await delta(watch);assert(first.items.some(i=>i.messages.some(m=>m.content==='new-transaction-committed-first')));
  release();await held;held=undefined;
  const second=await delta(first.after);assert(second.items.some(i=>i.messages.some(m=>m.content==='old-transaction-committed-last')));
  console.log('PASS real MVCC: out-of-order commits and equal/backdated timestamps do not lose updates');
  const another=await ctx.sessionStore.create({userId:user.id});
  await assert.rejects(ctx.sessionFeed.read(user.id,another.id,{after:watch}),/游标/);
  console.log('PASS cursor bound to account/session; fixture did not invoke a model');
} finally {
  release?.();if(held)await held.catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  if(user){const result=await admin.auth.admin.deleteUser(user.id);if(result.error)throw Error('Fixture account cleanup failed');console.log('PASS disposable account and cascaded test history removed');}
  await pool.end();
}
