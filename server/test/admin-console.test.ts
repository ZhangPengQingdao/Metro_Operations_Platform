import test from 'node:test';
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
  for(const path of ['/apps/sample/install-recover','/apps/sample/recover','/apps/sample/version-recover','/apps/sample/upgrade','/install']){
   assert.equal((await app.inject({method:'POST',url:'/api/admin'+path,headers:{cookie:cookies,origin:'https://evil.example'},payload:{}})).statusCode,403);
   assert.equal((await app.inject({method:'POST',url:'/api/admin'+path,headers:{origin:'https://platform.example'},payload:{}})).statusCode,401);
  }
  for(const path of ['/apps/sample/install-status','/apps/sample/runtime-status','/apps/sample/version-status','/apps/sample/ui']){
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
  const search=await app.inject({url:'/api/admin/data/organizations?q=missing',headers});assert.deepEqual(search.json().records,[]);
  assert.equal((await app.inject({url:'/api/admin/data/organizations?status=wrong',headers})).statusCode,400);
  assert.equal((await app.inject({method:'PATCH',url:`/api/admin/data/organizations/${id}`,headers,payload:{name:'新名称'}})).statusCode,200);
  const service=createAdminDataService(client,{audit:async()=>{throw Error('audit failed');}});
  await assert.rejects(service.create(account,'positions',{name:'回滚岗位'}));
  assert.equal((await db.query('SELECT id FROM platform_positions')).rows.length,0);
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
