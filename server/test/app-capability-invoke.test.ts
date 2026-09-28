import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppCapabilityOperation} from '../src/app-platform/gateway/app-capabilities.ts';
import type {AppInstallation} from '../src/app-platform/registry/model.ts';
import type {GatewayActorContext,GatewayJson} from '../src/app-platform/gateway/model.ts';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
import {AppGateway} from '../src/app-platform/gateway/gateway.ts';
import {EmployeeIdentityError} from '../src/platform/employee-identity/index.ts';
import {AppStdioApiError} from '../src/app-platform/runtime/stdio-api.ts';

const personId='00000000-0000-4000-8000-000000000001';
const employee={actorType:'person',person:{id:personId},trustedIdentity:{source:'employee',userId:'worker'},execution:{type:'application',appId:'consumer'}};
const source={id:'source-install',appId:'consumer',enabled:true,revision:1,manifest:{id:'consumer',version:'1.0.0',permissions:{requested:['platform.apps.invoke','app.provider.create']},compatibility:{applications:[{id:'provider',version:{minInclusive:'1.0.0',maxExclusive:'2.0.0'}}]}}} as AppInstallation;
const target={id:'target-install',appId:'provider',enabled:true,revision:1,manifest:{id:'provider',version:'1.1.0',api:[{id:'create',method:'POST',path:'/create',handler:'create',permission:'app.provider.create',businessPermission:'app.provider.create',expose:{contractVersion:'1.0',mode:'write'}}]}} as AppInstallation;
function harness(){
 let installations=new Map([['consumer',structuredClone(source)],['provider',structuredClone(target)]]);
 let accesses=0,invocations=0,allowed=true,published=true;
 const context={actorType:'service',execution:{type:'service',appId:'consumer',serviceIdentityId:'service'},employeeActor:employee,request:{requestId:'request',traceId:'trace'},authorize:async()=>({allowed})} as unknown as GatewayActorContext;
 const operation=createAppCapabilityOperation({
  getInstallation:async id=>installations.get(id)??null,
  assertEmployeeAccess:async()=>{accesses++;},
  isPublished:async()=>published,
  resolveEmployee:async(_identity,appId)=>({...employee,execution:{type:'application',appId}}) as PlatformActorContext,
  invokeTarget:async(appId,actor,request,_signal,assertAdmission)=>{
   invocations++;assert.equal(appId,'provider');assert.equal(actor.execution.type,'application');assert.equal(request.method,'POST');assert.equal(request.path,'/create');
   await assertAdmission();return {created:true};
  }
 });
 const call=(params:GatewayJson={name:'test'})=>operation.execute(context,{appId:'provider',apiId:'create',params},new AbortController().signal);
 return {operation,call,context,get accesses(){return accesses;},get invocations(){return invocations;},source:installations.get('consumer')!,target:installations.get('provider')!,set allowed(value:boolean){allowed=value;},set published(value:boolean){published=value;}};
}

test('declared capability dispatches with bound employee and target API permission',async()=>{
 const h=harness();
 assert.deepEqual(await h.call(),{created:true});
 assert.equal(h.invocations,1);assert.ok(h.accesses>=3);
 assert.deepEqual(h.operation.auditMetadata?.({appId:'provider',apiId:'create',params:{secret:'not-a-label'}}),{targetAppId:'provider',apiId:'create'});
});

test('undeclared, hidden and incompatible target APIs are denied before dispatch',async()=>{
 for(const mutate of [
  (h:ReturnType<typeof harness>)=>{h.source.manifest.permissions.requested=[];},
  (h:ReturnType<typeof harness>)=>{h.source.manifest.compatibility.applications=[];},
  (h:ReturnType<typeof harness>)=>{h.target.manifest.version='2.0.0';},
  (h:ReturnType<typeof harness>)=>{delete h.target.manifest.api[0].expose;},
  (h:ReturnType<typeof harness>)=>{h.target.enabled=false;},
 ]){
  const h=harness();mutate(h);await assert.rejects(h.call(),{code:'OPERATION_DENIED'});assert.equal(h.invocations,0);
 }
});

