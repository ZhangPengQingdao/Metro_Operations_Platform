import { AppDockerExecutorError } from '../src/app-platform/runtime/docker-executor.ts';
import { createHash } from 'node:crypto';
import { AppDockerTransport, AppDockerExecutor, AppDockerJournal, APP_DOCKER_REJECTION_MIGRATIONS, APP_DOCKER_JOURNAL_MIGRATIONS } from '../src/app-platform/runtime/index.ts';
import { createAppLifecycleManagement } from '../src/app-platform/runtime/lifecycle-management.ts';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppRuntimeComposition } from '../src/app-platform/runtime/composition.ts';
import { AppLifecycleHost } from '../src/app-platform/runtime/lifecycle-host.ts';
import { AppGateway } from '../src/app-platform/gateway/gateway.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AppRegistryService, MemoryAppRegistryRepository, PostgresAppRegistryRepository, APP_REGISTRY_MIGRATIONS, type AppRegistryRepository } from '../src/app-platform/registry/index.ts';
import { buildAuthorizationSeed, createAuthorizationService, createMemoryAuthorizationRepository, AUTHORIZATION_ROLE_SEEDS } from '../src/platform/authorization/index.ts';
import { createPlatformActorContextResolver } from '../src/platform/context/index.ts';
import { createMemoryPeopleDirectoryRepository, type OrganizationUnit, type Person, type Position } from '../src/platform/people/index.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';
import { runAtomicOperation, type QueryableClient } from '../src/core/database/index.ts';

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
  let hostVersion = '0.0.1-alpha.35', hostFails = false;
  const registry=new AppRegistryService(repository,{authorization,clock:()=>time,host:()=>{ if(hostFails) throw new Error('host unavailable'); return {platformVersion:hostVersion,capabilities:[],applications:[]}; }});
  const resolver=createPlatformActorContextResolver({people,authorization,resolveAppGrant:registry.createGrantResolver(),clock:()=>time});
  const request={requestId:'request',traceId:'trace'};
  const identity={actorType:'person' as const,trustedIdentity:{source:'session' as const,userId:personId},...request};
  const admin=await resolver.resolve({...identity,execution:{type:'platform'}});
  const application=await resolver.resolve({...identity,execution:{type:'application',appId:'tool-lending'}});
  return {registry,admin,application,resolver,authorization,permission,roleId,request,setHost:(version:string, fails=false)=>{hostVersion=version;hostFails=fails;},setTime:(value:string)=>{time=new Date(value);}};
}

