import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {PGlite} from '@electric-sql/pglite';
import {ADMIN_IDENTITY_MIGRATION,AdminIdentityService,registerAdminIdentityRoutes,appendAdminAudit} from '../src/core/admin-identity/index.ts';
import {registerAdminConsoleRoutes} from '../src/app-platform/admin/routes.ts';
import {APP_REGISTRY_SQL,AppRegistryService,MemoryAppRegistryRepository,PostgresAppRegistryRepository} from '../src/app-platform/registry/index.ts';
import {PLATFORM_PEOPLE_DIRECTORY_SQL} from '../src/platform/people/index.ts';
import {createAdminDataService} from '../src/app-platform/admin-data/index.ts';
import type {PlatformAdministratorContext,PlatformActorContext} from '../src/platform/context/index.ts';
import {demoManifest} from '../../src/app-platform/samples/host-demo/manifest.ts';
test('real console authenticates independent accounts, rejects CSRF and writes master data with atomic audit',async()=>{
 const db=new PGlite();await db.exec(ADMIN_IDENTITY_MIGRATION);await db.exec(APP_REGISTRY_SQL);await db.exec(PLATFORM_PEOPLE_DIRECTORY_SQL);
 const client={query:(sql:string,values?:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,[...(values??[])]),release(){}};
 const pool={connect:async()=>client};const identity=new AdminIdentityService(pool);const account=await identity.bootstrap({username:'console.admin',displayName:'Admin',password:'Administrator-test-123'});
 const app=Fastify();await app.register(cookie);registerAdminIdentityRoutes(app,{origin:'https://platform.example',service:identity});await registerAdminConsoleRoutes(app,{origin:'https://platform.example',identity,pool});
 try{
  assert.equal((await app.inject({url:'/api/admin/apps'})).statusCode,401);
  const login=await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:'https://platform.example'},payload:{username:'console.admin',password:'Administrator-test-123'}});assert.equal(login.statusCode,200);
  const cookies=String(login.headers['set-cookie']).split(';')[0];const headers={cookie:cookies,origin:'https://platform.example'};
  for(const path of ['/apps/sample/install-recover','/apps/sample/recover','/apps/sample/version-recover','/apps/sample/upgrade','/install-preview','/install-approve','/version-approval/revoke','/install']){
   assert.equal((await app.inject({method:'POST',url:'/api/admin'+path,headers:{cookie:cookies,origin:'https://evil.example'},payload:{}})).statusCode,403);
   assert.equal((await app.inject({method:'POST',url:'/api/admin'+path,headers:{origin:'https://platform.example'},payload:{}})).statusCode,401);
  }
  for(const path of ['/apps/sample/install-status','/apps/sample/runtime-status','/apps/sample/version-status','/apps/sample/ui','/publisher-policy']){
   assert.equal((await app.inject({url:'/api/admin'+path})).statusCode,401);
   assert.equal((await app.inject({url:'/api/admin'+path,headers})).statusCode,503);
  }
  const list=await app.inject({url:'/api/admin/apps',headers});assert.equal(list.statusCode,200);assert.deepEqual(list.json().applications,[]);assert.equal(list.json().runtimeConfigured,false);
  const repository=new PostgresAppRegistryRepository(client);
  const context:PlatformAdministratorContext={actorType:'administrator',administrator:account,execution:{type:'platform'},request:{requestId:'test',traceId:'test',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'decision',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'administrator',effectiveScopes:[],decidedAt:new Date().toISOString()})};
  const registry=new AppRegistryService(repository,{host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>[]}});
  const installation=await registry.register(context,demoManifest);
  const stored=await repository.findByAppId(installation.appId);assert.ok(stored);
  stored.grants=[{grantId:'10000000-0000-4000-8000-000000000009',appId:installation.appId,permissionCode:'app.host-demo.details',mode:'delegated_user',scope:{kind:'all',targets:[]},status:'active',effectiveFrom:new Date().toISOString(),effectiveTo:null,serviceIdentityId:null}];
  stored.revision++;await repository.save(stored,installation.revision);
  const appPath=`/api/admin/apps/${installation.appId}`;
  const detail=await app.inject({url:appPath,headers});assert.equal(detail.statusCode,200);assert.equal(detail.json().grants.length,1);assert.ok(!('credentialDigest' in detail.json()));
  const revokePath=`${appPath}/grants/${stored.grants[0].grantId}`;
  assert.equal((await app.inject({method:'DELETE',url:revokePath,headers:{cookie:cookies,origin:'https://evil.example'},payload:{revision:stored.revision}})).statusCode,403);
  assert.equal((await app.inject({method:'DELETE',url:revokePath,headers,payload:{revision:installation.revision}})).statusCode,409);
  const revoked=await app.inject({method:'DELETE',url:revokePath,headers,payload:{revision:stored.revision}});assert.equal(revoked.statusCode,200);assert.equal(revoked.json().grants[0].status,'inactive');
  const history=await app.inject({url:`${appPath}/history`,headers});assert.ok(history.json().some((entry:{action:string;actorAdministratorId:string})=>entry.action==='grant-revoked'&&entry.actorAdministratorId===account.id));
  assert.equal((await app.inject({url:'/api/admin/apps/not-installed',headers})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:'/api/admin/ai/save',headers:{cookie:cookies,origin:'https://evil.example'},payload:{endpoint:'https://example.com/v1',model:'test',apiKey:'test'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/admin/ai/save',headers,payload:{endpoint:'not-a-url',model:'test',apiKey:'test'}})).statusCode,400);
  const input={name:'公司',unitType:'company'};
  assert.equal((await app.inject({method:'POST',url:'/api/admin/data/organizations',headers:{cookie:cookies,origin:'https://evil.example'},payload:input})).statusCode,403);
  const create=await app.inject({method:'POST',url:'/api/admin/data/organizations',headers,payload:input});assert.equal(create.statusCode,200);const id=create.json().id;
  assert.match(create.json().code,/^org-[a-f0-9]{32}$/);
  const another=await app.inject({method:'POST',url:'/api/admin/data/organizations',headers,payload:input});assert.equal(another.statusCode,200);assert.notEqual(another.json().code,create.json().code);
  assert.equal((await app.inject({method:'POST',url:'/api/admin/data/organizations',headers,payload:{...input,code:'manual'}})).statusCode,400);
  const resources=await app.inject({url:'/api/admin/data/resources',headers});assert.ok(resources.json().resources.filter((r:{key:string})=>r.key!=='people').every((r:{fields:{key:string}[]})=>r.fields.every(f=>!['code','assetCode'].includes(f.key))));
  const personResource=resources.json().resources.find((r:{key:string})=>r.key==='people');
  assert.deepEqual(personResource.columns,['name','organizationUnitId','positionId']);
  assert.deepEqual(personResource.updateFields,['organizationUnitId','positionId']);
  assert.equal(personResource.fields.find((f:{key:string})=>f.key==='name').label,'姓名');
  const search=await app.inject({url:'/api/admin/data/organizations?q=missing',headers});assert.deepEqual(search.json().records,[]);
  assert.equal((await app.inject({url:'/api/admin/data/organizations?status=wrong',headers})).statusCode,400);
  assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/organizations/${id}`,headers,payload:{name:'新名称'}})).statusCode,200);
  const service=createAdminDataService(client,{audit:async()=>{throw Error('audit failed');}});
  await assert.rejects(service.create(account,'positions',{name:'回滚岗位'}));
  assert.equal((await db.query('SELECT id FROM platform_positions')).rows.length,0);
  assert.ok(resources.json().resources.every((r:{columns:string[]})=>r.columns.every(k=>!['code','assetCode','dictionaryKey'].includes(k))));
  const position=(await app.inject({method:'POST',url:'/api/admin/data/positions',headers,payload:{name:'检修工'}})).json();
  const person=(await app.inject({method:'POST',url:'/api/admin/data/people',headers,payload:{employeeNo:'TEST-001',name:'测试员工',organizationUnitId:id,positionId:position.id}})).json();
  assert.equal((await app.inject({url:'/api/admin/data/people?status=active',headers})).statusCode,200);
  for(const payload of [{name:'不能更名'},{phone:'123'},{employmentStatus:'departed'}])assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/people/${person.id}`,headers,payload})).statusCode,400);
  assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/positions/${position.id}`,headers,payload:{description:'维护说明',status:'inactive'}})).json().status,'inactive');
  assert.equal((await app.inject({url:'/api/admin/data/positions',headers})).json().records[0].description,'维护说明');
  assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/positions/${position.id}`,headers,payload:{status:'active'}})).json().status,'active');
  const newPosition=(await app.inject({method:'POST',url:'/api/admin/data/positions',headers,payload:{name:'工班长'}})).json();
  assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/people/${person.id}`,headers,payload:{organizationUnitId:another.json().id,positionId:newPosition.id}})).statusCode,200);
  const listed=(await app.inject({url:'/api/admin/data/people',headers})).json().records[0];assert.equal(listed.organizationUnitName,'公司');assert.equal(listed.positionName,'工班长');assert.equal(listed.employeeNo,'TEST-001');
  assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/people/${person.id}`,headers,payload:{organizationUnitId:'00000000-0000-4000-8000-000000000099'}})).statusCode,400);
  await db.query("UPDATE platform_positions SET status='inactive' WHERE id=$1",[position.id]);
  assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/people/${person.id}`,headers,payload:{positionId:position.id}})).statusCode,400);
  const audit=await app.inject({url:'/api/admin/audit',headers});assert.equal(audit.statusCode,200);assert.ok(audit.json().entries.some((row:{action:string;actorId:string})=>row.action==='data.organizations.update'&&row.actorId===account.id));
  await app.inject({method:'POST',url:'/api/admin/auth/logout',headers});assert.equal((await app.inject({url:'/api/admin/apps',headers})).statusCode,401);
 }finally{await app.close();await db.close();}
});
test('management identity never masquerades as person and does not admit service/application actors',async()=>{
 const repository=new MemoryAppRegistryRepository();const registry=new AppRegistryService(repository,{host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>[]}});
 const context:PlatformAdministratorContext={actorType:'administrator',administrator:{id:'10000000-0000-4000-8000-000000000001',username:'admin',displayName:'Admin'},execution:{type:'platform'},request:{requestId:'r',traceId:'t',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'d',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'administrator',effectiveScopes:[],decidedAt:new Date().toISOString()})};
 const installation=await registry.register(context,demoManifest);const history=await registry.listHistory(context,installation.appId);assert.equal(history[0].actorPersonId,null);assert.equal(history[0].actorAdministratorId,context.administrator.id);
 assert.ok(!('credentialDigest' in (await registry.list(context))[0]));
 const service:PlatformActorContext={actorType:'service',trustedIdentity:{source:'service'},execution:{type:'service',appId:'host-demo',serviceIdentityId:'s'},request:context.request,authorize:async permissionCode=>({id:'d',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'service',effectiveScopes:[],decidedAt:new Date().toISOString()})};
 await assert.rejects(registry.list(service),/REGISTRY_ACCESS_DENIED/);
 await assert.rejects(registry.list({...context,authorize:async p=>({...await context.authorize(p),allowed:false})}),/REGISTRY_ACCESS_DENIED/);
});

test('migration management validates admin session, origin, pagination and evidence-only reconciliation',async()=>{
 const {AppStorageError}=await import('../src/app-platform/storage/binding.ts');
 const db=new PGlite();await db.exec(ADMIN_IDENTITY_MIGRATION);
 const pool={connect:async()=>({query:(sql:string,args?:readonly unknown[])=>db.query(sql,[...(args??[])]),release(){}})};
 const identity=new AdminIdentityService(pool);await identity.bootstrap({username:'migration.admin',displayName:'Admin',password:'Migration-test-password'});
 const login=await identity.login({username:'migration.admin',password:'Migration-test-password'});
 const app=Fastify();await app.register(cookie);let reads=0,writes=0;
 const management={writeHistory:async()=>({writes:[],revision:4,enabled:false,nextCursor:null}),reconcileWrite:async()=>{writes++;throw new AppStorageError('STORAGE_WRITE_RECONCILIATION_REQUIRED');},migrationHistory:async(context:PlatformAdministratorContext,appId:string,after:number)=>{assert.equal(context.actorType,'administrator');assert.equal(appId,'sample');reads++;return {revision:4,enabled:false,attempts:[],nextSequence:null,after};},reconcileMigration:async()=>{writes++;throw new AppStorageError('MIGRATION_RECONCILIATION_BLOCKED');}};
 await registerAdminConsoleRoutes(app,{origin:'https://platform.example',identity,pool,management:management as unknown as import('../src/app-platform/management/service.ts').AppManagement});
 try{
  const {ADMIN_SESSION_COOKIE}=await import('../src/core/admin-identity/index.ts');
  const path='/api/admin/apps/sample/storage/migrations',headers={cookie:`${ADMIN_SESSION_COOKIE}=${login.token}`,origin:'https://platform.example'};
  assert.equal((await app.inject({url:path})).statusCode,401);
  assert.equal((await app.inject({url:path+'?afterSequence=12',headers})).json().after,12);
  assert.equal((await app.inject({url:path+'?afterSequence=-1',headers})).statusCode,400);assert.equal(reads,1);
  const payload={revision:4,attemptId:'55000000-0000-4000-8000-000000000001'};
  assert.equal((await app.inject({method:'POST',url:path+'/reconcile',headers:{...headers,origin:'https://other.example'},payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:path+'/reconcile',headers,payload:{...payload,outcome:'applied'}})).statusCode,400);assert.equal(writes,0);
  const result=await app.inject({method:'POST',url:path+'/reconcile',headers,payload});assert.equal(result.statusCode,409);assert.equal(result.json().error,'MIGRATION_RECONCILIATION_BLOCKED');assert.equal(writes,1);
  const writePath='/api/admin/apps/sample/storage/writes';
  assert.equal((await app.inject({url:writePath})).statusCode,401);
  assert.equal((await app.inject({url:writePath+'?after=bad',headers})).statusCode,400);
  assert.equal((await app.inject({url:writePath,headers})).statusCode,200);
  const writePayload={revision:4,requestId:payload.attemptId};
  assert.equal((await app.inject({method:'POST',url:writePath+'/reconcile',headers:{...headers,origin:'https://other.example'},payload:writePayload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:writePath+'/reconcile',headers,payload:{...writePayload,status:'completed'}})).statusCode,400);
  const blocked=await app.inject({method:'POST',url:writePath+'/reconcile',headers,payload:writePayload});assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error,'STORAGE_WRITE_RECONCILIATION_REQUIRED');
 }finally{await app.close();await db.close();}
});

test('directory status updates persist for every enabled directory and retain descriptions',async()=>{
 const db=new PGlite();
 const client={query:async(sql:string,args?:readonly unknown[])=>args?db.query(sql,[...args]):(await db.exec(sql)).at(-1)!};
 try{
  const {initializePlatformDatabase}=await import('../src/setup/schema.ts');await initializePlatformDatabase(client);
  const service=createAdminDataService(client,{audit:async()=>{}});
  const actor={id:'10000000-0000-4000-8000-000000000001',username:'test',displayName:'Test'};
  const org=await service.create(actor,'organizations',{name:'测试组织',unitType:'company'});
  const sys=await service.create(actor,'asset-systems',{name:'测试系统'});
  const cat=await service.create(actor,'asset-categories',{name:'测试分类',systemId:sys.id});
  const entries=[
   ['organizations',org],['asset-systems',sys],['asset-categories',cat],
   ['positions',await service.create(actor,'positions',{name:'测试岗位'})],
   ['lines',await service.create(actor,'lines',{name:'测试线路'})],
   ['locations',await service.create(actor,'locations',{name:'测试位置',locationType:'station'})],
   ['asset-types',await service.create(actor,'asset-types',{name:'测试类型',systemId:sys.id,categoryId:cat.id})]
  ] as const;
  for(const [key,record]of entries){
   const details=['positions','asset-systems','asset-categories','asset-types'].includes(key)?{description:'可维护说明'}:{shortName:'简称'};
   await service.update(actor,key,record.id,{...details,status:'inactive'});
   const row=(await service.list(actor,key)).find((r:{id:string})=>r.id===record.id) as unknown as Record<string,unknown>;
   assert.equal(row.status,'inactive',key);for(const [field,value] of Object.entries(details))assert.equal(row[field],value,key);
   await service.update(actor,key,record.id,{status:'active'});
   assert.equal(((await service.list(actor,key))[0] as unknown as Record<string,unknown>).status,'active',key);
  }
 }finally{await db.close();}
});

test('aborted admin uploads release capacity for subsequent packages', {timeout:15000}, async()=>{
 const db=new PGlite();await db.exec(ADMIN_IDENTITY_MIGRATION);
 const client={query:(sql:string,values?:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,[...(values??[])]),release(){}};
 const pool={connect:async()=>client};const identity=new AdminIdentityService(pool);
 await identity.bootstrap({username:'upload.admin',displayName:'Admin',password:'Administrator-test-123'});
 const app=Fastify();await app.register(cookie);
 let received:()=>void=()=>{};let aborted:()=>void=()=>{};
 app.addHook('preParsing',async(_req,_reply,payload)=>{received();return payload;});
 app.addHook('onRequestAbort',async(_req)=>{aborted();});
 registerAdminIdentityRoutes(app,{origin:'https://platform.example',service:identity});
 await registerAdminConsoleRoutes(app,{origin:'https://platform.example',identity,pool});
 try{
  const address=await app.listen({host:'127.0.0.1',port:0});
  const login=await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:'https://platform.example'},payload:{username:'upload.admin',password:'Administrator-test-123'}});
  const headers={cookie:String(login.headers['set-cookie']).split(';')[0],origin:'https://platform.example'};
  for(let attempt=0;attempt<4;attempt++){
   const admitted=new Promise<void>(resolve=>{received=resolve;});
   const disconnected=new Promise<void>(resolve=>{aborted=resolve;});
   const request=http.request(address+'/api/admin/install-preview',{method:'POST',headers:{...headers,'content-type':'application/json','content-length':'100000'}});
   request.on('error',()=>{});request.write('{');
   await admitted;request.destroy();await disconnected;
   const next=await app.inject({method:'POST',url:'/api/admin/install-preview',headers,payload:{}});
   assert.notEqual(next.statusCode,429,'aborted uploads must not exhaust the two upload slots');
   assert.equal(next.json().error,'APP_INSTALL_NOT_CONFIGURED');
  }
 }finally{await app.close();await db.close();}
});
