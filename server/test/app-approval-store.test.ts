import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AppApprovalStore,appApprovalMigration} from '../src/app-platform/management/approvals.ts';
import {ADMIN_IDENTITY_MIGRATION,AdminIdentityService} from '../src/core/admin-identity/index.ts';
import type {PlatformManagementContext} from '../src/platform/context/index.ts';

test('publisher trust and exact version approval retain history, use CAS, deny invalid keys and never reimport revoked configuration',async()=>{
 const db=new PGlite();const client={query:(sql:string,args?:readonly unknown[])=>db.query(sql,[...(args??[])]),release(){}};const pool={connect:async()=>client};
 try{
  await db.exec(ADMIN_IDENTITY_MIGRATION);await appApprovalMigration.run({client} as never);
  const account=await new AdminIdentityService(pool).bootstrap({username:'policy.admin',displayName:'Policy',password:'Policy-test-password'});
  let allowed=true;const context={actorType:'administrator',administrator:account,execution:{type:'platform'},authorize:async()=>({allowed})} as unknown as PlatformManagementContext;
  const keys=generateKeyPairSync('ed25519'),key={publisherId:'publisher',keyId:'publisher-key',publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),appIds:['inventory'],revoked:false,validFrom:'2020-01-01T00:00:00Z',validUntil:'2099-01-01T00:00:00Z'};
  const store=new AppApprovalStore(pool),digest='a'.repeat(64);
  await store.initialize(async()=>({policyVersion:'1.0',revision:99,keys:[key]}),[digest]);
  const first=await store.get(context);assert.equal(first.revision,1);assert.equal(first.policy.revision,1);
  await store.save(context,1,{approval:{digest,approved:false}});
  await store.initialize(async()=>{throw Error('must not reload seed');},[digest]);assert.deepEqual((await store.current()).approvedManifestDigests,[]);
  await assert.rejects(store.save(context,1,{approval:{digest,approved:true}}),/APPROVAL_STALE_REVISION/);
  await store.save(context,2,{keys:[{...key,revoked:true}]});assert.equal((await store.current()).policy.keys[0].revoked,true);
  allowed=false;await assert.rejects(store.get(context),/INSTALL_ACCESS_DENIED/);await assert.rejects(store.save(context,3,{keys:[key]}),/INSTALL_ACCESS_DENIED/);allowed=true;
  await assert.rejects(store.save(context,3,{keys:[{...key,publicKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString()}]}),/INVALID_PUBLISHER_POLICY/);
  await assert.rejects(store.save(context,3,{keys:[key,key]}),/INVALID_PUBLISHER_POLICY/);
  await assert.rejects(store.save(context,3,{keys:[]}),/PUBLISHER_KEY_IMMUTABLE/);
  const replacement=generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'}).toString();
  await assert.rejects(store.save(context,3,{keys:[{...key,publicKeyPem:replacement}]}),/PUBLISHER_KEY_IMMUTABLE/);
  assert.equal((await store.current()).revision,3);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform_app_approval_history')).rows[0].n,3);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM platform_admin_audit WHERE action LIKE 'app.%'")).rows[0].n,2);
  // A failed audit cannot leave a committed policy change.
  await db.exec("CREATE FUNCTION public.fail_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit unavailable'; END$$; CREATE TRIGGER fail_policy_audit BEFORE INSERT ON platform_admin_audit FOR EACH ROW EXECUTE FUNCTION public.fail_policy_audit()");
  await assert.rejects(store.save(context,3,{approval:{digest,approved:true}}));assert.equal((await store.current()).revision,3);
 }finally{await db.close();}
});
