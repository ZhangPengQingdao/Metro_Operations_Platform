import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerPlatformUpdateRoutes} from '../src/app-platform/admin/update-routes.ts';
import {AdminIdentityError} from '../src/core/admin-identity/index.ts';
import type {PlatformAdministratorContext} from '../src/platform/context/index.ts';
test('platform update routes require native admin, live authorization, same origin and durable audit',async()=>{
 const app=Fastify();let authenticated=true,allowed=true,auditFails=false;const calls:unknown[]=[];let audits=0;
 const context={actorType:'administrator',administrator:{id:'55000000-0000-4000-8000-000000000001'},authorize:async()=>({allowed})} as unknown as PlatformAdministratorContext;
 registerPlatformUpdateRoutes(app,{origin:'https://ops.example.com',socketPath:'/unused.sock',resolveAdmin:async()=>{if(!authenticated)throw new AdminIdentityError(401,'ADMIN_AUTH_REQUIRED');return context;},
  pool:{connect:async()=>({query:async()=>{audits++;if(auditFails)throw Error('private');return {rows:[]};},release(){}})},call:async(...args)=>{calls.push(args);return {accepted:true};}});
 const body={requestId:'55000000-0000-4000-8000-000000000002',action:'download',version:'0.3.0'};
 const send=(payload:unknown=body,origin='https://ops.example.com')=>app.inject({method:'POST',url:'/api/admin/updates/tasks',headers:{origin},payload:payload as object});
 try{
  assert.equal((await send()).statusCode,200);assert.equal(audits,1);assert.equal(calls.length,1);
  assert.equal((await send({...body,command:'rm -rf /'})).statusCode,400);
  assert.equal((await send({...body,actorId:'fake'})).statusCode,400);
  assert.equal((await send(body,'https://evil.example')).statusCode,403);
  allowed=false;assert.equal((await send()).statusCode,403);allowed=true;
  authenticated=false;assert.equal((await app.inject('/api/admin/updates/status')).statusCode,401);authenticated=true;
  auditFails=true;assert.equal((await send()).statusCode,503);assert.equal(calls.length,1);
 }finally{await app.close();}
});
test('unconfigured updater reports unavailable without accepting tasks',async()=>{
 const app=Fastify();registerPlatformUpdateRoutes(app,{origin:'http://localhost',pool:{connect:async()=>{throw Error('must not connect');}},resolveAdmin:async()=>({actorType:'administrator',authorize:async()=>({allowed:true})} as unknown as PlatformAdministratorContext)});
 try{const r=await app.inject('/api/admin/updates/status');assert.equal(r.statusCode,200);assert.deepEqual(r.json(),{configured:false});}finally{await app.close();}
});
