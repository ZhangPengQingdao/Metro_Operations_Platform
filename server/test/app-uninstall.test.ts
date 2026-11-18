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
import {AppRegistryService,MemoryAppRegistryRepository} from '../src/app-platform/registry/index.ts';
import {AppHostV2} from '../src/app-platform/v2/host.ts';
import {AppPackageStoreV2} from '../src/app-platform/v2/store.ts';
import {previewAppPackageV2,summarizeInstallation} from '../src/app-platform/v2/preview.ts';
import {projectV2Manifest} from '../src/app-platform/v2/projection.ts';
import type {PlatformAdministratorContext} from '../src/platform/context/index.ts';

test('confirmed administrator uninstall stops the child, revokes access and retains records; interrupted uninstall resumes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mop-uninstall-')),db=new PGlite();
 const client={query:(sql:string,args?:readonly unknown[])=>db.query(sql,[...(args??[])]),release(){}};
 const pool={connect:async()=>client};
 await db.exec(ADMIN_IDENTITY_MIGRATION);await db.exec(ADMIN_PASSWORD_SESSION_SQL);
 const identity=new AdminIdentityService(pool);
 const account=await identity.bootstrap({username:'uninstall.admin',displayName:'Admin',password:'Administrator-test-123'});
 const context:PlatformAdministratorContext={actorType:'administrator',administrator:account,execution:{type:'platform'},request:{requestId:'test',traceId:'test',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'decision',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'administrator',effectiveScopes:[],decidedAt:new Date().toISOString()})};
 const registry=new AppRegistryService(new MemoryAppRegistryRepository(),{host:()=>({platformVersion:'1.12.3',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>[]}});
 const bytes=createMopkg(Object.entries({
  'app.json':JSON.stringify({id:'uninstall-demo',name:'卸载测试',description:'测试应用',version:'1.0.0',platform:'>=1.0.0',permissions:[{code:'read',name:'读取'}],api:[{id:'read',permission:'read'}]}),
  'icon.svg':'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
  'server.js':"export default {kind:'mop-server',version:1,hooks:{},handlers:{read:async()=>({ok:true})}};",
 }).map(([path,value])=>({path,data:new TextEncoder().encode(value)})));
 const preview=await previewAppPackageV2(bytes,{platformVersion:'1.12.3',findInstalled:async()=>null});
 assert.deepEqual(preview.issues,[]);assert.ok(preview.manifest);
 const files=readMopkg(bytes),store=new AppPackageStoreV2(directory);
 await store.write('uninstall-demo',preview.sha256,files);
 const manifest=projectV2Manifest(preview.manifest,preview,path=>createHash('sha256').update(files.get(path)!).digest('hex'));
 let record=await registry.register(context,manifest,undefined,'standard',{model:'v2',sha256:preview.sha256,manifest:preview.manifest});
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
 }finally{await host.close();await app.close();await db.close();await rm(directory,{recursive:true,force:true});}
});
