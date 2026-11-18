import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {PGlite} from '@electric-sql/pglite';
import {createMopkg,readMopkg} from '@metro/platform-sdk/mopkg';
import {ADMIN_PASSWORD_SESSION_SQL} from '../src/setup/password-policy-migration.ts';
import {ADMIN_IDENTITY_MIGRATION,AdminIdentityService,registerAdminIdentityRoutes} from '../src/core/admin-identity/index.ts';
import {registerAdminConsoleRoutes} from '../src/app-platform/admin/routes.ts';
import {AppRegistryService,PostgresAppRegistryRepository,APP_REGISTRY_SQL} from '../src/app-platform/registry/index.ts';
import {AppInstallerV2} from '../src/app-platform/v2/installer.ts';
import {APP_V2_SQL,applyAppMigrationsV2,appSchemaName} from '../src/app-platform/v2/migration.ts';
import {AppHostV2} from '../src/app-platform/v2/host.ts';
import {AppPackageStoreV2} from '../src/app-platform/v2/store.ts';
import {previewAppPackageV2,summarizeInstallation} from '../src/app-platform/v2/preview.ts';
import {projectV2Manifest} from '../src/app-platform/v2/projection.ts';
import type {PlatformAdministratorContext} from '../src/platform/context/index.ts';

test('confirmed administrator uninstall stops the child, revokes access and retains records; interrupted uninstall resumes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mop-uninstall-')),db=new PGlite();
 const client={query:(sql:string,args?:readonly unknown[])=>db.query(sql,[...(args??[])]),release(){}};
 const pool={connect:async()=>client};
 await db.exec(ADMIN_IDENTITY_MIGRATION);await db.exec(ADMIN_PASSWORD_SESSION_SQL);await db.exec(APP_REGISTRY_SQL);await db.exec(APP_V2_SQL);
 const identity=new AdminIdentityService(pool);
 const account=await identity.bootstrap({username:'uninstall.admin',displayName:'Admin',password:'Administrator-test-123'});
 const context:PlatformAdministratorContext={actorType:'administrator',administrator:account,execution:{type:'platform'},request:{requestId:'test',traceId:'test',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'decision',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'administrator',effectiveScopes:[],decidedAt:new Date().toISOString()})};
 const registry=new AppRegistryService(new PostgresAppRegistryRepository(client),{host:()=>({platformVersion:'1.12.3',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>['platform.app_data.read','platform.app_data.write'].map(code=>({
  id:code,code,name:code,description:null,status:'active' as const,createdAt:'',updatedAt:'',
 }))}});
 const initialMigration=JSON.stringify({migrationVersion:'1.0',operations:[{kind:'createTable',table:'records',
  columns:[{name:'id',type:'uuid',nullable:false},{name:'title',type:'text',nullable:false}],primaryKey:['id']}]});
 const bytes=createMopkg(Object.entries({
  'app.json':JSON.stringify({id:'uninstall-demo',name:'卸载测试',description:'测试应用',version:'1.0.0',platform:'>=1.0.0',permissions:[{code:'read',name:'读取'}],api:[{id:'read',permission:'read'}]}),
  'icon.svg':'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
  'migrations/001-initial.json':initialMigration,
  'server.js':"export default {kind:'mop-server',version:1,hooks:{},handlers:{read:async()=>({ok:true})}};",
 }).map(([path,value])=>({path,data:new TextEncoder().encode(value)})));
 const preview=await previewAppPackageV2(bytes,{platformVersion:'1.12.3',findInstalled:async()=>null});
 assert.deepEqual(preview.issues,[]);assert.ok(preview.manifest);
 const files=readMopkg(bytes),store=new AppPackageStoreV2(directory);
 await store.write('uninstall-demo',preview.sha256,files);
 const manifest=projectV2Manifest(preview.manifest,preview,path=>createHash('sha256').update(files.get(path)!).digest('hex'));
 let record=await registry.register(context,manifest,undefined,'standard',{model:'v2',sha256:preview.sha256,manifest:preview.manifest});
 await applyAppMigrationsV2(client,record.id,[{id:'001-initial',text:initialMigration}]);
 const rowId='11111111-1111-4111-8111-111111111111';
 await db.query('INSERT INTO "'+appSchemaName(record.id)+'".records(id,title) VALUES($1,$2)',[rowId,'卸载前的数据']);
 const issued=await registry.issueServiceCredential(context,record.appId,record.revision);record=issued.installation;
 let failDrain=false,drains=0;
 const host=new AppHostV2({appId:record.appId,registry,store,gateway:{invokeHosted:async()=>{throw Error('unused');},drain:async()=>{drains++;if(failDrain){failDrain=false;throw Error('drain failed');}}},api:{contextResolver:{resolve:async()=>{throw Error('unused');}},authorize:async()=>false,businessAuthorization:async()=>{throw Error('unused');}},log:()=>{}});
 const app=Fastify();await app.register(cookie);registerAdminIdentityRoutes(app,{origin:'https://platform.example',service:identity});
 await registerAdminConsoleRoutes(app,{origin:'https://platform.example',identity,pool,lifecycle:{getHost:async()=>host}});
 try{
  record=await host.install(context,record.revision);
  assert.equal((await host.status(context)).process?.state,'running');
  const url=`/api/admin/apps/${record.appId}/lifecycle`,payload={revision:record.revision,action:'uninstall',confirmed:true};
  assert.equal((await app.inject({method:'POST',url,payload,headers:{origin:'https://platform.example'}})).statusCode,401);
  const login=await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin:'https://platform.example'},payload:{username:'uninstall.admin',password:'Administrator-test-123'}});
  const headers={cookie:String(login.headers['set-cookie']).split(';')[0],origin:'https://platform.example'};
  assert.equal((await app.inject({method:'POST',url,headers:{...headers,origin:'https://evil.example'},payload})).statusCode,403);
  for(const confirmed of [undefined,false])assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,confirmed}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,revision:1}})).statusCode,409);
  await assert.rejects(host.execute({...context,authorize:async(code)=>({...await context.authorize(code),allowed:false})},{revision:record.revision,action:'uninstall'}),/REGISTRY_ACCESS_DENIED/);
  assert.equal((await host.status(context)).serving,true);
  failDrain=true;
  assert.equal((await app.inject({method:'POST',url,headers,payload})).statusCode,503);
  record=await registry.get(context,record.appId);
  assert.equal(record.lifecycle?.status,'failed');assert.equal(record.enabled,false);
  const operationId=record.lifecycle!.operationId;
  const beforeRetryDrains=drains;
  await assert.rejects(host.execute({...context,authorize:async(code)=>({...await context.authorize(code),allowed:code.endsWith('.read')})},{revision:record.revision,action:'uninstall'}),/REGISTRY_ACCESS_DENIED/);
  assert.equal(drains,beforeRetryDrains);
  const result=await app.inject({method:'POST',url,headers,payload:{...payload,revision:record.revision}});
  assert.equal(result.statusCode,200,result.body);record=result.json();
  assert.equal(record.lifecycle?.action,'uninstall');assert.equal(record.lifecycle?.status,'completed');assert.equal(record.lifecycle?.operationId,operationId);
  assert.equal(record.enabled,false);assert.deepEqual(record.grants,[]);assert.equal(record.serviceIdentityId,null);
  assert.equal((await host.status(context)).serving,false);assert.equal((await host.status(context)).process,null);assert.ok(drains>=3);
  await assert.rejects(host.admittedSnapshot(),/ACCESS_DENIED/);
  await assert.rejects(registry.authenticateServiceCredential(record.appId,issued.credential),/INVALID_CREDENTIAL/);
  await assert.rejects(host.execute(context,{revision:record.revision,action:'enable'}),/LIFECYCLE_BLOCKED/);
  assert.equal((await registry.get(context,record.appId)).id,record.id);
  assert.ok((await registry.listHistory(context,record.appId)).some(h=>h.lifecycle?.action==='uninstall'&&h.lifecycle.status==='completed'));
  assert.ok(await readFile(join(store.directory(record.appId,preview.sha256),'server.js')));
  assert.equal(summarizeInstallation(record).uninstalled,true);
  const installationId=record.id,historyBefore=(await registry.listHistory(context,record.appId)).length;
  const installer=new AppInstallerV2({registry,pool,store,host:()=>host,platformVersion:()=> '1.12.3',
   findInstallation:appId=>registry.runtimeSnapshot(appId)});
  const packageWith=(version:string,migration=initialMigration,extra?:string)=>createMopkg([...files].map(([path,data])=>({
   path,data:path==='app.json'?Buffer.from(JSON.stringify({...JSON.parse(data.toString()),version})):path==='migrations/001-initial.json'?Buffer.from(migration):data,
  })).concat(extra?[{path:'migrations/002-note.json',data:Buffer.from(extra)}]:[]));
  await assert.rejects(installer.install(context,packageWith('0.9.0')),/PACKAGE_INVALID/);
  await assert.rejects(installer.install(context,packageWith('1.0.0',initialMigration+' ')),/MIGRATION_HISTORY_CHANGED/);
  assert.equal(summarizeInstallation(await registry.get(context,record.appId)).uninstalled,true);
  const reinstalled=await installer.install(context,bytes);
  assert.equal(reinstalled.state,'installed');assert.equal(reinstalled.enabled,true);
  record=await registry.get(context,record.appId);
  assert.equal(record.id,installationId);assert.equal(record.manifest.version,'1.0.0');
  assert.notEqual(record.serviceIdentityId,issued.installation.serviceIdentityId);
  assert.ok(record.grants.some(grant=>grant.permissionCode==='platform.app_data.read'&&grant.status==='active'));
  await assert.rejects(registry.authenticateServiceCredential(record.appId,issued.credential),/INVALID_CREDENTIAL/);
  assert.equal((await host.status(context)).serving,true);
  assert.ok((await registry.listHistory(context,record.appId)).length>historyBefore);
  assert.equal((await db.query('SELECT title FROM "'+appSchemaName(record.id)+'".records WHERE id=$1',[rowId])).rows[0].title,'卸载前的数据');

  record=await host.execute(context,{revision:record.revision,action:'uninstall'});
  const additional=JSON.stringify({migrationVersion:'1.0',operations:[{kind:'addColumn',table:'records',column:{name:'note',type:'text',nullable:true}}]});
  assert.equal((await installer.install(context,packageWith('1.1.0',initialMigration,additional))).enabled,true);
  record=await registry.get(context,record.appId);
  assert.equal(record.id,installationId);assert.equal(record.manifest.version,'1.1.0');
  const restored=await db.query('SELECT title,note FROM "'+appSchemaName(record.id)+'".records WHERE id=$1',[rowId]);
  assert.deepEqual(restored.rows,[{title:'卸载前的数据',note:null}]);

 }finally{await host.close();await app.close();await db.close();await rm(directory,{recursive:true,force:true});}
});
