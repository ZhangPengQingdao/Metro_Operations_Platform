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
  const registry=new AppRegistryService(repository,{authorization,clock:()=>time,host:()=>({platformVersion:'0.0.1-alpha.35',capabilities:[],applications:[]})});
  const resolver=createPlatformActorContextResolver({people,authorization,resolveAppGrant:registry.createGrantResolver(),clock:()=>time});
  const request={requestId:'request',traceId:'trace'};
  const identity={actorType:'person' as const,trustedIdentity:{source:'session' as const,userId:personId},...request};
  const admin=await resolver.resolve({...identity,execution:{type:'platform'}});
  const application=await resolver.resolve({...identity,execution:{type:'application',appId:'tool-lending'}});
  return {registry,admin,application,resolver,authorization,permission,roleId,request,setTime:(value:string)=>{time=new Date(value);}};
}
async function store(kind:'memory'|'postgres') {
  if (kind==='memory') return {repository:new MemoryAppRegistryRepository(),close:async()=>{}};
  const db=new PGlite();
  const client: QueryableClient={query:async(sql,values)=>values ? db.query(sql,[...values]) : db.exec(sql)};
  await APP_REGISTRY_MIGRATIONS[0].run({client});
  await APP_REGISTRY_MIGRATIONS[0].run({client});
  return {repository:new PostgresAppRegistryRepository(client),close:()=>db.close()};
}
for(const kind of ['memory','postgres'] as const) {
  test(`${kind}: default disabled, immutable detached manifest, native administration and actual L3 intersection`,async()=>{
    const s=await store(kind); try {
      const f=await setup(s.repository), m=manifest();
      let r=await f.registry.register(f.admin,m);
      m.name='mutated';assert.equal(r.manifest.name,'借还');assert.equal(r.enabled,false);assert.deepEqual(r.grants,[]);
      assert.equal((await f.application.authorize(permissionCode,{organizationUnitId:org})).allowed,false);
      await assert.rejects(f.registry.register(f.application,manifest()),/REGISTRY_ACCESS_DENIED/);
      await assert.rejects(f.registry.get(f.application,'tool-lending'),/REGISTRY_ACCESS_DENIED/);
      await assert.rejects(f.registry.register(f.admin,manifest()),/APP_ALREADY_REGISTERED/);
      await assert.rejects(f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode:'platform.authorization.manage',scope:{kind:'all',targets:[]}}),/UNDECLARED_PERMISSION/);
      await assert.rejects(f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode,scope:{kind:'explicit',targets:Array.from({length:129},()=>({type:'organization' as const,id:org}))}}),/INVALID_DATA_SCOPE/);
      r=await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'delegated_user',permissionCode,scope:{kind:'explicit',targets:[{type:'organization',id:org}]}});
      r=await f.registry.setEnabled(f.admin,r.appId,r.revision,true);
      assert.equal((await f.application.authorize(permissionCode,{organizationUnitId:org})).allowed,true);
      assert.equal((await f.application.authorize(permissionCode,{organizationUnitId:otherOrg})).allowed,false);
      await f.authorization.revokeRolePermission(f.roleId,f.permission.id);
      assert.equal((await f.application.authorize(permissionCode,{organizationUnitId:org})).allowed,false);
      // Intrinsic ceiling remains independent of role, but not application revoke.
      assert.equal((await f.application.authorizeApplication!(permissionCode,{organizationUnitId:org})).allowed,true);
      r=await f.registry.revokeGrant(f.admin,r.appId,r.revision,r.grants[0].grantId);
      assert.equal((await f.application.authorizeApplication!(permissionCode,{organizationUnitId:org})).allowed,false);
      assert.equal(await f.registry.createGrantResolver()({appId:'other-app',mode:'delegated_user',permissionCode,personId}),null);
      const history=await f.registry.listHistory(f.admin,r.appId,0,2);assert.equal(history.length,2);assert.equal(history[1].grant?.scope.kind,'explicit');
      assert.equal((await f.registry.listHistory(f.admin,r.appId,2)).length,2);
      assert.equal('credentialDigest' in await f.registry.get(f.admin,r.appId),false);
    } finally {await s.close();}
  });
  test(`${kind}: service credentials rotation/revoke invalidate old contexts; expiry and scope fail closed`,async()=>{
    const s=await store(kind);try {
      const f=await setup(s.repository);let r=await f.registry.register(f.admin,manifest());
      const issued=await f.registry.issueServiceCredential(f.admin,r.appId,r.revision);r=issued.installation;
      assert.ok(!JSON.stringify(await s.repository.findByAppId(r.appId)).includes(issued.credential.split('.')[2]));
      assert.ok(!JSON.stringify(await f.registry.listHistory(f.admin,r.appId)).includes('credentialDigest'));
      await assert.rejects(f.registry.authenticateServiceCredential(r.appId,issued.credential),/INVALID_CREDENTIAL/);
      r=await f.registry.setEnabled(f.admin,r.appId,r.revision,true);
      const authenticated=await f.registry.authenticateServiceCredential(r.appId,issued.credential);
      const ctx=await f.resolver.resolve({...authenticated,...f.request});
      assert.equal((await ctx.authorize(permissionCode)).allowed,false);
      for(const scope of [{kind:'self' as const,targets:[]},{kind:'explicit' as const,targets:[]}]) await assert.rejects(f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'service',permissionCode,scope,serviceIdentityId:r.serviceIdentityId!}));
      await assert.rejects(f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'service',permissionCode,scope:{kind:'all',targets:[]},serviceIdentityId:'wrong'}),/SERVICE_IDENTITY_MISMATCH/);
      r=await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'service',permissionCode,scope:{kind:'all',targets:[]},serviceIdentityId:r.serviceIdentityId!,effectiveTo:'2026-09-09T00:00:00.000Z'});
      assert.equal((await ctx.authorize(permissionCode)).allowed,true);
      f.setTime('2026-09-09T00:00:00.000Z');assert.equal((await ctx.authorize(permissionCode)).allowed,false);f.setTime(now);
      r=await f.registry.setEnabled(f.admin,r.appId,r.revision,false);assert.equal((await ctx.authorize(permissionCode)).allowed,false);
      r=await f.registry.setEnabled(f.admin,r.appId,r.revision,true);assert.equal((await ctx.authorize(permissionCode)).allowed,true);
      const rotated=await f.registry.issueServiceCredential(f.admin,r.appId,r.revision);r=rotated.installation;
      assert.notEqual(r.serviceIdentityId,issued.installation.serviceIdentityId);assert.equal(r.grants.length,0);
      assert.equal((await ctx.authorize(permissionCode)).allowed,false);
      await assert.rejects(f.registry.authenticateServiceCredential(r.appId,issued.credential),/INVALID_CREDENTIAL/);
      await assert.rejects(f.registry.authenticateServiceCredential('other-app',rotated.credential),/INVALID_CREDENTIAL/);
      await assert.rejects(f.registry.approveGrant(ctx,r.appId,r.revision,{mode:'service',permissionCode,scope:{kind:'all',targets:[]},serviceIdentityId:r.serviceIdentityId!}),/REGISTRY_ACCESS_DENIED/);
      await f.registry.authenticateServiceCredential(r.appId,rotated.credential);
      r=await f.registry.revokeServiceCredential(f.admin,r.appId,r.revision);
      await assert.rejects(f.registry.authenticateServiceCredential(r.appId,rotated.credential),/INVALID_CREDENTIAL/);
    }finally{await s.close();}
  });
  test(`${kind}: stopped credential renewal preserves grants and revocations, rejects running and unresolved operations`,async()=>{
    const s=await store(kind);try{
      const f=await setup(s.repository);let r=await f.registry.register(f.admin,manifest());
      const original=await f.registry.issueServiceCredential(f.admin,r.appId,r.revision);r=original.installation;
      r=await f.registry.approveGrant(f.admin,r.appId,r.revision,{mode:'service',permissionCode,scope:{kind:'all',targets:[]},serviceIdentityId:r.serviceIdentityId!});
      const grants=structuredClone(r.grants);
      await assert.rejects(f.registry.renewServiceCredential(f.application,r.appId,r.revision),/REGISTRY_ACCESS_DENIED/);
      const renewed=await f.registry.renewServiceCredential(f.admin,r.appId,r.revision);r=renewed.installation;
      assert.equal(r.serviceIdentityId,original.installation.serviceIdentityId);assert.deepEqual(r.grants,grants);
      r=await f.registry.setEnabled(f.admin,r.appId,r.revision,true);
      await assert.rejects(f.registry.authenticateServiceCredential(r.appId,original.credential),/INVALID_CREDENTIAL/);
      await f.registry.authenticateServiceCredential(r.appId,renewed.credential);
      await assert.rejects(f.registry.renewServiceCredential(f.admin,r.appId,r.revision),/DISABLE_REQUIRED/);
      r=await f.registry.setEnabled(f.admin,r.appId,r.revision,false);
      r=await f.registry.revokeGrant(f.admin,r.appId,r.revision,r.grants[0].grantId);
      const revoked=structuredClone(r.grants);
      r=(await f.registry.renewServiceCredential(f.admin,r.appId,r.revision)).installation;
      assert.deepEqual(r.grants,revoked);
      r=await f.registry.beginLifecycle(f.admin,r.appId,r.revision,'enable');
      await assert.rejects(f.registry.renewServiceCredential(f.admin,r.appId,r.revision),/LIFECYCLE_BLOCKED/);
    }finally{await s.close();}
  });
  test(`${kind}: history failure rolls back register/state; competing revisions have one winner`,async()=>{
    const s=await store(kind);try{
      const f=await setup(s.repository),append=s.repository.appendHistory.bind(s.repository);
      s.repository.appendHistory=async()=>{throw new Error('history unavailable');};
      await assert.rejects(f.registry.register(f.admin,manifest()),/history unavailable/);assert.equal(await s.repository.findByAppId('tool-lending'),null);
      s.repository.appendHistory=append;
      const r=await f.registry.register(f.admin,manifest());
      s.repository.appendHistory=async()=>{throw new Error('history unavailable');};
      await assert.rejects(f.registry.setEnabled(f.admin,r.appId,r.revision,true),/history unavailable/);
      assert.deepEqual(await f.registry.get(f.admin,r.appId),r);assert.equal((await f.registry.listHistory(f.admin,r.appId)).length,1);
      s.repository.appendHistory=append;
      const results=await Promise.allSettled([f.registry.setEnabled(f.admin,r.appId,1,true),f.registry.setEnabled(f.admin,r.appId,1,false)]);
      assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);assert.equal((await f.registry.listHistory(f.admin,r.appId)).length,2);
      const raw=(await s.repository.findByAppId(r.appId))!;
      await assert.rejects(runAtomicOperation([s.repository],()=>s.repository.save({...raw,revision:raw.revision+2},raw.revision)));
      await assert.rejects(runAtomicOperation([s.repository],()=>s.repository.save({...raw,revision:raw.revision+1,manifest:{...raw.manifest,name:'different'}},raw.revision)));
    }finally{await s.close();}
  });
}
test('PostgreSQL constraints reject malformed aggregate and registry migration is explicit L4 only',async()=>{
  const db=new PGlite();try{
    const client:QueryableClient={query:async(sql)=>db.exec(sql)};await APP_REGISTRY_MIGRATIONS[0].run({client});
    await assert.rejects(db.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)',[personId,'broken','{}']));
    assert.equal(APP_REGISTRY_MIGRATIONS[0].layer,'L4');assert.deepEqual(APP_REGISTRY_MIGRATIONS[0].dataRows,[]);
  }finally{await db.close();}
});
