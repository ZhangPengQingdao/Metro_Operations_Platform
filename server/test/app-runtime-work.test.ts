import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { AppRuntimeWorkJournal, APP_RUNTIME_WORK_SQL, APP_RUNTIME_WORK_CONTEXT_SQL } from '../src/app-platform/runtime/work-journal.ts';
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};}
async function fixture(){
 const db=new PGlite();const id=randomUUID();
 await db.exec('CREATE TABLE public.platform_app_installations(id uuid PRIMARY KEY);'+APP_RUNTIME_WORK_SQL+';'+APP_RUNTIME_WORK_CONTEXT_SQL);
 await db.query('INSERT INTO public.platform_app_installations(id) VALUES($1)',[id]);
 const connect=async()=>({query:(sql:string,values?:readonly unknown[])=>db.query(sql,values?[...values]:undefined),end:async()=>{}});
 return {db,id,journal:new AppRuntimeWorkJournal(connect),connect};
}
test('successor blocks until actual work and audit drain; caller result alone cannot settle',async()=>{
 const f=await fixture(),gate=deferred(),started=deferred();try{
  const work=f.journal.track(f.id,async()=>{},async()=>{started.resolve();return 'result';},()=>gate.promise);
  await started.promise;
  const successor=new AppRuntimeWorkJournal(f.connect);
  await assert.rejects(successor.assertDrained(f.id),/RUNTIME_WORK_PENDING/);
  gate.resolve();assert.equal(await work,'result');await successor.assertDrained(f.id);
 }finally{await f.db.close();}
});
test('owner loss after admission prevents dispatch and confirmed no-work can settle',async()=>{
 const f=await fixture();let calls=0;try{
  await assert.rejects(f.journal.track(f.id,async()=>{throw Error('lost');},async()=>{calls++;},async()=>{}),/lost/);
  assert.equal(calls,0);await f.journal.assertDrained(f.id);
 }finally{await f.db.close();}
});
test('lost admission acknowledgement does not execute; failed drain keeps durable blocker',async()=>{
 const f=await fixture();let calls=0;try{
  const lost=new AppRuntimeWorkJournal(async()=>({query:async(sql,values)=>{await f.db.query(sql,values?[...values]:undefined);throw Error('lost ack');},end:async()=>{}}));
  await assert.rejects(lost.track(f.id,async()=>{},async()=>{calls++;},async()=>{}),/RUNTIME_WORK_UNCERTAIN/);
  assert.equal(calls,0);await assert.rejects(f.journal.assertDrained(f.id),/RUNTIME_WORK_PENDING/);
  const second=randomUUID();await f.db.query('INSERT INTO public.platform_app_installations(id) VALUES($1)',[second]);
  await assert.rejects(f.journal.track(second,async()=>{},async()=>{},async()=>{throw Error('audit unknown');}),/audit unknown/);
  await assert.rejects(f.journal.assertDrained(second),/RUNTIME_WORK_PENDING/);
 }finally{await f.db.close();}
});

test('pending diagnostics preserve legacy blockers and exclude payloads',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.journal.track(f.id,async()=>{},async()=>{},async()=>{throw Error('unknown');},{kind:'api',requestId:'request-1',apiId:'inbound',payload:'secret'} as never));
  const pending=await f.journal.pending(f.id);
  assert.equal(pending.records.length,1);assert.equal(pending.hasMore,false);
  assert.deepEqual((pending.records[0] as {context:unknown}).context,{kind:'api',requestId:'request-1',apiId:'inbound'});
  await assert.rejects(f.journal.assertDrained(f.id),/RUNTIME_WORK_PENDING/);
 }finally{await f.db.close();}
});