test('service without employee binding and revoked grant cannot call',async()=>{
 const h=harness();const operation=h.operation;
 await assert.rejects(operation.execute({...h.context,employeeActor:undefined}, {appId:'provider',apiId:'create',params:{}},new AbortController().signal),{code:'ACCESS_DENIED'});
 h.allowed=false;await assert.rejects(h.call(),{code:'ACCESS_DENIED'});assert.equal(h.invocations,0);
});

test('unpublished or withdrawn capability is denied before dispatch',async()=>{
 const h=harness();h.published=false;
 await assert.rejects(h.call(),{code:'APP_CAPABILITY_NOT_PUBLISHED'});
 assert.equal(h.invocations,0);
});

test('target disable during execution suppresses the reply',async()=>{
 const h=harness();const original=h.target;
 const operation=createAppCapabilityOperation({
  getInstallation:async id=>id==='consumer'?h.source:id==='provider'?original:null,
  assertEmployeeAccess:async()=>{},
  isPublished:async()=>true,
  resolveEmployee:async()=>({...employee,execution:{type:'application',appId:'provider'}}) as PlatformActorContext,
  invokeTarget:async()=>{original.enabled=false;return {created:true};}
 });
 await assert.rejects(operation.execute(h.context,{appId:'provider',apiId:'create',params:{}},new AbortController().signal),{code:'ACCESS_DENIED'});
});

test('target application role and data-scope denial has a clear error code',async()=>{
 const h=harness();
 for(const deniedBy of ['admission','handler']){
  const operation=createAppCapabilityOperation({
   getInstallation:async id=>id==='consumer'?h.source:id==='provider'?h.target:null,
   assertEmployeeAccess:async()=>{if(deniedBy==='admission')throw new EmployeeIdentityError(403,'EMPLOYEE_APP_ACCESS_DENIED');},
   isPublished:async()=>true,
   resolveEmployee:async()=>({...employee,execution:{type:'application',appId:'provider'}}) as PlatformActorContext,
   invokeTarget:async()=>{throw new AppStdioApiError('ACCESS_DENIED');},
  });
  await assert.rejects(operation.execute(h.context,{appId:'provider',apiId:'create',params:{}},new AbortController().signal),{code:'TARGET_APP_ACCESS_DENIED'});
 }
});

test('Gateway binds the live employee and audits source and target without payload fields',async()=>{
 const h=harness(),audits:Record<string,unknown>[]=[];
 const serviceActor={...h.context,employeeActor:undefined};
 const gateway=new AppGateway({
  registry:{authenticateServiceCredential:async()=>({actorType:'service',trustedIdentity:{source:'service'},execution:serviceActor.execution}) as never},
  contextResolver:{resolve:async()=>serviceActor},operations:[h.operation],
  auditRepository:{append:async record=>{audits.push(record as unknown as Record<string,unknown>);return record as never;}}
 });
 const request={version:'1.0',operation:'platform.apps.invoke',params:{appId:'provider',apiId:'create',params:{privateText:'do not audit'}}};
 try{
  await assert.rejects(gateway.invokeService('consumer','secret',request),{code:'ACCESS_DENIED'});
  assert.equal(h.invocations,0);
  const response=await gateway.invokeService('consumer','secret',request,undefined,undefined,async()=>employee as never);
  assert.deepEqual(JSON.parse(JSON.stringify(response.result)),{created:true});assert.equal(h.invocations,1);
  const audit=audits.at(-1)!;
  assert.deepEqual({...(audit.metadata as object)},{phase:'operation',deliveryConfirmed:false,targetAppId:'provider',apiId:'create',mode:'write'});
  assert.equal((audit.context as {appId:string}).appId,'consumer');
  assert.ok(!JSON.stringify(audit).includes('privateText'));
 }finally{await gateway.drain('consumer');}
});
