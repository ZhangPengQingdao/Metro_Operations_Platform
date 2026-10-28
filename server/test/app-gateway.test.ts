import assert from 'node:assert/strict';
import { createMemoryCoreTechnicalAuditRepository } from '../src/core/observability/index.ts';
import test from 'node:test';
import { AppGateway } from '../src/app-platform/gateway/gateway.ts';
import { GatewayError, type AppGatewayOperation } from '../src/app-platform/gateway/model.ts';
import { GatewayAdmission } from '../src/app-platform/gateway/limits.ts';
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

async function gatewayFixture(limits = {}) {
  const f=await setup(new MemoryAppRegistryRepository());
  const declared=manifest();
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
 f.setExecute(async()=>{throw new GatewayError('KNOWLEDGE_EMBEDDING_UNAVAILABLE',502);});await assert.rejects(f.call(),error=>error instanceof GatewayError&&error.code==='KNOWLEDGE_EMBEDDING_UNAVAILABLE'&&error.statusCode===502);
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
test('service calls use the aggregate app budget while people retain their actor budget',()=>{
 const admission=new GatewayAdmission({appRequests:4,actorRequests:2});
 for(let index=0;index<4;index++)admission.authenticated('files','service');
 admission.authenticated('people','person-1');admission.authenticated('people','person-1');
 assert.throws(()=>admission.authenticated('people','person-1'),/RATE_LIMITED/);
 assert.throws(()=>admission.authenticated('files','service'),/RATE_LIMITED/);
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
 const f=await gatewayFixture({maxRateKeys:1});await assert.rejects(f.call(),/RATE_LIMITED/);
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

test('gateway drain retains unconfirmed audit after bounded caller failure',async()=>{
 const f=await gatewayFixture();let finish!:()=>void;
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[f.operation],auditRepository:{append:async input=>{await new Promise<void>(resolve=>{finish=resolve;});return createMemoryCoreTechnicalAuditRepository().append(input);}}});
 await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request),/AUDIT_FAILED/);
 let drained=false;const pending=gateway.drain(f.r.appId).then(()=>{drained=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 await gateway.drain('other-app');finish();await pending;assert.equal(drained,true);
});


test('read checkpoints avoid duplicate admission work and still reject revocation during resource lookup',async()=>{
 const f=await gatewayFixture();let checks=0;
 const guard=async()=>{checks++;};
 await f.gateway.invokeService(f.r.appId,f.issued.credential,f.request,undefined,guard);
 assert.equal(checks,4,'one context and one authorization admission per execution/result checkpoint');
 let revoked=false,executed=false;
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[{...f.operation,
  resolveResources:async()=>{revoked=true;return [{organizationUnitId:org}];},
  execute:async()=>{executed=true;return {ok:true};}}]});
 await assert.rejects(gateway.invokeService(f.r.appId,f.issued.credential,f.request,undefined,async()=>{if(revoked)throw Error('revoked');}),/ACCESS_DENIED/);
 assert.equal(executed,false);
});
