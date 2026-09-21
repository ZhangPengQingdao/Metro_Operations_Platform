import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {CORE_EVENTS_MIGRATIONS} from '../src/core/events/index.ts';
import {PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS} from '../src/platform/people/index.ts';
import {PLATFORM_AUTHORIZATION_MIGRATIONS} from '../src/platform/authorization/index.ts';
import {PLATFORM_SIGNATURE_MIGRATIONS} from '../src/platform/signatures/index.ts';
import {createLocalStorageAdapter} from '../src/core/storage/index.ts';
import {createSignatureGatewayOperations} from '../src/app-platform/gateway/signatures.ts';
import {createWebhookOperation} from '../src/app-platform/gateway/webhook.ts';
import type {GatewayActorContext} from '../src/app-platform/gateway/model.ts';
const id=(n:number)=>`62000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const allow=async()=>({allowed:true,permission:'test',reason:'allowed'});
function context(person=id(3),appId='shifts'):GatewayActorContext{return {actorType:'service',execution:{type:'service',appId,serviceIdentityId:id(6)},request:{requestId:randomUUID(),traceId:randomUUID(),startedAt:new Date().toISOString()},authorize:allow,authorizeApplication:allow,employeeActor:{request:{requestId:randomUUID(),traceId:randomUUID(),startedAt:new Date().toISOString()},actorType:'person',person:{id:person,name:'测试人员',organization:{id:id(1)}},execution:{type:'application',appId},authorize:allow,authorizeApplication:allow}} as unknown as GatewayActorContext;}
test('record signature Gateway uses host employee, isolates source apps and retains evidence through re-sign',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shifts-signature-')),db=new PGlite(),client={query:async(sql:string,args?:readonly unknown[])=>!args&&sql.includes(';')?db.exec(sql):db.query(sql,args?[...args]:undefined),release(){}};
 try{
 for(const migration of [...CORE_EVENTS_MIGRATIONS,...PLATFORM_PEOPLE_DIRECTORY_MIGRATIONS,...PLATFORM_AUTHORIZATION_MIGRATIONS,...PLATFORM_SIGNATURE_MIGRATIONS])await migration.run({client} as never);
 await db.query(`INSERT INTO platform_organization_units VALUES($1,NULL,'team','测试工班',NULL,'workgroup','active',0,NOW(),NOW())`,[id(1)]);
 await db.query(`INSERT INTO platform_positions VALUES($1,'worker','员工',NULL,'active',NOW(),NOW())`,[id(2)]);
 for(const n of [3,4,5])await db.query(`INSERT INTO platform_people VALUES($1,$2,$3,NULL,$4,$5,'active',NULL,NOW(),NOW())`,[id(n),String(n),'员工'+n,id(1),id(2)]);
 const storage=createLocalStorageAdapter({rootDir:root}),ops=createSignatureGatewayOperations({...client,connect:async()=>client} as never,()=>storage);
 const invoke=async(action:string,p:unknown,c=context())=>{const op=ops.find(o=>o.name.endsWith('.'+action))!;assert.equal(op.validateParams(p),true);await op.resolveResources(c,p);return await op.execute(c,p,new AbortController().signal) as any;};
 const entityId=id(10),p={entityId,title:'晨会',organizationUnitId:id(1),personIds:[id(3),id(4)]};
 assert.equal((await invoke('associate',p)).signers.length,2);await invoke('associate',p);
 assert.equal((await db.query<{count:number}>('SELECT count(*)::int AS count FROM platform_signature_requests')).rows[0].count,1);
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
 await assert.rejects(invoke('sign',{entityId,image},context(id(5))),/ACCESS_DENIED/);
 assert.equal(ops.find(o=>o.name.endsWith('.sign'))!.validateParams({entityId,image,personId:id(4)}),false);
 const unbound=context();delete unbound.employeeActor;await assert.rejects(invoke('get',{entityId},unbound),/ACCESS_DENIED/);
 await invoke('sign',{entityId,image});await invoke('sign',{entityId,image},context(id(4)));await invoke('sign',{entityId,image});
 assert.deepEqual((await invoke('get',{entityId})).signers.map((s:any)=>s.status),['signed','signed']);
 assert.equal((await invoke('get',{entityId,evidencePersonId:id(3)})).image,image);
 assert.equal((await invoke('get',{entityId},context(id(3),'other-app'))).associated,false);
 await invoke('associate',{...p,personIds:[id(4)]});await assert.rejects(invoke('sign',{entityId,image}),/ACCESS_DENIED/);
 }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
test('webhook validates trusted exact endpoints and carries cancellation without retry',async()=>{
 const calls:any[]=[],op=createWebhookOperation(async(...args)=>{calls.push(args);return undefined as never;}),signal=new AbortController().signal;
 for(const url of ['https://example.com/robot/send?access_token=x','http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x','https://qyapi.weixin.qq.com/not-webhook?key=x','https://qyapi.weixin.qq.com/cgi-bin/webhook/send','https://oapi.dingtalk.com/robot/send?access_token=x#fragment'])await assert.rejects(op.execute(context(),{url,message:'test'},signal));
 assert.equal(calls.length,0);await op.execute(context(),{url:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',message:'测试',messageType:'text'},signal);assert.equal(calls.length,1);assert.equal(calls[0][2].signal,signal);
 const failed=createWebhookOperation(async()=>{throw Error('timeout');});await assert.rejects(failed.execute(context(),{url:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',message:'test'},signal),/timeout/);
});