async function hostFixture() {
 const f=await setup(new MemoryAppRegistryRepository());
 const root=await mkdtemp(join(tmpdir(),'host-'));
 let held=false;const sessions:EventEmitter[]=[];
 const connect=async()=>{
  const events=new EventEmitter();sessions.push(events);let mine=false;
  return Object.assign(events,{
   query:async(sql:string)=>{if(sql.includes('platform_app_runtime_work'))return {rows:[]};if(sql.includes('pg_try_advisory_lock')){if(held)return {rows:[{locked:false}]};held=true;mine=true;return {rows:[{locked:true}]};}return {rows:[{held:mine&&held}]};},
   end:async()=>{if(mine){held=false;mine=false;}events.emit('end');}
  });
 };
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[]});
 const options={appId:'tool-lending',registry:f.registry,gateway,connectLease:connect,artifactRoot:root,readArtifact:async()=>new Uint8Array()};
 const host=new AppLifecycleHost(options);
 return {...f,host,options,sessions,close:()=>rm(root,{recursive:true,force:true})};
}
test('lifecycle host completes static install disable enable upgrade rollback and retained uninstall',async()=>{
 const f=await hostFixture();try{
  let r=await f.registry.register(f.admin,manifest());
  r=await f.host.execute(f.admin,{revision:r.revision,action:'install'});assert.equal(r.enabled,true);
  assert.equal((await f.host.status(f.admin)).serving,true);
  r=await f.host.execute(f.admin,{revision:r.revision,action:'disable'});assert.equal(r.enabled,false);
  r=await f.host.execute(f.admin,{revision:r.revision,action:'enable'});assert.equal(r.enabled,true);
  const id=r.id;
  r=await f.host.execute(f.admin,{revision:r.revision,action:'upgrade',targetManifest:{...manifest(),version:'1.1.0'}});
  assert.equal(r.enabled,false);assert.equal(r.manifest.version,'1.1.0');assert.equal(r.id,id);
  r=await f.host.execute(f.admin,{revision:r.revision,action:'rollback',targetManifest:manifest()});assert.equal(r.manifest.version,'1.0.0');
  r=await f.host.execute(f.admin,{revision:r.revision,action:'uninstall'});assert.equal(r.id,id);assert.equal(r.lifecycle?.status,'completed');
  await assert.rejects(f.host.execute(f.admin,{revision:r.revision,action:'enable'}),/LIFECYCLE_BLOCKED/);
 }finally{await f.close();}
});
test('lifecycle host rejects stale or application callers and competing owners',async()=>{
 const f=await hostFixture();try{
  let r=await f.registry.register(f.admin,manifest());
  await assert.rejects(f.host.execute(f.application,{revision:r.revision,action:'install'}),/ACCESS_DENIED/);
  await assert.rejects(f.host.execute(f.admin,{revision:99,action:'install'}),/STALE_REVISION/);
  r=await f.host.execute(f.admin,{revision:r.revision,action:'install'});
  const other=new AppLifecycleHost(f.options);
  await assert.rejects(other.recover(f.admin,r.revision),/LEASE_BUSY/);
  r=await f.host.execute(f.admin,{revision:r.revision,action:'disable'});
  assert.equal(r.enabled,false);
 }finally{await f.close();}
});
test('lifecycle host lost lease closes serving and same instance can recover with a fresh session',async()=>{
 const f=await hostFixture();try{
  let r=await f.registry.register(f.admin,manifest());r=await f.host.execute(f.admin,{revision:r.revision,action:'install'});
  f.sessions[0].emit('error');assert.equal((await f.host.status(f.admin)).serving,false);
  r=await f.host.recover(f.admin,r.revision);assert.equal(r.enabled,false);assert.equal(r.lifecycle?.status,'cancelled');
  assert.ok(f.sessions.length>1);assert.equal((await f.host.status(f.admin)).owned,false);
 }finally{await f.close();}
});
test('lifecycle host interrupted external startup stays disabled and recover quiesces without retrying start',async()=>{
 const f=await hostFixture();let checks=0,stops=0;try{
  const host=new AppLifecycleHost({...f.options,external:{check:async()=>{checks++;throw Error('private');},stop:async()=>{stops++;}}});
  let r=await f.registry.register(f.admin,{...manifest(),backend:{mode:'external',origin:'https://example.com'}});
  await assert.rejects(host.execute(f.admin,{revision:r.revision,action:'install'}),/RECOVERY_REQUIRED/);
  r=await f.registry.get(f.admin,r.appId);assert.equal(r.enabled,false);assert.equal(r.lifecycle?.status,'failed');
  r=await host.recover(f.admin,r.revision);assert.equal(r.lifecycle?.status,'cancelled');assert.equal(checks,1);assert.equal(stops,2);
 }finally{await f.close();}
});

