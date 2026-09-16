import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createAppBackend} from '../../packages/platform-sdk/src/app-backend.ts';
import {startAppStdioGateway} from '../src/app-platform/runtime/stdio-gateway.ts';
import {createAppStdioApiTransport} from '../src/app-platform/runtime/stdio-api.ts';
import {AppGateway} from '../src/app-platform/gateway/gateway.ts';
import type {PlatformActorContext,PlatformActorContextResolver} from '../src/platform/context/index.ts';

const request={handler:'write',method:'POST',path:'/write',payload:{}};
test('API admission guard rejects unknown, expired and completed call bindings without settling uncertain work',async()=>{
 let id='';let allowed=true;
 const transport=createAppStdioApiTransport(async value=>{id=(value as {id:string}).id;},()=>{},20);
 const call=transport.invoke(request,undefined,async()=>{if(!allowed)throw Error('revoked');});
 const guard=transport.admissionGuard(id);await guard();
 await assert.rejects(transport.admissionGuard(randomUUID())(),/ACCESS_DENIED/);
 allowed=false;await assert.rejects(guard(),/revoked/);allowed=true;
 await assert.rejects(call,/TIMEOUT/);await assert.rejects(guard(),/ACCESS_DENIED/);
 transport.accept({id,result:true});await transport.drain();await assert.rejects(guard(),/ACCESS_DENIED/);
 transport.close();
});
test('concurrent SDK handlers retain their own call binding through awaits and service calls',async()=>{
 const input=new PassThrough(),output=new PassThrough();let calls=0;
 let toApp='',fromApp='';input.on('data',chunk=>{toApp+=String(chunk);});output.on('data',chunk=>{fromApp+=String(chunk);});
 const backend=createAppBackend({input,output,handlers:new Map([['write',{method:'POST',path:'/write',execute:async payload=>{
  await new Promise(resolve=>setImmediate(resolve));return backend.gateway.invoke('data.write',payload);
 }}]])});
 const host=startAppStdioGateway({appId:'example',serviceCredential:'secret',stdout:output,stdin:input,requireApiContext:true,gateway:{
  invokeService:async(_app,_credential,request,_signal,guard)=>{assert.ok(guard);await guard();calls++;return {version:'1.0',requestId:'r',traceId:'t',result:(request as {params:{n:number}}).params.n};},drain:async()=>{},
 }});
 try{
  let one=0,two=0;
  const values=await Promise.all([
   host.api.invoke({...request,payload:{n:1}},undefined,async()=>{one++;}),
   host.api.invoke({...request,payload:{n:2}},undefined,async()=>{two++;}),
  ]);
  const apiFrames=toApp.split('\n').filter(line=>line.startsWith('AFC_API_V1 ')).map(line=>JSON.parse(line.slice('AFC_API_V1 '.length)));
  const gatewayFrames=fromApp.split('\n').filter(line=>line.startsWith('AFC_GATEWAY_V1 ')).map(line=>JSON.parse(line.slice('AFC_GATEWAY_V1 '.length)));
  for(const frame of gatewayFrames)assert.equal(frame.invocationId,apiFrames.find(api=>api.request.payload.n===frame.request.params.n).id);
  assert.deepEqual(values,[1,2]);assert.equal(calls,2);assert.equal(one,2);assert.equal(two,2);
  await assert.rejects(backend.gateway.invoke('data.write',{n:3}),/ACCESS_DENIED/);assert.equal(calls,2);
 }finally{backend.close();await backend.drain();host.api.confirmContainerStopped();await host.stop();}
});
test('Gateway preserves employee guard on service context authorization inside an operation',async()=>{
 let allowed=true,committed=false;
 const actor={actorType:'service',execution:{type:'service',appId:'example',serviceIdentityId:randomUUID()},authorize:async()=>({allowed:true}),authorizeApplication:async()=>({allowed:true})} as unknown as PlatformActorContext;
 const gateway=new AppGateway({registry:{authenticateServiceCredential:async()=>({actorType:'service',trustedIdentity:{source:'service'},execution:actor.execution}) as never},contextResolver:{resolve:async()=>actor} as Pick<PlatformActorContextResolver,'resolve'>,operations:[{
  name:'data.write',permissionCode:'data.write',mode:'write',validateParams:()=>true,resolveResources:async()=>[{}],validateResult:()=>true,
  execute:async context=>{allowed=false;await context.authorize('data.write',{});committed=true;return null;},
 }]});
 await assert.rejects(gateway.invokeService('example','secret',{version:'1.0',operation:'data.write',params:{}},undefined,async()=>{if(!allowed)throw Error('revoked');}),error=>(error as {code:string;writeOutcome:string}).code==='ACCESS_DENIED'&&(error as {writeOutcome:string}).writeOutcome==='unknown');
 assert.equal(committed,false);await gateway.drain('example');
});
