import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {randomUUID,randomBytes,createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createManagedStorageComposition,createStorageArtifactReader} from '../src/app-platform/management/storage.ts';
import {AppRegistryService,PostgresAppRegistryRepository} from '../src/app-platform/registry/index.ts';
import {PostgresInstallJournal} from '../src/app-platform/install/journal.ts';
import {AppInstaller} from '../src/app-platform/install/service.ts';
import {AppVersionService,PostgresAppVersionJournal,createVersionedArtifactReader} from '../src/app-platform/install/version-service.ts';
import {createAppRuntimeComposition} from '../src/app-platform/runtime/composition.ts';
import {signAppDirectory} from '../src/app-platform/developer/signature.ts';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {AppRuntimeDataService} from '../src/app-platform/storage/runtime-data.ts';
import {parseStorageDatabaseUrl} from '../src/app-platform/management/storage.ts';
import {binding} from '../src/app-platform/storage/binding.ts';
import type {AppManifest} from '../src/app-platform/manifest/index.ts';
import type {PlatformActorContext,PlatformAdministratorContext} from '../src/platform/context/index.ts';
import type {AppGateway} from '../src/app-platform/gateway/gateway.ts';

// Explicit disposable PostgreSQL only. The runtime is a controlled test adapter, not a Docker claim.
const input=process.env.MOP_STORAGE_TEST_ADMIN_URL;
test('PostgreSQL: distinct API/storage identities, signed lifecycle and durable migration recovery',{skip:!input},async()=>{
 const bootstrap=new URL(input!);
 assert.ok(['127.0.0.1','[::1]'].includes(bootstrap.hostname));
 assert.equal(bootstrap.pathname,'/mop_storage_test');
 const suffix=randomBytes(6).toString('hex'),database=`mop_storage_test_${suffix}`,apiRole=`mop_api_${suffix}`,password=randomBytes(24).toString('hex');
 const root=await mkdtemp(join(tmpdir(),'mop-storage-pg-'));
 const supervisor=new Client({connectionString:input});await supervisor.connect();
 let api:Client|undefined,admin:Client|undefined,runtime:ReturnType<typeof createAppRuntimeComposition>|undefined;
 const roleNames:string[]=[];
 try{
  await supervisor.query(`CREATE ROLE "${apiRole}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE NOCREATEDB`);
  await supervisor.query(`CREATE DATABASE "${database}" OWNER "${apiRole}"`);
  const apiUrl=new URL(input!);apiUrl.pathname='/'+database;apiUrl.username=apiRole;apiUrl.password=password;
  const adminUrl=new URL(input!);adminUrl.pathname='/'+database;
  api=new Client({connectionString:apiUrl.href});admin=new Client({connectionString:adminUrl.href});await api.connect();await admin.connect();
  const db={query:(sql:string,args?:readonly unknown[])=>api!.query(sql,args?[...args]:undefined)};
  await initializePlatformDatabase(db);
  const registryOptions={authorization:{listPermissions:async()=>[]},host:()=>({platformVersion:'0.1.0',capabilities:[],applications:[]})};
  const repository=new PostgresAppRegistryRepository(db),registry=new AppRegistryService(repository,registryOptions);
  const journal=new PostgresInstallJournal(db),versionsJournal=new PostgresAppVersionJournal(db),readArtifact=createVersionedArtifactReader(journal,versionsJournal);
  const options={apiDatabaseUrl:apiUrl.href,adminDatabaseUrl:adminUrl.href,apiClient:db,
   registry:(client:typeof db)=>new AppRegistryService(new PostgresAppRegistryRepository(client),registryOptions),
   reader:createStorageArtifactReader({getInstallation:id=>repository.findByAppId(id),readArtifact})};
  await assert.rejects(createManagedStorageComposition(options),/UNSAFE_PUBLIC_DATABASE_PRIVILEGES/);
  // Fixture-owned database only; production composition never changes these ACLs.
  await admin.query(`REVOKE CREATE,TEMPORARY ON DATABASE "${database}" FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  const storage=await createManagedStorageComposition(options);
  const actor:PlatformAdministratorContext={actorType:'administrator',administrator:{id:'44000000-0000-4000-8000-000000000001',username:'test',displayName:'Test'},execution:{type:'platform'},
   request:{requestId:'test',traceId:'test',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'test',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'administrator',effectiveScopes:[],decidedAt:new Date().toISOString()})};
  runtime=createAppRuntimeComposition({registry,gateway:{drain:async()=>{}} as unknown as AppGateway,storage,artifactRoot:join(root,'runtime'),readArtifact,
   connectLease:async()=>{const client=new Client({connectionString:apiUrl.href});await client.connect();return client;},
   external:{check:async()=>{},stop:async()=>{}}});
  const keys=generateKeyPairSync('ed25519'),privateFile=join(root,'private.pem');await writeFile(privateFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const policy={policyVersion:'1.0' as const,revision:1,keys:[{keyId:'test-key',publisherId:'test',publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),revoked:false,appIds:['storage-test','storage-fault','storage-other'],validFrom:'2020-01-01T00:00:00Z',validUntil:'2099-01-01T00:00:00Z'}]};
  const installer=new AppInstaller({registry,journal,artifactRoot:join(root,'packages'),loadPublisherPolicy:async()=>policy,approve:async()=>true,getHost:r=>runtime!.getHost(r.appId)});
  const versions=new AppVersionService({registry,journal:versionsJournal,installJournal:journal,artifactRoot:join(root,'packages'),loadPublisherPolicy:async()=>policy,approve:async()=>true,getHost:id=>runtime!.getHost(id)});
  const migration=JSON.stringify({migrationVersion:'1.0',operations:[{kind:'createTable',table:'records',columns:[{name:'id',type:'integer',nullable:false},{name:'value',type:'text',nullable:false}],primaryKey:['id']},{kind:'createTable',table:'entries',columns:[{name:'id',type:'uuid',nullable:false},{name:'value',type:'jsonb',nullable:false}],primaryKey:['id']}]});
  async function bundle(id:string,version:string){
   const directory=join(root,id+'-'+version);await mkdir(directory);
   const manifest:AppManifest={manifestVersion:'1.0',id,version,name:id,description:'test',publisherId:'test',
    compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},
    ui:{mode:'none'},backend:{mode:'external',origin:'https://example.com'},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'migration'}]},
    routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},
    artifacts:[{id:'migration',kind:'migration',path:'initial.json',sha256:createHash('sha256').update(migration).digest('hex'),bytes:Buffer.byteLength(migration)}]};
   await writeFile(join(directory,'initial.json'),migration);await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
   const signatureFile=join(root,id+'-'+version+'.signature.json');await signAppDirectory(directory,'test-key',privateFile,signatureFile);
   return {directory,signatureFile};
  }
  const first={...await bundle('storage-test','1.0.0'),requestId:'storage-install-0001'};
  assert.equal((await installer.install(actor,first)).state,'installed');
  let record=await registry.get(actor,'storage-test');const plan=binding(record);assert.equal(plan.mode,'managed');if(plan.mode!=='managed')throw Error('binding');
  assert.equal(record.enabled,true);assert.equal(record.grants.length,0);
  assert.equal((await installer.install(actor,first)).state,'installed');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.platform_app_migration_attempts WHERE installation_id=$1',[plan.installationId])).rows[0].n,1);
  await assert.rejects(api.query(`SELECT * FROM "${plan.schema}".records`),/permission denied/);
  // Test fixture inserts a canary; this is not an application runtime write API.
  await admin.query(`INSERT INTO "${plan.schema}".records VALUES(1,'preserved')`);
  await installer.install(actor,{...await bundle('storage-other','1.0.0'),requestId:'storage-other-0001'});
  const otherPlan=binding(await registry.get(actor,'storage-other'));if(otherPlan.mode!=='managed')throw Error('binding');
  let allowed=true,denyAfterStatement=false;
  const appActor={actorType:'service',execution:{type:'service',appId:record.appId,serviceIdentityId:'test-service'},
   authorize:async(permissionCode:string)=>({allowed,permissionCode})} as PlatformActorContext;
  const connectAdmin=async()=>{const c=new Client({connectionString:adminUrl.href});await c.connect();return c;};
  const credentials=parseStorageDatabaseUrl(adminUrl.href);const {host:dbHost,port,database:dbName,ssl}=credentials;
  const runtimeData=new AppRuntimeDataService({connectAdmin,endpoint:{host:dbHost,port,database:dbName,ssl},findInstallation:(c,id)=>new PostgresAppRegistryRepository(c).findByAppId(id),
   connectRuntime:async creds=>{const c=new Client({...creds,options:'-c search_path=pg_catalog'});await c.connect();
    assert.equal((await c.query('SELECT session_user')).rows[0].session_user,plan.runtimeRole);
    await assert.rejects(c.query('SELECT * FROM public.platform_employee_accounts'),/permission denied/);
    await assert.rejects(c.query(`SELECT * FROM "${otherPlan.schema}".entries`),/permission denied/);
    await assert.rejects(c.query(`CREATE TABLE "${plan.schema}".forbidden(id int)`),/permission denied/);
    await assert.rejects(c.query(`SET ROLE "${plan.ownerRole}"`),/permission denied/);
    return {query:async(sql,args)=>{const r=await c.query(sql,args?[...args]:undefined);if(denyAfterStatement&&sql.startsWith('WITH r AS ('))allowed=false;return r;},end:()=>c.end()};
   }});
  const id=randomUUID(),requestId=randomUUID(),signal=new AbortController().signal;
  const call=(input:unknown,write=false)=>runtimeData.execute(appActor,input,write,signal);
  const insert={table:'entries',id,requestId,action:'insert',values:{value:{note:'own data'}}};
  assert.equal((await storage.runtimeData.execute(appActor,insert,true,signal)).row.value.note,'own data');
  assert.equal((await call({table:'entries',id})).row.value.note,'own data');
  await assert.rejects(call(insert,true),/STORAGE_REQUEST_ALREADY_RECORDED/);
  await assert.rejects(call({table:'public.platform_people',id}));
  await assert.rejects(call({table:'entries',id,schema:'public'}));
  await assert.rejects(runtimeData.execute({...appActor,actorType:'person'} as PlatformActorContext,{table:'entries',id},false,signal),/ACCESS_DENIED/);
  allowed=false;await assert.rejects(call({table:'entries',id}),/ACCESS_DENIED/);allowed=true;
  denyAfterStatement=true;
  await assert.rejects(call({table:'entries',id,requestId:randomUUID(),action:'update',values:{value:{note:'denied'}}},true),/ACCESS_DENIED/);
  denyAfterStatement=false;allowed=true;
  assert.equal((await call({table:'entries',id})).row.value.note,'own data');
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.platform_app_runtime_storage_writes WHERE status='rolled_back'")).rows[0].n,1);
  await call({table:'entries',id,requestId:randomUUID(),action:'update',values:{value:{note:'changed'}}},true);
  assert.equal((await call({table:'entries',id})).row.value.note,'changed');
  await call({table:'entries',id,requestId:randomUUID(),action:'delete'},true);
  assert.equal((await call({table:'entries',id})).row,null);
  assert.equal((await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[plan.runtimeRole])).rows[0].rolcanlogin,false);
  const host=await runtime.getHost(record.appId);
  record=await host.execute(actor,{revision:record.revision,action:'disable'});
  assert.equal((await host.status(actor)).serving,false);
  await assert.rejects(call({table:'entries',id}),/ACCESS_DENIED/);
  const staleLease=randomUUID();
  await admin.query("INSERT INTO public.platform_app_runtime_storage_leases(id,installation_id,runtime_role,status,expires_at) VALUES($1,$2,$3,'active',now()+interval '30 seconds')",[staleLease,plan.installationId,plan.runtimeRole]);
  await admin.query(`ALTER ROLE "${plan.runtimeRole}" LOGIN`);
  await storage.recover(actor,record.appId,record.revision);
  assert.equal((await admin.query('SELECT status FROM public.platform_app_runtime_storage_leases WHERE id=$1',[staleLease])).rows[0].status,'released');
  assert.equal((await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1',[plan.runtimeRole])).rows[0].rolcanlogin,false);
  const update=await versions.update(actor,{...await bundle('storage-test','1.0.1'),appId:record.appId,revision:record.revision,requestId:'storage-upgrade-0001'});
  assert.equal(update.state,'updated');record=await registry.get(actor,record.appId);assert.equal(record.enabled,false);
  record=await host.execute(actor,{revision:record.revision,action:'enable'});assert.equal(record.enabled,true);
  assert.equal((await admin.query(`SELECT value FROM "${plan.schema}".records`)).rows[0].value,'preserved');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.platform_app_migration_attempts WHERE installation_id=$1',[plan.installationId])).rows[0].n,1);
  // Lost completion acknowledgement follows a committed write; no cleanup may fabricate its outcome.
  await admin.query(`CREATE FUNCTION public.test_runtime_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test completion unavailable'; END$$;
   REVOKE ALL ON FUNCTION public.test_runtime_finish() FROM PUBLIC;
   CREATE TRIGGER test_runtime_finish BEFORE UPDATE ON public.platform_app_runtime_storage_writes FOR EACH ROW EXECUTE FUNCTION public.test_runtime_finish()`);
  const uncertain={table:'entries',id,requestId:randomUUID(),action:'insert',values:{value:{note:'committed'}}};
  await assert.rejects(call(uncertain,true));
  assert.equal((await admin.query(`SELECT value FROM "${plan.schema}".entries WHERE id=$1`,[id])).rows[0].value.note,'committed');
  await admin.query('DROP TRIGGER test_runtime_finish ON public.platform_app_runtime_storage_writes; DROP FUNCTION public.test_runtime_finish()');
  await assert.rejects(call(uncertain,true),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  await assert.rejects(call({table:'entries',id}),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  await assert.rejects(storage.assertReady(actor,record.appId,record.revision),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  assert.equal((await admin.query("SELECT status FROM public.platform_app_runtime_storage_writes WHERE request_id=$1",[uncertain.requestId])).rows[0].status,'dispatched');
  record=await host.execute(actor,{revision:record.revision,action:'disable'});
  await host.execute(actor,{revision:record.revision,action:'uninstall'});
  assert.equal((await admin.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',[plan.runtimeRole,`${plan.schema}.records`])).rows[0].allowed,false);

  // Fail ledger acknowledgement after the owner transaction commits. Preserve the original receipt.
  await admin.query(`CREATE FUNCTION public.test_fail_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test ledger unavailable'; END$$;
   REVOKE ALL ON FUNCTION public.test_fail_finish() FROM PUBLIC;
   CREATE TRIGGER test_fail_finish BEFORE UPDATE ON public.platform_app_migration_attempts FOR EACH ROW EXECUTE FUNCTION public.test_fail_finish()`);
  const fault={...await bundle('storage-fault','1.0.0'),requestId:'storage-install-fault'};
  await assert.rejects(installer.install(actor,fault),/RECOVERY_REQUIRED/);
  assert.equal((await installer.install(actor,fault)).state,'recovery_required');
  const pending=(await admin.query("SELECT id,status FROM public.platform_app_migration_attempts WHERE status='running'")).rows;
  assert.equal(pending.length,1);
  const failure=await installer.status(actor,'storage-fault');await installer.recover(actor,'storage-fault',failure.revision);
  const failedRecord=await registry.get(actor,'storage-fault');assert.equal(failedRecord.enabled,false);
  await assert.rejects(storage.assertReady(actor,'storage-fault',failedRecord.revision),/MIGRATION_ATTEMPT_BLOCKED/);
  await admin.query('DROP TRIGGER test_fail_finish ON public.platform_app_migration_attempts; DROP FUNCTION public.test_fail_finish()');
  const reconciled=await storage.reconcile(actor,'storage-fault',failedRecord.revision,pending[0].id);assert.equal(reconciled.status,'applied');
  await storage.assertReady(actor,'storage-fault',failedRecord.revision);
  assert.equal((await admin.query('SELECT evidence FROM public.platform_app_migration_reconciliations WHERE attempt_id=$1',[pending[0].id])).rows[0].evidence,'committed');
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM public.platform_app_storage_leases WHERE status='active'")).rows[0].n,0);
 }finally{
  await runtime?.close();
  if(admin){
   const present=(await admin.query("SELECT to_regclass('public.platform_app_installations') AS table_name")).rows[0];
   if(present.table_name)for(const row of (await admin.query('SELECT id FROM public.platform_app_installations')).rows){const stem='app_'+row.id.replaceAll('-','');roleNames.push(stem+'_owner',stem+'_runtime');}
  }
  await api?.end();await admin?.end();
  await supervisor.query(`DROP DATABASE IF EXISTS "${database}"`);
  for(const role of roleNames)await supervisor.query(`DROP ROLE IF EXISTS "${role}"`);
  await supervisor.query(`DROP ROLE IF EXISTS "${apiRole}"`);await supervisor.end();await rm(root,{recursive:true,force:true});
 }
});
