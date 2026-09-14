import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { startAppStdioGateway, APP_STDIO_GATEWAY_PREFIX } from '../src/app-platform/runtime/stdio-gateway.ts';
import assert from 'node:assert/strict';
import { createMemoryCoreTechnicalAuditRepository } from '../src/core/observability/index.ts';
import { createCoreEventBus } from '../src/core/events/index.ts';
import { AppExtensionRegistry, startAppExtensionRuntime } from '../src/app-platform/extensions/index.ts';
import test from 'node:test';
import { createAppGatewayClient, AppGatewayClientError } from '../../packages/platform-sdk/src/app-gateway.ts';
import { createServer } from 'node:http';
import { AppGateway, createAppGatewayHttpHandler, GatewayError, type AppGatewayOperation } from '../src/app-platform/gateway/index.ts';
import { AppRegistryService, MemoryAppRegistryRepository, type AppRegistryRepository } from '../src/app-platform/registry/index.ts';
import { buildAuthorizationSeed, createAuthorizationService, createMemoryAuthorizationRepository, AUTHORIZATION_ROLE_SEEDS } from '../src/platform/authorization/index.ts';
import { createPlatformActorContextResolver } from '../src/platform/context/index.ts';
import { createMemoryPeopleDirectoryRepository, type OrganizationUnit, type Person, type Position } from '../src/platform/people/index.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';

const now='2026-09-08T00:00:00.000Z';
const org='42000000-0000-4000-8000-000000000001',personId='42000000-0000-4000-8000-000000000002',positionId='42000000-0000-4000-8000-000000000003';
const otherOrg='42000000-0000-4000-8000-000000000004';
const permissionCode='platform.assets.read';
function manifest(): AppManifest { return {
  manifestVersion:'1.0',id:'tool-lending',version:'1.0.0',name:'借还',description:'借还测试',publisherId:'example',
  compatibility:{ platform:{ minInclusive:'0.0.1-alpha.34',maxExclusive:'2.0.0' },capabilities:[],applications:[] },
  permissions:{requested:[permissionCode],defined:[]},ui:{mode:'none'},backend:{mode:'none'},storage:{mode:'none'},routes:[],api:[],navigation:[],
  events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],artifacts:[],network:{frontendOrigins:[],backendOrigins:[]}
}; }
async function setup(repository: AppRegistryRepository) {
  let time=new Date(now);
  const organization: OrganizationUnit={id:org,parentId:null,code:'team',name:'工班',shortName:null,unitType:'workgroup',status:'active',sortOrder:0,createdAt:now,updatedAt:now};
  const position: Position={id:positionId,code:'maintainer',name:'检修工',description:null,status:'active',createdAt:now,updatedAt:now};
  const person: Person={id:personId,employeeNo:'001',name:'张三',phone:null,organizationUnitId:org,positionId,employmentStatus:'active',avatarUrl:null,createdAt:now,updatedAt:now};
  const people=createMemoryPeopleDirectoryRepository({ organizationUnits:[organization],positions:[position],people:[person] });
  const authRepo=createMemoryAuthorizationRepository(buildAuthorizationSeed(now));
  const authorization=createAuthorizationService(authRepo,{clock:()=>time,findPerson:async(id)=>people.findPersonById(id)});
  const permission=await authorization.registerPermission({code:permissionCode,name:'读资产'});
  const roleId=AUTHORIZATION_ROLE_SEEDS[0].id;
  await authorization.assignRole({personId,roleId});
  await authorization.grantRolePermission({roleId,permissionId:permission.id,scope:{kind:'organization',targets:[]}});
  const registry=new AppRegistryService(repository,{authorization,clock:()=>time,host:()=>({platformVersion:'0.0.1-alpha.35',capabilities:[],applications:[]})});
  const resolver=createPlatformActorContextResolver({people,authorization,resolveAppGrant:registry.createGrantResolver(),clock:()=>time});
  const request={requestId:'request',traceId:'trace'};
  const identity={actorType:'person' as const,trustedIdentity:{source:'session' as const,userId:personId},...request};
  const admin=await resolver.resolve({...identity,execution:{type:'platform'}});
  const application=await resolver.resolve({...identity,execution:{type:'application',appId:'tool-lending'}});
  return {people,registry,admin,application,resolver,authorization,permission,roleId,request,setTime:(value:string)=>{time=new Date(value);}};
}