test('management accepts intent only and rejects identity credentials settlement evidence and non-native callers',async()=>{
 const f=await hostFixture();try{
  let r=await f.registry.register(f.admin,manifest());
  const handler=createAppLifecycleManagement({host:f.host,resolveContext:async()=>f.admin});
  const send=(body:unknown)=>handler(new Request('http://localhost/lifecycle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  for(const extra of [{credential:'secret'},{actor:{}},{healthy:true},{operationId:'fake'},{socketPath:'/tmp/docker.sock'}])assert.equal((await send({operation:'execute',revision:r.revision,action:'install',...extra})).status,400);
  assert.equal((await send({operation:'settle',revision:r.revision})).status,400);
  assert.equal((await send({operation:'execute',revision:r.revision,action:'install'})).status,200);
  r=await f.registry.get(f.admin,r.appId);
  const denied=createAppLifecycleManagement({host:f.host,resolveContext:async()=>f.application});
  assert.equal((await denied(new Request('http://localhost/lifecycle'))).status,403);
  assert.equal((await send({operation:'execute',revision:r.revision,action:'disable'})).status,200);
 }finally{await f.close();}
});

test('real Docker lifecycle host installs disables upgrades reenables and removes exact containers',{
 skip:!process.env.AFC_DOCKER_TEST_SOCKET||!process.env.AFC_DOCKER_TEST_IMAGE||!process.env.AFC_DOCKER_TEST_ROOT,
 timeout:90000,
},async()=>{
 const f=await hostFixture();const db=new PGlite();
 const client:QueryableClient={query:async(sql,values)=>values?db.query(sql,[...values]):db.exec(sql)};
 let host:AppLifecycleHost|undefined;
 let admin=f.admin;
 let registry=f.registry;
 const root=await mkdtemp(join(process.env.AFC_DOCKER_TEST_ROOT!,'.afc-host-test-'));
 try {
  for(const migration of [...APP_REGISTRY_MIGRATIONS,...APP_DOCKER_JOURNAL_MIGRATIONS])await migration.run({client});
  const persisted=await setup(new PostgresAppRegistryRepository(client));registry=persisted.registry;admin=persisted.admin;
  const source=Buffer.from("require('node:http').createServer((req,res)=>res.end('ok')).listen(8080,'127.0.0.1');process.on('SIGTERM',()=>process.exit(0));");
  const m=manifest();m.backend={mode:'isolated',runtime:'node',entryArtifactId:'main',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}};
  m.health={path:'/health',timeoutSeconds:1};m.artifacts=[{id:'main',kind:'backend',path:'main.js',bytes:source.length,sha256:createHash('sha256').update(source).digest('hex')}];
  const transport=new AppDockerTransport({socketPath:process.env.AFC_DOCKER_TEST_SOCKET!});
  const image=await transport.inspectImage(process.env.AFC_DOCKER_TEST_IMAGE!);assert.ok(image);
  const journal=new AppDockerJournal(client);
  host=new AppLifecycleHost({...f.options,registry,gateway:new AppGateway({registry,contextResolver:persisted.resolver,operations:[]}),artifactRoot:root,readArtifact:async()=>source,
   docker:{socketPath:process.env.AFC_DOCKER_TEST_SOCKET!,runtimeImage:process.env.AFC_DOCKER_TEST_IMAGE!,approval:{imageId:image.Id,config:image.Config},executor:new AppDockerExecutor(transport),journal}});
  let r=await registry.register(admin,m);
  r=await host.execute(admin,{revision:r.revision,action:'install'});assert.equal(r.enabled,true);
  const first=(await journal.latest(r.id))!.containerId;
  r=await host.execute(admin,{revision:r.revision,action:'disable'});assert.equal((await journal.latest(r.id))!.observation!.state,'absent');
  r=await host.execute(admin,{revision:r.revision,action:'upgrade',targetManifest:{...m,version:'1.1.0'}});assert.equal(r.enabled,false);
  r=await host.execute(admin,{revision:r.revision,action:'enable'});assert.equal(r.enabled,true);
  assert.notEqual((await journal.latest(r.id))!.containerId,first);
  r=await host.execute(admin,{revision:r.revision,action:'uninstall'});assert.equal(r.lifecycle!.status,'completed');
  assert.equal((await journal.latest(r.id))!.observation!.state,'absent');
 }finally{
  if(host){const r=await registry.get(admin,'tool-lending').catch(()=>null);if(r&&r.lifecycle?.action!=='uninstall')await host.recover(admin,r.revision);}
  await db.close();await rm(root,{recursive:true,force:true});await f.close();
 }
});


test('lifecycle recovery after definitive create rejection stays disabled without Docker cleanup or replay',async()=>{
 const f=await hostFixture();const db=new PGlite();
 const client:QueryableClient={query:async(sql,values)=>values?db.query(sql,[...values]):db.exec(sql)};
 let host:AppLifecycleHost|undefined;
 try{
  for(const migration of [...APP_REGISTRY_MIGRATIONS,...APP_DOCKER_JOURNAL_MIGRATIONS,...APP_DOCKER_REJECTION_MIGRATIONS])await migration.run({client});
  const p=await setup(new PostgresAppRegistryRepository(client));
  const source=Buffer.from('process.exit(0)');const m=manifest();
  m.backend={mode:'isolated',runtime:'node',entryArtifactId:'main',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}};
  m.health={path:'/health',timeoutSeconds:1};m.artifacts=[{id:'main',kind:'backend',path:'main.js',bytes:source.length,sha256:createHash('sha256').update(source).digest('hex')}];
  const executor=new AppDockerExecutor(new AppDockerTransport({socketPath:'/unused.sock'}));
  let creates=0;executor.create=async()=>{creates++;throw new AppDockerExecutorError('CREATE_REQUEST_REJECTED',false);};
  executor.observe=async()=>{assert.fail('recovery must not reinterpret terminal rejection');};
  executor.remove=async()=>{assert.fail('no container to remove');};
  const journal=new AppDockerJournal(client);
  host=new AppLifecycleHost({...f.options,registry:p.registry,gateway:new AppGateway({registry:p.registry,contextResolver:p.resolver,operations:[]}),readArtifact:async()=>source,
   docker:{socketPath:'/unused.sock',runtimeImage:`node@sha256:${'a'.repeat(64)}`,approval:{imageId:`sha256:${'b'.repeat(64)}`,config:{}},executor,journal}});
  let r=await p.registry.register(p.admin,m);
  // Simulate a fresh host after the previously approved credential was lost from memory.
  r=(await p.registry.issueServiceCredential(p.admin,r.appId,r.revision)).installation;
  r=await p.registry.approveGrant(p.admin,r.appId,r.revision,{mode:'service',permissionCode,scope:{kind:'all',targets:[]},serviceIdentityId:r.serviceIdentityId!});
  const identity=r.serviceIdentityId,grants=structuredClone(r.grants);
  await assert.rejects(host.execute(p.admin,{revision:r.revision,action:'install'}),/LIFECYCLE_RECOVERY_REQUIRED/);
  r=await p.registry.get(p.admin,m.id);
  assert.equal(r.serviceIdentityId,identity);assert.deepEqual(r.grants,grants);
  assert.equal(creates,1);assert.equal(r.enabled,false);assert.equal((await journal.latest(r.id))!.status,'rejected');
  r=await host.recover(p.admin,r.revision);assert.equal(r.enabled,false);assert.equal(r.lifecycle!.status,'cancelled');assert.equal(creates,1);
 }finally{await host?.close();await db.close();await f.close();}
});

