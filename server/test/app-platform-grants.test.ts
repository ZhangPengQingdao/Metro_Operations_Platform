import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {AppRegistryService,PostgresAppRegistryRepository,APP_REGISTRY_SQL} from '../src/app-platform/registry/index.ts';
import {approveInstalledPlatformGrants,requestedPlatformCapabilities} from '../src/app-platform/management/platform-grants.ts';
import type {AppManifest} from '../src/app-platform/manifest/index.ts';
import type {PlatformManagementContext} from '../src/platform/context/index.ts';

test('platform grant batch is atomic, excludes business permissions, and requires disabled application',async()=>{
 const db=new PGlite();try{
 await db.exec(APP_REGISTRY_SQL);
 const client={query:(sql:string,args?:readonly unknown[])=>db.query(sql,[...(args??[])])};
 let allowed=true,writeActive=false;
 const context={actorType:'administrator',administrator:{id:'10000000-0000-4000-8000-000000000001'},execution:{type:'platform'},authorize:async()=>({allowed})} as unknown as PlatformManagementContext;
 const registry=new AppRegistryService(new PostgresAppRegistryRepository(client),{host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>[{code:'platform.app_data.read',status:'active'},{code:'platform.app_data.write',status:writeActive?'active':'inactive'}] as never}});
 const manifest=JSON.parse(await readFile(new URL('../../examples/app-sdk/dist/sandbox/manifest.json',import.meta.url),'utf8')) as AppManifest;
 manifest.permissions.requested=['platform.app_data.read','platform.app_data.write'];
 manifest.routes=manifest.routes.map(r=>({...r,permission:'platform.app_data.read'}));
 await registry.register(context,manifest);
 await assert.rejects(approveInstalledPlatformGrants(registry,context,manifest.id),/PERMISSION_NOT_ACTIVE/);
 assert.equal((await registry.get(context,manifest.id)).grants.length,0);
 writeActive=true;let result=await approveInstalledPlatformGrants(registry,context,manifest.id);
 assert.deepEqual(result.grants.map(g=>g.permissionCode),manifest.permissions.requested.filter(p=>p.startsWith('platform.')));
 assert.ok(result.grants.every(g=>g.mode==='delegated_user'));
 allowed=false;await assert.rejects(approveInstalledPlatformGrants(registry,context,manifest.id));allowed=true;
 result=await registry.setEnabled(context,manifest.id,result.revision,true);
 await assert.rejects(approveInstalledPlatformGrants(registry,context,manifest.id),/DISABLE_REQUIRED/);
 const serviceManifest={...manifest,id:'service-grants-check',backend:{mode:'external' as const,origin:'https://service.example.com'}};
 await registry.register(context,serviceManifest);
 await assert.rejects(approveInstalledPlatformGrants(registry,context,serviceManifest.id),/SERVICE_IDENTITY_MISMATCH/);
 let serviceRecord=await registry.get(context,serviceManifest.id);
 const issued=await registry.issueServiceCredential(context,serviceManifest.id,serviceRecord.revision);
 serviceRecord=await approveInstalledPlatformGrants(registry,context,serviceManifest.id);
 assert.ok(serviceRecord.grants.every(g=>g.mode==='service'&&g.serviceIdentityId===issued.installation.serviceIdentityId));
 assert.throws(()=>requestedPlatformCapabilities({...manifest,permissions:{...manifest.permissions,requested:['platform.authorization.manage']}}),/APP_CAPABILITIES_NOT_SUPPORTED/);
 }finally{await db.close();}
});