async function gatewayFixture(limits = {}, extensions = false) {
  const f=await setup(new MemoryAppRegistryRepository());
  const declared=manifest();
  if(extensions){declared.backend={mode:'external',origin:'https://example.com'};declared.jobs=[{id:'sync',handler:'sync',intervalSeconds:60}];}
  let r=await f.registry.register(f.admin,declared);
  const issued=await f.registry.issueServiceCredential(f.admin,r.appId,r.revision);r=issued.installation;
  r=await f.registry.setEnabled(f.admin,r.appId,r.revision,true);
  r=await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'service',permissionCode,serviceIdentityId:r.serviceIdentityId!,scope:{kind:'explicit',targets:[{type:'organization',id:org}]}});
  r=await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode,scope:{kind:'all',targets:[]}});
  let execute:AppGatewayOperation['execute']=async()=>({ok:true});
  const operation:AppGatewayOperation={name:'assets.read',permissionCode,mode:'read',validateParams:v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).join(',')==='target',resolveResources:async(_ctx,p)=>[{organizationUnitId:(p as {target:string}).target}],execute:(...args)=>execute(...args),validateResult:v=>!!v&&typeof v==='object'};
  const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[operation],limits});
  const request={version:'1.0',operation:'assets.read',params:{target:org}};
  return {...f,gateway,request,issued,r,operation,setExecute:(fn:AppGatewayOperation['execute'])=>{execute=fn;},call:()=>gateway.invokeService(r.appId,issued.credential,request)};
}
test('gateway actual registry credentials, exact envelope and delegated user/app intersection',async()=>{
 const f=await gatewayFixture();assert.deepEqual(JSON.parse(JSON.stringify((await f.call()).result)),{ok:true});
 await assert.rejects(f.gateway.invokeService(f.r.appId,'wrong',f.request),/INVALID_CREDENTIAL/);
 for(const req of [{...f.request,actor:{userId:personId}},{...f.request,operation:'unknown'},{...f.request,version:'2'},{...f.request,params:{target:otherOrg}}]) await assert.rejects(f.gateway.invokeService(f.r.appId,f.issued.credential,req));
 const identity={source:'session' as const,userId:personId};
 await f.gateway.invokeDelegated(f.r.appId,identity,f.request);
 await f.authorization.revokeRolePermission(f.roleId,f.permission.id);
 await assert.rejects(f.gateway.invokeDelegated(f.r.appId,identity,f.request),/ACCESS_DENIED/);
 await f.call();
});
test('fresh checks suppress results after revoke, disable and rotation',async()=>{
 for(const change of ['revoke','disable','rotate']) {
  const f=await gatewayFixture();f.setExecute(async()=>{
   if(change==='disable') await f.registry.setEnabled(f.admin,f.r.appId,f.r.revision,false);
   if(change==='revoke') await f.registry.revokeGrant(f.admin,f.r.appId,f.r.revision,f.r.grants.find(g=>g.mode==='service')!.grantId);
   if(change==='rotate') await f.registry.issueServiceCredential(f.admin,f.r.appId,f.r.revision);
   return {secret:'hidden'};
  });await assert.rejects(f.call(),/ACCESS_DENIED|INVALID_CREDENTIAL/);
 }
});
test('bounded immutable params/results and errors never leak implementation detail',async()=>{
 const f=await gatewayFixture({requestBytes:1024,resultBytes:64});
 f.setExecute(async(_ctx,p)=>{assert.ok(Object.isFrozen(p));return {large:'x'.repeat(100)};});await assert.rejects(f.call(),/PAYLOAD_TOO_LARGE/);
 f.setExecute(async()=>{throw new Error('credential-secret');});await assert.rejects(f.call(),error=>error instanceof GatewayError&&error.message==='GATEWAY_FAILED');
 await assert.rejects(f.gateway.invokeService(f.r.appId,f.issued.credential,{...f.request,params:{target:'x'.repeat(2000)}}),/PAYLOAD_TOO_LARGE/);
});
test('timeouts retain slots until actual settlement and writes remain uncertain',async()=>{
 const f=await gatewayFixture({timeoutMs:20,concurrency:1});let resolve!:(v:unknown)=>void;
 f.setExecute(async(_ctx,_p,signal)=>new Promise(r=>{resolve=r;signal.addEventListener('abort',()=>assert.equal(signal.aborted,true));}));
 await assert.rejects(f.call(),/TIMEOUT/);await assert.rejects(f.call(),/BUSY/);resolve({ok:true});await new Promise(r=>setImmediate(r));
 f.setExecute(async()=>({ok:true}));await f.call();
 const write=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[{...f.operation,mode:'write',execute:async()=>{throw new Error('unknown commit');}}]});
 await assert.rejects(write.invokeService(f.r.appId,f.issued.credential,f.request),e=>e instanceof GatewayError&&e.writeOutcome==='unknown');
});
test('app rate budget survives credential rotation and global preauth is shared',async()=>{
 const f=await gatewayFixture({appRequests:1});await f.call();
 const rotated=await f.registry.issueServiceCredential(f.admin,f.r.appId,f.r.revision);
 await assert.rejects(f.gateway.invokeService(f.r.appId,rotated.credential,f.request),/RATE_LIMITED/);
 const g=await gatewayFixture({globalRequests:1});await assert.rejects(g.gateway.invokeService('other','bad',g.request));await assert.rejects(g.call(),/RATE_LIMITED/);
});
test('HTTP POST bearer boundary rejects spoofed identities, cookies and oversized bodies',async()=>{
 const f=await gatewayFixture({requestBytes:512});const server=createServer(createAppGatewayHttpHandler(f.gateway,f.r.appId));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address();assert.ok(addr&&typeof addr==='object');const url=`http://127.0.0.1:${addr.port}`;
 try {
 const send=(body:unknown,auth=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${f.issued.credential}`}:{cookie:'session=admin'})},body:JSON.stringify(body)});
 assert.equal((await send(f.request)).status,200);
 const client=createAppGatewayClient(async(request)=>{const response=await send(request);return response.json();});
 assert.deepEqual(JSON.parse(JSON.stringify(await client.invoke('assets.read',{target:org}))),{ok:true});
 await assert.rejects(client.invoke('assets.read',{target:otherOrg}),e=>e instanceof AppGatewayClientError&&e.code==='ACCESS_DENIED'&&e.writeOutcome==='not_started');
 assert.equal((await send(f.request,false)).status,401);
 assert.equal((await send({...f.request,actor:{userId:personId}})).status,400);
 assert.equal((await send({...f.request,params:{target:'x'.repeat(600)}})).status,413);
 assert.equal((await fetch(url)).status,405);
 }finally{server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});

test('aborted calls cannot execute and expiry/default grants fail closed',async()=>{
 const f=await gatewayFixture();let calls=0;f.setExecute(async()=>{calls++;return {};});
 const controller=new AbortController();controller.abort();await assert.rejects(f.gateway.invokeService(f.r.appId,f.issued.credential,f.request,controller.signal),/ABORTED/);assert.equal(calls,0);
 let r=await f.registry.revokeGrant(f.admin,f.r.appId,f.r.revision,f.r.grants.find(g=>g.mode==='service')!.grantId);
 await assert.rejects(f.call(),/ACCESS_DENIED/);assert.equal(calls,0);
 r=await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'service',permissionCode,serviceIdentityId:r.serviceIdentityId!,scope:{kind:'all',targets:[]},effectiveTo:'2026-09-09T00:00:00.000Z'});
 f.setTime('2026-09-09T00:00:00.000Z');await assert.rejects(f.call(),/ACCESS_DENIED/);assert.equal(calls,0);
});
test('strict JSON rejects cycles, prototypes, sparse arrays and getters without invoking getters',async()=>{
 const f=await gatewayFixture();let getters=0;
 const cycle:Record<string,unknown>={};cycle.self=cycle;
 const accessor=Object.defineProperty({},'target',{enumerable:true,get(){getters++;return org;}});
 const array=Object.defineProperty([1],0,{enumerable:true,get(){getters++;return 1;}});
 for(const params of [cycle,accessor,array,Object.setPrototypeOf([],null),new Date(),[undefined],Array(1),JSON.parse('{"__proto__":{}}')]) await assert.rejects(f.gateway.invokeService(f.r.appId,f.issued.credential,{...f.request,params}),/INVALID_PAYLOAD/);
 assert.equal(getters,0);
});
test('bounded admission refuses new keys without evicting live windows',async()=>{
 const f=await gatewayFixture({maxRateKeys:2});await assert.rejects(f.call(),/RATE_LIMITED/);
});

test('delegated person freshness rejects inactive identity before returning data',async()=>{
 const f=await gatewayFixture();const profile=f.people.getPersonProfile.bind(f.people);
 f.setExecute(async()=>{f.people.getPersonProfile=async(id)=>{const p=await profile(id);return p?{...p,person:{...p.person,employmentStatus:'inactive'}}:null;};return {ok:true};});
 await assert.rejects(f.gateway.invokeDelegated(f.r.appId,{source:'session',userId:personId},f.request),/GATEWAY_FAILED/);
});
test('public error codes cannot contain adapter secrets and HTTP charges preauth once',async()=>{
 assert.equal(new GatewayError('secret credential').message,'GATEWAY_FAILED');
 const f=await gatewayFixture({globalRequests:1});
 await f.gateway.invokeServiceFromTransport(f.r.appId,async()=>({credential:f.issued.credential,request:f.request}));
 await assert.rejects(f.call(),/RATE_LIMITED/);
});
test('named managed-data adapter derives tenant from context and rejects cross-app targets before execution',async()=>{
 const f=await gatewayFixture();let executed=0;
 const rows=new Map([['own',{appId:f.r.appId,organizationUnitId:org}],['other',{appId:'other-app',organizationUnitId:org}],['denied',{appId:f.r.appId,organizationUnitId:otherOrg}]]);
 const op:AppGatewayOperation={name:'managed.rows.read',permissionCode,mode:'read',
  validateParams:value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).join(',')==='rowId'&&typeof (value as {rowId:unknown}).rowId==='string',
  resolveResources:async(context,params)=>{
   const row=rows.get((params as {rowId:string}).rowId);
   if(!row||context.execution.type==='platform'||row.appId!==context.execution.appId) throw new GatewayError('ACCESS_DENIED',403);
   return [{organizationUnitId:row.organizationUnitId}];
  },
  execute:async(context)=>{executed++;assert.notEqual(context.execution.type,'platform');return {tenant:context.execution.type==='platform'?'':context.execution.appId};},
  validateResult:value=>!!value&&typeof value==='object'
 };
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[op]});
 const call=(params:unknown)=>gateway.invokeService(f.r.appId,f.issued.credential,{version:'1.0',operation:op.name,params});
 assert.equal(((await call({rowId:'own'})).result as {tenant:string}).tenant,f.r.appId);
 for(const params of [{rowId:'other'},{rowId:'denied'},{rowId:'own',appId:'other-app'},{rowId:'own',sql:'SELECT 1'}]) await assert.rejects(call(params),/ACCESS_DENIED|INVALID_PARAMS/);
 assert.equal(executed,1);
});

test('direct callers cannot mutate params after invocation starts',async()=>{
 const f=await gatewayFixture();
 const service=f.call();f.request.params.target=otherOrg;await service;
 f.request.params.target=org;
 const delegated=f.gateway.invokeDelegated(f.r.appId,{source:'session',userId:personId},f.request);f.request.params.target=otherOrg;await delegated;
});

test('timeout audits pending work promptly and eventual settlement never duplicates terminal audit',async()=>{
 const f=await gatewayFixture();let settle!:(value:unknown)=>void;
 const records:unknown[]=[];
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[{...f.operation,execute:async()=>new Promise(resolve=>{settle=resolve;})}],limits:{timeoutMs:10,concurrency:1},auditRepository:{append:async(input)=>{records.push(input);return {...input,id:'audit',createdAt:now,metadata:input.metadata??{}};}}});
 await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request),/TIMEOUT/);
 assert.equal(records.length,1);assert.equal((records[0] as {errorCode:string}).errorCode,'TIMEOUT');
 await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request),/BUSY/);
 settle({ok:true});await new Promise(resolve=>setImmediate(resolve));assert.equal(records.length,1);
});
test('failed or stuck audit returns AUDIT_FAILED within a bounded grace period',{timeout:2000},async()=>{
 for(const hang of [false,true]) {
  const f=await gatewayFixture();let settle!:(value:unknown)=>void;let attempts=0;
  const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[{...f.operation,mode:'write',execute:async()=>new Promise(resolve=>{settle=resolve;})}],limits:{timeoutMs:10},auditRepository:{append:async()=>{attempts++;if(hang)return new Promise(()=>{});throw new Error('sink secret');}}});
  await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request),error=>error instanceof GatewayError&&error.code==='AUDIT_FAILED'&&error.writeOutcome==='unknown');
  assert.equal(attempts,1);settle({ok:true});await new Promise(resolve=>setTimeout(resolve,110));assert.equal(attempts,1);
 }
});
test('unconfirmed success audit retains admission and does not claim delivery',async()=>{
 const f=await gatewayFixture();let settleAudit!:(value:never)=>void;let record:Record<string,unknown>|undefined;
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[f.operation],limits:{concurrency:1,timeoutMs:500},auditRepository:{append:async(input)=>{record=input.metadata;return new Promise(resolve=>{settleAudit=resolve;});}}});
 await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request),/AUDIT_FAILED/);
 assert.equal(record?.phase,'operation');assert.equal(record?.deliveryConfirmed,false);
 await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request),/BUSY/);
 settleAudit(undefined as never);await new Promise(resolve=>setImmediate(resolve));
});

test('extension invokes actual credential gateway and fresh scoped L3 grants',async()=>{
 const f=await gatewayFixture({},true);let calls=0;f.setExecute(async()=>{calls++;return {ok:true};});
 const actor=await f.resolver.resolve({...await f.registry.authenticateServiceCredential(f.r.appId,f.issued.credential),requestId:'extensions',traceId:'extensions'});
 const extensions=new AppExtensionRegistry({
  getInstallation:appId=>f.registry.get(f.admin,appId),
  authorize:async(context,permission)=>(await context.authorize(permission,{organizationUnitId:org})).allowed,
  executeGateway:async(_context,operation,params,signal)=>(await f.gateway.invokeService(f.r.appId,f.issued.credential,{version:'1.0',operation,params},signal)).result,
 });
 const handle=extensions.activate(f.r,[{kind:'job',id:'sync',permissionCode,operation:'assets.read'}]);
 await handle.invoke(actor,'job','sync',{target:org});assert.equal(calls,1);
 await assert.rejects(handle.invoke(actor,'job','sync',{target:otherOrg}));assert.equal(calls,1);
 await f.registry.setEnabled(f.admin,f.r.appId,f.r.revision,false);
 await assert.rejects(handle.invoke(actor,'job','sync',{target:org}),/STALE_EXTENSION/);assert.equal(calls,1);
});

test('lifecycle start cuts off actual gateway and stale extension callbacks before settlement',async()=>{
 const f=await gatewayFixture({},true);let calls=0;f.setExecute(async()=>{calls++;return {ok:true};});
 const actor=await f.resolver.resolve({...await f.registry.authenticateServiceCredential(f.r.appId,f.issued.credential),requestId:'lifecycle',traceId:'lifecycle'});
 const extensions=new AppExtensionRegistry({
  getInstallation:appId=>f.registry.get(f.admin,appId),
  authorize:async(context,code)=>(await context.authorize(code,{organizationUnitId:org})).allowed,
  executeGateway:async(_context,operation,params,signal)=>(await f.gateway.invokeService(f.r.appId,f.issued.credential,{version:'1.0',operation,params},signal)).result,
 });
 const handle=extensions.activate(f.r,[{kind:'job',id:'sync',permissionCode,operation:'assets.read'}]);
 await handle.invoke(actor,'job','sync',{target:org});assert.equal(calls,1);
 const pending=await f.registry.beginLifecycle(f.admin,f.r.appId,f.r.revision,'disable');
 assert.equal(pending.enabled,false);
 await assert.rejects(handle.invoke(actor,'job','sync',{target:org}),/STALE_EXTENSION/);
 await assert.rejects(f.call(),/INVALID_CREDENTIAL/);
 assert.equal((await actor.authorize(permissionCode,{organizationUnitId:org})).allowed,false);
 assert.equal(calls,1);
 const disabled=await f.registry.settleLifecycle(f.admin,pending.appId,pending.revision,pending.lifecycle!.operationId,'completed');
 await assert.rejects(f.registry.setEnabled(f.admin,disabled.appId,disabled.revision,true));
 const enabling=await f.registry.beginLifecycle(f.admin,disabled.appId,disabled.revision,'enable');
 const enabled=await f.registry.settleLifecycle(f.admin,enabling.appId,enabling.revision,enabling.lifecycle!.operationId,'completed');
 await f.call();assert.equal(calls,2);
 await assert.rejects(handle.list(actor),/STALE_EXTENSION/);
 const fresh=extensions.activate(enabled,[{kind:'job',id:'sync',permissionCode,operation:'assets.read'}]);
 await fresh.invoke(actor,'job','sync',{target:org});assert.equal(calls,3);
});

test('lifecycle teardown cannot settle a stuck gateway execution merely because ingress closed',async()=>{
 const f=await gatewayFixture({},true);
 const actor=await f.resolver.resolve({...await f.registry.authenticateServiceCredential(f.r.appId,f.issued.credential),requestId:'runtime',traceId:'runtime'});
 const extensions=new AppExtensionRegistry({getInstallation:appId=>f.registry.get(f.admin,appId),authorize:async(context,code)=>(await context.authorize(code,{organizationUnitId:org})).allowed,executeGateway:async(_ctx,operation,params,signal)=>(await f.gateway.invokeService(f.r.appId,f.issued.credential,{version:'1.0',operation,params},signal)).result});
 const handle=extensions.activate(f.r,[{kind:'job',id:'sync',permissionCode,operation:'assets.read'}]);
 const session=await startAppExtensionRuntime({handle,bus:createCoreEventBus(),resolveActor:async()=>actor,drainGateway:()=>f.gateway.drain(f.r.appId),shutdownTimeoutMs:100});
 let entered!:()=>void,release!:(value:unknown)=>void;
 const started=new Promise<void>(resolve=>{entered=resolve;});
 f.setExecute(async()=>{entered();return new Promise(resolve=>{release=resolve;});});
 const invocation=handle.invoke(actor,'job','sync',{target:org});const rejected=assert.rejects(invocation);
 await started;
 const disabled=await f.registry.beginLifecycle(f.admin,f.r.appId,f.r.revision,'disable');
 // The registry only records intent; teardown must independently prove resources drained.
 await assert.rejects(session.stop(),/EXTENSION_RUNTIME_TIMEOUT/);await rejected;
 assert.equal((await f.registry.get(f.admin,disabled.appId)).lifecycle?.status,'running');
 release({ok:true});await session.stop();
 await f.registry.settleLifecycle(f.admin,disabled.appId,disabled.revision,disabled.lifecycle!.operationId,'completed');
});

test('gateway drain retains unconfirmed audit after bounded caller failure',async()=>{
 const f=await gatewayFixture();let finish!:()=>void;
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[f.operation],auditRepository:{append:async input=>{await new Promise<void>(resolve=>{finish=resolve;});return createMemoryCoreTechnicalAuditRepository().append(input);}}});
 await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request),/AUDIT_FAILED/);
 let drained=false;const pending=gateway.drain(f.r.appId).then(()=>{drained=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 await gateway.drain('other-app');finish();await pending;assert.equal(drained,true);
});


test('host-held stdio credentials use fresh registry checks before execution and before results',async()=>{
 for(const change of ['disable','revoke','rotate','grant']) for(const during of [false,true]) {
  const f=await gatewayFixture();
  const stdout=new PassThrough(),stdin=new PassThrough();
  const session=startAppStdioGateway({appId:f.r.appId,serviceCredential:f.issued.credential,gateway:f.gateway,stdout,stdin});
  let executed=0;
  const mutate=async()=>{
   if(change==='disable') await f.registry.setEnabled(f.admin,f.r.appId,f.r.revision,false);
   if(change==='revoke') await f.registry.revokeServiceCredential(f.admin,f.r.appId,f.r.revision);
   if(change==='rotate') await f.registry.issueServiceCredential(f.admin,f.r.appId,f.r.revision);
   if(change==='grant') await f.registry.revokeGrant(f.admin,f.r.appId,f.r.revision,f.r.grants.find(g=>g.mode==='service')!.grantId);
  };
  f.setExecute(async()=>{executed++;if(during)await mutate();return {secret:'hidden-result'};});
  try {
   if(!during)await mutate();
   const reply=new Promise<string>(resolve=>stdin.once('data',chunk=>resolve(chunk.toString())));
   stdout.write(APP_STDIO_GATEWAY_PREFIX+JSON.stringify({id:randomUUID(),request:f.request})+'\n');
   const wire=await reply;
   const body=JSON.parse(wire.slice(APP_STDIO_GATEWAY_PREFIX.length));
   assert.equal(body.error.code,change==='grant'?'ACCESS_DENIED':'INVALID_CREDENTIAL');
   assert.equal(executed,during?1:0);
   assert.ok(!wire.includes(f.issued.credential));assert.ok(!wire.includes('hidden-result'));
  } finally {await session.stop();}
 }
});
