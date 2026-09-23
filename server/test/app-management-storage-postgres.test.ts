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
import {AppGateway} from '../src/app-platform/gateway/gateway.ts';
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
 let api:Client|undefined,admin:Client|undefined,runtime:ReturnType<typeof createAppRuntimeComposition>|undefined,storage:Awaited<ReturnType<typeof createManagedStorageComposition>>|undefined;
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
  storage=await createManagedStorageComposition(options);
  const actor:PlatformAdministratorContext={actorType:'administrator',administrator:{id:'44000000-0000-4000-8000-000000000001',username:'test',displayName:'Test'},execution:{type:'platform'},
   request:{requestId:'test',traceId:'test',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'test',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'administrator',effectiveScopes:[],decidedAt:new Date().toISOString()})};
  runtime=createAppRuntimeComposition({registry,gateway:{drain:async()=>{}} as unknown as AppGateway,storage,artifactRoot:join(root,'runtime'),readArtifact,
   connectLease:async()=>{const client=new Client({connectionString:apiUrl.href});await client.connect();return client;},
   external:{check:async()=>{},stop:async()=>{}}});
  const keys=generateKeyPairSync('ed25519'),privateFile=join(root,'private.pem');await writeFile(privateFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const policy={policyVersion:'1.0' as const,revision:1,keys:[{keyId:'test-key',publisherId:'test',publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),revoked:false,appIds:['upgrade-fault','storage-test','storage-fault','storage-other'],validFrom:'2020-01-01T00:00:00Z',validUntil:'2099-01-01T00:00:00Z'}]};
  const installer=new AppInstaller({registry,journal,artifactRoot:join(root,'packages'),loadPublisherPolicy:async()=>policy,approve:async()=>true,getHost:r=>runtime!.getHost(r.appId)});
  const versions=new AppVersionService({registry,journal:versionsJournal,installJournal:journal,artifactRoot:join(root,'packages'),loadPublisherPolicy:async()=>policy,approve:async()=>true,getHost:id=>runtime!.getHost(id)});
  const migration=JSON.stringify({migrationVersion:'1.0',operations:[{kind:'createTable',table:'records',columns:[{name:'id',type:'integer',nullable:false},{name:'value',type:'text',nullable:false}],primaryKey:['id']},{kind:'createTable',table:'inventory',columns:[{name:'id',type:'uuid',nullable:false},{name:'quantity',type:'integer',nullable:false},{name:'version',type:'integer',nullable:false}],primaryKey:['id']},{kind:'createTable',table:'entries',columns:[{name:'id',type:'uuid',nullable:false},{name:'value',type:'jsonb',nullable:false},{name:'occurred_at',type:'timestamptz',nullable:true}],primaryKey:['id']}]});
  async function bundle(id:string,version:string,incremental=false){
   const directory=join(root,id+'-'+version);await mkdir(directory);
   const manifest:AppManifest={manifestVersion:'1.0',id,version,name:id,description:'test',publisherId:'test',
    compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},
    ui:{mode:'none'},backend:{mode:'external',origin:'https://example.com'},storage:{mode:'managed',migrations:[{id:'initial',artifactId:'migration'}]},
    routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],network:{frontendOrigins:[],backendOrigins:[]},
    artifacts:[{id:'migration',kind:'migration',path:'initial.json',sha256:createHash('sha256').update(migration).digest('hex'),bytes:Buffer.byteLength(migration)}]};
   if(incremental&&manifest.storage.mode==='managed'){
    const addition=JSON.stringify({migrationVersion:'1.0',operations:[{kind:'addColumn',table:'inventory',column:{name:'note',type:'text',nullable:true}}]});
    manifest.storage.migrations.push({id:'inventory-note',artifactId:'inventory-note'});
    manifest.artifacts.push({id:'inventory-note',kind:'migration',path:'inventory-note.json',sha256:createHash('sha256').update(addition).digest('hex'),bytes:Buffer.byteLength(addition)});
    await writeFile(join(directory,'inventory-note.json'),addition);
   }
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
  let allowed=true,denyAfterStatement=false,employeeAllowed=true,revokeEmployeeAfterStatement=false,batchStatements=0;
  const appActor={actorType:'service',execution:{type:'service',appId:record.appId,serviceIdentityId:'test-service'},
   authorize:async(permissionCode:string)=>({allowed,permissionCode})} as PlatformActorContext;
  const connectAdmin=async()=>{const c=new Client({connectionString:adminUrl.href});await c.connect();return c;};
  const credentials=parseStorageDatabaseUrl(adminUrl.href);const {host:dbHost,port,database:dbName,ssl}=credentials;
  const runtimeData=new AppRuntimeDataService({connectAdmin,endpoint:{host:dbHost,port,database:dbName,ssl},findInstallation:(c,id)=>new PostgresAppRegistryRepository(c).findByAppId(id),
   ...(process.env.MOP_APP_STORAGE_TIMING==='1'?{observeTiming:(timing:Parameters<NonNullable<ConstructorParameters<typeof AppRuntimeDataService>[0]['observeTiming']>>[0])=>console.info(JSON.stringify({event:'app_storage_test_timing',...timing}))}:{}),
   connectRuntime:async creds=>{const c=new Client({...creds,options:'-c search_path=pg_catalog'});await c.connect();
    assert.equal((await c.query('SELECT session_user')).rows[0].session_user,plan.runtimeRole);
    await assert.rejects(c.query('SELECT * FROM public.platform_employee_accounts'),/permission denied/);
    await assert.rejects(c.query(`SELECT * FROM "${otherPlan.schema}".entries`),/permission denied/);
    await assert.rejects(c.query(`CREATE TABLE "${plan.schema}".forbidden(id int)`),/permission denied/);
    await assert.rejects(c.query(`SET ROLE "${plan.ownerRole}"`),/permission denied/);
    return {query:async(sql,args)=>{if(sql.startsWith('SELECT jsonb_build_array('))batchStatements++;const r=await c.query(sql,args?[...args]:undefined);if(denyAfterStatement&&(sql.startsWith('WITH r AS (')||sql.startsWith('SELECT jsonb_build_array(')))allowed=false;if(revokeEmployeeAfterStatement&&sql.startsWith('WITH r AS ('))employeeAllowed=false;return r;},end:()=>c.end()};
   }});
  const id=randomUUID(),requestId=randomUUID(),signal=new AbortController().signal;
  const call=(input:unknown,write:boolean|'list'|'transaction'|'read_batch'=false)=>runtimeData.execute(appActor,input,write,signal);
  const insert={table:'entries',id,requestId,action:'insert',values:{value:{note:'own data'}}};
  assert.equal((await storage.runtimeData.execute(appActor,insert,true,signal)).row.value.note,'own data');
  assert.equal((await storage.runtimeData.execute(appActor,{table:'entries',id},false,signal)).row.id,id);
  assert.equal((await storage.runtimeData.execute(appActor,{table:'entries',id},false,signal)).row.id,id);
  assert.equal((await call({table:'entries',id})).row.value.note,'own data');
  const grouped=await call({operations:[{table:'entries',id},{table:'entries',pageSize:1,filters:[{column:'id',value:id}]},{table:'entries',ids:[id]}]},'read_batch');
  assert.equal(grouped.results[0].row.id,id);
  assert.deepEqual(grouped.results[1].rows.map((row:{id:string})=>row.id),[id]);
  assert.deepEqual(grouped.results[2].rows.map((row:{id:string})=>row.id),[id]);
  assert.equal(batchStatements,1);
  denyAfterStatement=true;
  await assert.rejects(call({operations:[{table:'entries',id},{table:'entries',pageSize:1}]},'read_batch'),/ACCESS_DENIED/);
  denyAfterStatement=false;allowed=true;
  await assert.rejects(call({table:'entries',id,requestId:randomUUID(),action:'update',values:{occurred_at:'not-a-date'}},true),/INVALID_PARAMS/);
  await call({table:'entries',id,requestId:randomUUID(),action:'update',values:{occurred_at:'2026-09-16T00:00:00Z'}},true);
  assert.equal(Date.parse((await call({table:'entries',id})).row.occurred_at),Date.parse('2026-09-16T00:00:00Z'));
  const page=await call({table:'entries',pageSize:1,filters:[{column:'id',value:id}]},'list');
  assert.equal(page.rows[0].id,id);assert.equal(page.nextCursor,null);
  assert.deepEqual((await call({table:'entries',afterId:id},'list')).rows,[]);
  await assert.rejects(call(insert,true),/STORAGE_REQUEST_ALREADY_RECORDED/);
  await assert.rejects(call({table:'public.platform_people',id}));
  await assert.rejects(call({table:'entries',id,schema:'public'}));
  await assert.rejects(runtimeData.execute({...appActor,actorType:'person'} as PlatformActorContext,{table:'entries',id},false,signal),/ACCESS_DENIED/);
  allowed=false;await assert.rejects(call({table:'entries',id}),/ACCESS_DENIED/);allowed=true;
  denyAfterStatement=true;
  await assert.rejects(call({table:'entries'},'list'),/ACCESS_DENIED/);allowed=true;
  await assert.rejects(call({table:'entries',id,requestId:randomUUID(),action:'update',values:{value:{note:'denied'}}},true),/ACCESS_DENIED/);
  denyAfterStatement=false;allowed=true;
  assert.equal((await call({table:'entries',id})).row.value.note,'own data');
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.platform_app_runtime_storage_writes WHERE status='rolled_back'")).rows[0].n,1);
  // A still-valid service grant cannot bypass revocation of the employee call that caused it.
  const guardedGateway=new AppGateway({registry:{authenticateServiceCredential:async()=>({actorType:'service',trustedIdentity:{source:'service'},execution:appActor.execution}) as never},contextResolver:{resolve:async()=>appActor},operations:runtimeData.operations()});
  const guardedRequest=randomUUID();revokeEmployeeAfterStatement=true;
  await assert.rejects(guardedGateway.invokeService(record.appId,'host-only',{version:'1.0',operation:'platform.app_data.write',params:{table:'entries',id,requestId:guardedRequest,action:'update',values:{value:{note:'employee revoked'}}}},undefined,async()=>{if(!employeeAllowed)throw Error('revoked');}),/ACCESS_DENIED/);
  await guardedGateway.drain(record.appId);revokeEmployeeAfterStatement=false;employeeAllowed=true;
  assert.equal(allowed,true);
  assert.equal((await call({table:'entries',id})).row.value.note,'own data');
  assert.equal((await admin.query('SELECT status FROM public.platform_app_runtime_storage_writes WHERE request_id=$1',[guardedRequest])).rows[0].status,'rolled_back');
  await call({table:'entries',id,requestId:randomUUID(),action:'update',values:{value:{note:'changed'}}},true);
  assert.equal((await call({table:'entries',id})).row.value.note,'changed');
  await call({table:'entries',id,requestId:randomUUID(),action:'delete'},true);
  assert.equal((await call({table:'entries',id})).row,null);
  // Stock and ledger changes are a single runtime transaction with a compare-and-set guard.
  const stockId=randomUUID(),ledgerId=randomUUID();
  await call({table:'inventory',id:stockId,requestId:randomUUID(),action:'insert',values:{quantity:10,version:1}},true);
  const batch={requestId:randomUUID(),operations:[
   {table:'inventory',id:stockId,action:'update',values:{quantity:7,version:2},expected:{quantity:10,version:1}},
   {table:'entries',id:ledgerId,action:'insert',values:{value:{quantity:-3}}},
  ]};
  assert.equal((await call(batch,'transaction')).results.length,2);
  assert.equal((await call({table:'inventory',id:stockId})).row.quantity,7);
  await assert.rejects(call(batch,'transaction'),/STORAGE_REQUEST_ALREADY_RECORDED/);
  const rolledBackLedger=randomUUID(),stale={requestId:randomUUID(),operations:[
   {table:'entries',id:rolledBackLedger,action:'insert',values:{value:{quantity:-3}}},
   {table:'inventory',id:stockId,action:'update',values:{quantity:4,version:3},expected:{version:1}},
  ]};
  await assert.rejects(call(stale,'transaction'),/STORAGE_CONFLICT/);
  assert.equal((await call({table:'entries',id:rolledBackLedger})).row,null);
  assert.equal((await call({table:'inventory',id:stockId})).row.quantity,7);
  assert.equal((await admin.query('SELECT status FROM public.platform_app_runtime_storage_writes WHERE request_id=$1',[stale.requestId])).rows[0].status,'rolled_back');
  // Revocation after the first statement rolls back all changes and inserts no later ledger row.
  denyAfterStatement=true;
  await assert.rejects(call({requestId:randomUUID(),operations:[
   {table:'inventory',id:stockId,action:'update',values:{quantity:4,version:3},expected:{version:2}},
   {table:'entries',id:rolledBackLedger,action:'insert',values:{value:{quantity:-3}}},
  ]},'transaction'),/ACCESS_DENIED/);
  denyAfterStatement=false;allowed=true;
  assert.equal((await call({table:'inventory',id:stockId})).row.quantity,7);
  assert.equal((await call({table:'entries',id:rolledBackLedger})).row,null);

  const racingLedgers=[randomUUID(),randomUUID()];
  const racing=await Promise.allSettled(racingLedgers.map(entryId=>call({requestId:randomUUID(),operations:[
   {table:'inventory',id:stockId,action:'update',values:{quantity:6,version:3},expected:{quantity:7,version:2}},
   {table:'entries',id:entryId,action:'insert',values:{value:{quantity:-1}}},
  ]},'transaction')));
  assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await call({table:'inventory',id:stockId})).row.quantity,6);
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM "${plan.schema}".entries WHERE id=ANY($1::uuid[])`,[racingLedgers])).rows[0].n,1);
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
  record=await host.execute(actor,{revision:record.revision,action:'disable'});
  const incremental=await versions.update(actor,{...await bundle('storage-test','1.1.0',true),appId:record.appId,revision:record.revision,requestId:'storage-upgrade-0002'});
  assert.equal(incremental.state,'updated');record=await registry.get(actor,record.appId);assert.equal(record.enabled,false);
  assert.equal((await admin.query(`SELECT quantity,note FROM "${plan.schema}".inventory WHERE id=$1`,[stockId])).rows[0].quantity,6);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.platform_app_migration_attempts WHERE installation_id=$1',[plan.installationId])).rows[0].n,2);
  await storage.adoptVersion(actor,record.appId,record.revision); // acknowledged adoption is idempotent
  record=await host.execute(actor,{revision:record.revision,action:'enable'});
  assert.equal((await call({table:'inventory',id:stockId})).row.note,null);
  // Incremental migration commits, but its ledger acknowledgement fails. Recovery never replays it.
  await installer.install(actor,{...await bundle('upgrade-fault','1.0.0'),requestId:'upgrade-fault-install'});
  let upgradeFault=await registry.get(actor,'upgrade-fault');const faultHost=await runtime.getHost('upgrade-fault');
  upgradeFault=await faultHost.execute(actor,{revision:upgradeFault.revision,action:'disable'});
  await admin.query(`CREATE FUNCTION public.test_upgrade_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test ledger unavailable'; END$$;
   REVOKE ALL ON FUNCTION public.test_upgrade_finish() FROM PUBLIC;
   CREATE TRIGGER test_upgrade_finish BEFORE UPDATE ON public.platform_app_migration_attempts FOR EACH ROW WHEN (OLD.ordinal=1) EXECUTE FUNCTION public.test_upgrade_finish()`);
  const faultUpgrade={...await bundle('upgrade-fault','1.1.0',true),appId:'upgrade-fault',revision:upgradeFault.revision,requestId:'upgrade-fault-version'};
  await assert.rejects(versions.update(actor,faultUpgrade),/VERSION_RECOVERY_REQUIRED/);
  assert.equal((await versions.update(actor,faultUpgrade)).state,'recovery_required');
  upgradeFault=await registry.get(actor,'upgrade-fault');assert.equal(upgradeFault.enabled,false);
  const faultAttempt=(await admin.query("SELECT id FROM public.platform_app_migration_attempts WHERE installation_id=$1 AND status='running'",[upgradeFault.id])).rows[0];assert.ok(faultAttempt);
  await assert.rejects(storage.assertReady(actor,'upgrade-fault',upgradeFault.revision),/MIGRATION_ATTEMPT_BLOCKED/);
  await assert.rejects(versions.recover(actor,'upgrade-fault',faultUpgrade.requestId),/MIGRATION_ATTEMPT_BLOCKED/);
  await admin.query('DROP TRIGGER test_upgrade_finish ON public.platform_app_migration_attempts; DROP FUNCTION public.test_upgrade_finish()');
  assert.equal((await storage.reconcile(actor,'upgrade-fault',upgradeFault.revision,faultAttempt.id)).status,'applied');
  assert.equal((await versions.recover(actor,'upgrade-fault',faultUpgrade.requestId)).state,'recovered');
  upgradeFault=await registry.get(actor,'upgrade-fault');assert.equal(upgradeFault.enabled,false);
  upgradeFault=await faultHost.execute(actor,{revision:upgradeFault.revision,action:'enable'});
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.platform_app_migration_attempts WHERE installation_id=$1',[upgradeFault.id])).rows[0].n,2);
  // Lost completion acknowledgement follows a committed write; no cleanup may fabricate its outcome.
  await admin.query(`CREATE FUNCTION public.test_runtime_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test completion unavailable'; END$$;
   REVOKE ALL ON FUNCTION public.test_runtime_finish() FROM PUBLIC;
   CREATE TRIGGER test_runtime_finish BEFORE UPDATE ON public.platform_app_runtime_storage_writes FOR EACH ROW EXECUTE FUNCTION public.test_runtime_finish()`);
  const uncertain={requestId:randomUUID(),operations:[
   {table:'inventory',id:stockId,action:'update',values:{quantity:5,version:4},expected:{quantity:6,version:3}},
   {table:'entries',id,action:'insert',values:{value:{note:'committed'}}},
  ]};
  await assert.rejects(call(uncertain,'transaction'));
  assert.equal((await admin.query(`SELECT value FROM "${plan.schema}".entries WHERE id=$1`,[id])).rows[0].value.note,'committed');
  assert.equal((await admin.query(`SELECT quantity FROM "${plan.schema}".inventory WHERE id=$1`,[stockId])).rows[0].quantity,5);
  await admin.query('DROP TRIGGER test_runtime_finish ON public.platform_app_runtime_storage_writes; DROP FUNCTION public.test_runtime_finish()');
  await assert.rejects(call(uncertain,'transaction'),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  await assert.rejects(call({table:'entries',id}),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  await assert.rejects(call({table:'entries'},'list'),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  await assert.rejects(storage.assertReady(actor,record.appId,record.revision),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  assert.equal((await admin.query("SELECT status FROM public.platform_app_runtime_storage_writes WHERE request_id=$1",[uncertain.requestId])).rows[0].status,'dispatched');
  await assert.rejects(storage.reconcileWrite(actor,record.appId,record.revision,uncertain.requestId),/STORAGE_REQUIRES_DISABLED/);
  record=await host.execute(actor,{revision:record.revision,action:'disable'});
  const deniedActor={...actor,authorize:async(permissionCode:string)=>({...await actor.authorize(permissionCode),allowed:false})};
  await assert.rejects(storage.reconcileWrite(deniedActor,record.appId,record.revision,uncertain.requestId),/STORAGE_ACCESS_DENIED/);
  assert.equal((await storage.reconcileWrite(actor,record.appId,record.revision,uncertain.requestId)).status,'completed');
  assert.equal((await storage.reconcileWrite(actor,record.appId,record.revision,uncertain.requestId)).status,'completed');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.platform_app_runtime_write_reconciliations WHERE request_id=$1',[uncertain.requestId])).rows[0].n,1);
  assert.equal((await admin.query('SELECT evidence FROM public.platform_app_runtime_write_reconciliations WHERE request_id=$1',[uncertain.requestId])).rows[0].evidence,'committed');
  record=await host.execute(actor,{revision:record.revision,action:'enable'});
  assert.equal((await call({table:'inventory',id:stockId})).row.quantity,5);
  await assert.rejects(call(uncertain,'transaction'),/STORAGE_REQUEST_ALREADY_RECORDED/);
  record=await host.execute(actor,{revision:record.revision,action:'disable'});
  record=await host.execute(actor,{revision:record.revision,action:'enable'});
  await admin.query(`CREATE FUNCTION public.test_rollback_finish() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'test ledger unavailable'; END$$;
   REVOKE ALL ON FUNCTION public.test_rollback_finish() FROM PUBLIC;
   CREATE TRIGGER test_rollback_finish BEFORE UPDATE ON public.platform_app_runtime_storage_writes FOR EACH ROW EXECUTE FUNCTION public.test_rollback_finish()`);
  const abortRequest=randomUUID();
  await assert.rejects(call({requestId:abortRequest,operations:[{table:'inventory',id:stockId,action:'update',values:{quantity:0},expected:{quantity:999}}]},'transaction'),/STORAGE_WRITE_UNCERTAIN/);
  await admin.query('DROP TRIGGER test_rollback_finish ON public.platform_app_runtime_storage_writes; DROP FUNCTION public.test_rollback_finish()');
  record=await host.execute(actor,{revision:record.revision,action:'disable'});
  assert.equal((await storage.reconcileWrite(actor,record.appId,record.revision,abortRequest)).status,'rolled_back');
  assert.equal((await admin.query('SELECT evidence FROM public.platform_app_runtime_write_reconciliations WHERE request_id=$1',[abortRequest])).rows[0].evidence,'aborted');
  assert.equal((await admin.query(`SELECT quantity FROM "${plan.schema}".inventory WHERE id=$1`,[stockId])).rows[0].quantity,5);
  // A legacy dispatched record without transaction evidence cannot be classified or deleted.
  const legacyRequest=randomUUID();
  await admin.query("INSERT INTO public.platform_app_runtime_storage_writes(installation_id,request_id,manifest_digest,request_digest,status) VALUES($1,$2,$3,$4,'dispatched')",[record.id,legacyRequest,'a'.repeat(64),'b'.repeat(64)]);
  await assert.rejects(storage.reconcileWrite(actor,record.appId,record.revision,legacyRequest),/STORAGE_WRITE_RECONCILIATION_REQUIRED/);
  assert.equal((await admin.query('SELECT status FROM public.platform_app_runtime_storage_writes WHERE request_id=$1',[legacyRequest])).rows[0].status,'dispatched');
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
  await storage?.closeRuntimeConnections();
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
