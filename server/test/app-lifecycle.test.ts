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
async function store(kind:'memory'|'postgres') {
  if (kind==='memory') return {repository:new MemoryAppRegistryRepository(),close:async()=>{}};
  const db=new PGlite();
  const client: QueryableClient={query:async(sql,values)=>values ? db.query(sql,[...values]) : db.exec(sql)};
  await APP_REGISTRY_MIGRATIONS[0].run({client});
  await APP_REGISTRY_MIGRATIONS[0].run({client});
  return {repository:new PostgresAppRegistryRepository(client),close:()=>db.close()};
}
for (const kind of ['memory','postgres'] as const) {
  test(`${kind}: lifecycle blocks access/replay and recovers same operation with audited attestation`, async () => {
    const s = await store(kind); try {
      const f = await setup(s.repository);
      let r = await f.registry.register(f.admin, manifest());
      const issued = await f.registry.issueServiceCredential(f.admin, r.appId, r.revision); r = issued.installation;
      r = await f.registry.setEnabled(f.admin,r.appId,r.revision,true);
      await assert.rejects(f.registry.beginLifecycle(f.application,r.appId,r.revision,'disable'),/REGISTRY_ACCESS_DENIED/);
      const revision = r.revision;
      const results = await Promise.allSettled([f.registry.beginLifecycle(f.admin,r.appId,revision,'disable'),f.registry.beginLifecycle(f.admin,r.appId,revision,'disable')]);
      assert.equal(results.filter(x => x.status === 'fulfilled').length,1);
      r = await f.registry.get(f.admin,r.appId);
      assert.equal(r.enabled,false); assert.equal(r.lifecycle?.status,'running');
      await assert.rejects(f.registry.authenticateServiceCredential(r.appId,issued.credential),/INVALID_CREDENTIAL/);
      await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,'enable'),/LIFECYCLE_BLOCKED/);
      await assert.rejects(f.registry.setEnabled(f.admin,r.appId,r.revision,true),/LIFECYCLE_BLOCKED/);
      await assert.rejects(f.registry.issueServiceCredential(f.admin,r.appId,r.revision),/LIFECYCLE_BLOCKED/);
      await assert.rejects(f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode,scope:{kind:'all',targets:[]}}),/LIFECYCLE_BLOCKED/);
      await assert.rejects(f.registry.settleLifecycle(f.admin,r.appId,r.revision,'wrong','completed'),/LIFECYCLE_BLOCKED/);
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'failed');
      const operationId = r.lifecycle!.operationId;
      r = await f.registry.revokeServiceCredential(f.admin,r.appId,r.revision);
      r = await f.registry.setEnabled(f.admin,r.appId,r.revision,false);
      await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,'disable'),/LIFECYCLE_BLOCKED/);
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,operationId,'completed');
      await assert.rejects(f.registry.settleLifecycle(f.admin,r.appId,r.revision,operationId,'completed'),/LIFECYCLE_BLOCKED/);
      await assert.rejects(f.registry.setEnabled(f.admin,r.appId,r.revision,true),/LIFECYCLE_BLOCKED/);
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'enable');
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed');
      assert.equal(r.enabled,true);
      r = await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode,scope:{kind:'all',targets:[]}});
      r = await f.registry.revokeGrant(f.admin,r.appId,r.revision,r.grants[0].grantId);
      r = (await f.registry.issueServiceCredential(f.admin,r.appId,r.revision)).installation;
      r = await f.registry.revokeServiceCredential(f.admin,r.appId,r.revision);
      const history = await f.registry.listHistory(f.admin,r.appId);
      assert.ok(history.some(h => h.action === 'lifecycle-failed' && h.lifecycle?.operationId === operationId));
    } finally { await s.close(); }
  });
  test(`${kind}: upgrade preserves identity and storage, resets authority; uninstall retains tombstone`, async () => {
    const s = await store(kind); try {
      const f = await setup(s.repository); let r = await f.registry.register(f.admin,manifest());
      const original = structuredClone(r);
      r = (await f.registry.issueServiceCredential(f.admin,r.appId,r.revision)).installation;
      r = await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode,scope:{kind:'all',targets:[]}});
      const target = {...manifest(),version:'2.0.0'};
      await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,'upgrade',{...target,publisherId:'changed'}),/IMMUTABLE_INSTALLATION/);
      await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,'upgrade',{...target,backend:{mode:'external',origin:'https://example.com'},storage:{mode:'managed',migrations:[]}}),/IMMUTABLE_INSTALLATION/);
      await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,'upgrade',manifest()),/UNCHANGED_VERSION/);
      await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,'enable',target),/UNEXPECTED_TARGET_MANIFEST/);
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'upgrade',target); target.name = 'mutated';
      assert.equal(r.manifest.version,'1.0.0'); assert.notEqual(r.lifecycle!.targetManifest!.name,target.name);
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed');
      assert.equal(r.manifest.version,'2.0.0'); assert.equal(r.id,original.id); assert.equal(r.createdAt,original.createdAt);
      assert.deepEqual(r.manifest.storage,original.manifest.storage); assert.equal(r.enabled,false); assert.deepEqual(r.grants,[]); assert.equal(r.serviceIdentityId,null);
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'rollback',manifest());
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed');
      assert.equal(r.manifest.version,'1.0.0');
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'uninstall');
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed');
      assert.equal((await f.registry.get(f.admin,r.appId)).id,original.id);
      for (const action of ['install','enable','upgrade','rollback','disable'] as const) await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,action),/LIFECYCLE_BLOCKED/);
      await assert.rejects(f.registry.issueServiceCredential(f.admin,r.appId,r.revision),/LIFECYCLE_BLOCKED/);
      const history = await f.registry.listHistory(f.admin,r.appId);
      assert.ok(history.some(h => h.lifecycle?.targetManifest?.version === '2.0.0' && h.lifecycle.baseManifest.version === '1.0.0'));
    } finally { await s.close(); }
  });
  test(`${kind}: interrupted enable can be cancelled without activation; fresh compatibility and shutdown fail closed`, async () => {
    const s = await store(kind); try {
      const f = await setup(s.repository); let r = await f.registry.register(f.admin,manifest());
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'enable');
      f.setHost('2.0.0');
      await assert.rejects(f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed'),/INCOMPATIBLE_MANIFEST/);
      assert.equal((await f.registry.get(f.admin,r.appId)).lifecycle?.status,'running');
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'failed');
      // A fresh service instance still sees the durable failed operation; no timeout unlock.
      const restarted = new AppRegistryService(s.repository,{authorization:f.authorization,host:()=>({platformVersion:'0.0.1-alpha.35',capabilities:[],applications:[]})});
      await assert.rejects(restarted.beginLifecycle(f.admin,r.appId,r.revision,'disable'),/LIFECYCLE_BLOCKED/);
      const failedId = r.lifecycle!.operationId;
      r = await restarted.settleLifecycle(f.admin,r.appId,r.revision,failedId,'cancelled');
      assert.equal(r.enabled,false); assert.equal(r.manifest.version,'1.0.0');
      await assert.rejects(restarted.settleLifecycle(f.admin,r.appId,r.revision,failedId,'completed'),/LIFECYCLE_BLOCKED/);
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'disable');
      f.setHost('2.0.0',true);
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed');
      assert.equal(r.enabled,false);
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'uninstall');
      r = await f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed');
      assert.equal(r.enabled,false);
    } finally { await s.close(); }
  });
  test(`${kind}: lifecycle audit failure is atomic and repository rejects lifecycle bypasses`,async () => {
    const s = await store(kind); try {
      const f = await setup(s.repository); let r = await f.registry.register(f.admin,manifest());
      const append = s.repository.appendHistory.bind(s.repository);
      s.repository.appendHistory = async () => { throw new Error('audit unavailable'); };
      await assert.rejects(f.registry.beginLifecycle(f.admin,r.appId,r.revision,'install'),/audit unavailable/);
      assert.deepEqual(await f.registry.get(f.admin,r.appId),r);
      s.repository.appendHistory = append;
      r = await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'install');
      const raw = (await s.repository.findByAppId(r.appId))!;
      await assert.rejects(s.repository.save({...raw,revision:raw.revision+1,lifecycle:undefined},raw.revision));
      await assert.rejects(s.repository.save({...raw,revision:raw.revision+1,enabled:true},raw.revision));
      await assert.rejects(s.repository.saveLifecycle({...raw,revision:raw.revision+1,manifest:{...raw.manifest,version:'9.0.0'}},raw.revision));
      await assert.rejects(s.repository.saveLifecycle({...raw,revision:raw.revision+1,lifecycle:{...raw.lifecycle!,status:'completed',settledAt:raw.updatedAt},enabled:true,grants:[{grantId:'injected'} as never]},raw.revision));
      s.repository.appendHistory = async () => { throw new Error('audit unavailable'); };
      await assert.rejects(f.registry.settleLifecycle(f.admin,r.appId,r.revision,r.lifecycle!.operationId,'completed'),/audit unavailable/);
      assert.deepEqual(await f.registry.get(f.admin,r.appId),r);
    } finally { await s.close(); }
  });
}