test('employee Gateway ingress requires a serving lifecycle owner and closes on disable',async()=>{
 const f=await hostFixture();let reads=0;
 const gateway=new AppGateway({registry:f.registry,contextResolver:f.resolver,operations:[{
  name:'platform.assets.get',permissionCode,mode:'read',validateParams:()=>true,validateResult:()=>true,
  resolveResources:async()=>[{organizationUnitId:org}],execute:async()=>{reads++;return {ok:true};}
 }]});
 const host=new AppLifecycleHost({...f.options,gateway});
 const identity=async()=>({source:'session' as const,userId:personId});
 const request={version:'1.0',operation:'platform.assets.get',params:{}};
 try{
  let r=await f.registry.register(f.admin,manifest());
  await assert.rejects(host.invokeDelegated(identity,request),/ACCESS_DENIED/);
  await assert.rejects(host.admittedSnapshot(),/ACCESS_DENIED/);
  r=await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode,scope:{kind:'all',targets:[]}});
  r=await host.execute(f.admin,{revision:r.revision,action:'install'});
  assert.equal((await host.admittedSnapshot()).id,r.id);
  assert.equal((await host.invokeDelegated(identity,request)).result.ok,true);
  r=await host.execute(f.admin,{revision:r.revision,action:'disable'});
  await assert.rejects(host.admittedSnapshot(),/ACCESS_DENIED/);
  await assert.rejects(host.invokeDelegated(identity,request),/ACCESS_DENIED/);assert.equal(reads,1);
  r=await host.execute(f.admin,{revision:r.revision,action:'enable'});
  const live=f.sessions.filter(s=>s.listenerCount('error')>0).at(-1)!;
  live.emit('error');
  await assert.rejects(host.admittedSnapshot(),/ACCESS_DENIED/);
  await assert.rejects(host.invokeDelegated(identity,request),/ACCESS_DENIED/);assert.equal(reads,1);
 }finally{await host.close();await f.close();}
});


test('employee ingress lookup does not create runtime hosts and closes with composition',async()=>{
 const f=await hostFixture();const runtime=createAppRuntimeComposition(f.options);
 try{
  assert.equal(runtime.findHost('unknown-app'),undefined);
  const host=await runtime.getHost('tool-lending');
  assert.equal(runtime.findHost('tool-lending'),host);
  assert.equal(runtime.findHost('unknown-app'),undefined);
  await runtime.close();assert.equal(runtime.findHost('tool-lending'),undefined);
 }finally{await runtime.close();await f.close();}
});

test('planned maintenance pauses and restores a real lifecycle host across host recreation',async()=>{
 const {PlatformMaintenance}=await import('../src/app-platform/updates/maintenance.js');
 const f=await hostFixture();let blocked=false;let host=new AppLifecycleHost({...f.options,maintenanceBlocked:()=>blocked});
 try{
  let record=await f.registry.register(f.admin,manifest());record=await host.execute(f.admin,{revision:record.revision,action:'install'});
  const task='00000000-0000-4000-8000-000000000011',actor='00000000-0000-4000-8000-000000000012';
  const adapter={list:async()=>[await f.registry.get(f.admin,record.appId)],status:()=>host.status(f.admin),gate:(value:boolean)=>{blocked=value;},drain:()=>host.drainForMaintenance(),change:(_appId:string,revision:number,action:'enable'|'disable')=>host.execute(f.admin,{revision,action})};
  const path=join(f.options.artifactRoot,'maintenance.json');const maintenance=new PlatformMaintenance(adapter,path);await maintenance.initialize();
  await maintenance.prepare(task,actor);assert.equal((await host.status(f.admin)).serving,false);assert.equal(blocked,true);
  await host.close();host=new AppLifecycleHost({...f.options,maintenanceBlocked:()=>blocked});
  const restarted=new PlatformMaintenance(adapter,path);await restarted.initialize();await restarted.restore(task);
  assert.equal((await host.status(f.admin)).serving,true);assert.equal(blocked,false);await host.close();
 }finally{await f.close();}
});

test('hosted API survives starting administrator logout and still rejects disabled generations',async()=>{
 const f=await hostFixture();
 try{
  const initial=await f.registry.register(f.admin,manifest());
  const running=await f.registry.beginLifecycle(f.admin,initial.appId,initial.revision,'install');
  const enabled={...running,enabled:true,revision:running.revision+1,manifest:{...manifest(),
   backend:{mode:'isolated' as const,runtime:'node' as const,entryArtifactId:'main',limits:{memoryMiB:128,cpuMillis:500,timeoutSeconds:30}},
   artifacts:[{id:'main',kind:'backend' as const,path:'main.js',bytes:1,sha256:'a'.repeat(64)}],
   permissions:{requested:[],defined:[{code:'app.tool-lending.read',description:'Read'}]},
   api:[{id:'read',method:'POST' as const,path:'/read',handler:'read',permission:'app.tool-lending.read'}]}};
  let loggedOut=false,disabled=false,calls=0;
  f.registry.get=async()=>{if(loggedOut)throw Error('ADMIN_SESSION_EXPIRED');return running;};
  f.registry.settleLifecycle=async()=>enabled;
  f.registry.runtimeSnapshot=async()=>({...enabled,enabled:!disabled});
  const host=new AppLifecycleHost({...f.options,api:{contextResolver:{resolve:async()=>f.application},authorize:async()=>true}});
  // Inject the already attached transport to exercise activation without an actual Docker daemon.
  const internals=host as unknown as {lease:unknown;bridge:unknown;start(context:typeof f.admin,record:typeof running):Promise<unknown>;api:ReturnType<typeof import('../src/app-platform/runtime/hosted-api.ts').createHostedAppApi>};
  internals.lease={assertHeld:async()=>{}};
  internals.bridge={api:{invoke:async()=>{calls++;return {ok:true};},drain:async()=>{}}};
  await internals.start(f.admin,running);
  loggedOut=true;
  const request={apiId:'read',method:'POST',path:'/read',payload:{}};
  assert.equal((await internals.api.invoke(f.application,request) as {ok:boolean}).ok,true);
  disabled=true;
  await assert.rejects(internals.api.invoke(f.application,request),/STALE_API/);
  assert.equal(calls,1);
 }finally{await f.close();}
});
