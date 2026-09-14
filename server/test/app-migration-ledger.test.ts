import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { AppMigrationLedger, APP_MIGRATION_LEDGER_MIGRATIONS, type AppMigrationAttempt } from '../src/app-platform/storage/index.ts';
import { AppRegistryService, PostgresAppRegistryRepository, APP_REGISTRY_MIGRATIONS } from '../src/app-platform/registry/index.ts';
import type { QueryableClient } from '../src/core/database/index.ts';
import type { PlatformPersonActorContext } from '../src/platform/context/index.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';
import { AppMigrationReceipts } from '../src/app-platform/storage/migration-receipts.ts';
import { APP_MIGRATION_RECEIPT_SQL } from '../src/app-platform/storage/receipt-migration.ts';
import { APP_STORAGE_LEASE_SQL } from '../src/app-platform/storage/lease-migration.ts';
import { binding } from '../src/app-platform/storage/binding.ts';

const now = '2026-09-10T00:00:00.000Z';
const admin: PlatformPersonActorContext = {
  actorType:'person', trustedIdentity:{source:'session',userId:'admin'}, execution:{type:'platform'},
  request:{requestId:'r',traceId:'t',startedAt:now},
  person:{id:'admin',employeeNo:'1',name:'Admin',avatarUrl:null,organization:{id:'org',code:'org',name:'Org',unitType:'company'},position:{id:'p',code:'p',name:'P'}},
  authorize:async permissionCode => ({id:'decision',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'person',effectiveScopes:[],decidedAt:now}),
};
function manifest(id='tool-lending'): AppManifest {
  const artifacts = [0,1].map(i => ({id:`sql-${i}`,kind:'migration' as const,path:`migrations/${i}.json`,sha256:String(i).repeat(64),bytes:10}));
  artifacts[1].path = `${'a'.repeat(251)}.json`; // Manifest's full 256-character path is supported by SQL storage.
  return {manifestVersion:'1.0',id,version:'1.0.0',name:'Tools',description:'fixture',publisherId:'example',
    compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},
    permissions:{requested:[],defined:[]},ui:{mode:'none'},backend:{mode:'external',origin:'https://example.com'},
    storage:{mode:'managed',migrations:artifacts.map(item=>({id:item.id,artifactId:item.id}))},
    routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],artifacts,network:{frontendOrigins:[],backendOrigins:[]}};
}
async function fixture() {
  const db = new PGlite();
  let failInsert = false, time = now;
  let transactionStatus: string | null = 'committed';
  const client: QueryableClient = {query:async(sql,values) => {
    // PGlite has no independent-session xid visibility: real PostgreSQL covers this separately.
    if(sql==='SELECT pg_xact_status($1::xid8) AS status') return {rows:[{status:transactionStatus}]};
    const result = values ? await db.query(sql,[...values]) : await db.exec(sql);
    if (failInsert && sql.startsWith('INSERT INTO platform_app_migration_attempts')) { failInsert=false; throw new Error('simulated write interruption'); }
    return result;
  }};
  await APP_REGISTRY_MIGRATIONS[0].run({client});
  await APP_MIGRATION_LEDGER_MIGRATIONS[0].run({client});
  await APP_MIGRATION_LEDGER_MIGRATIONS[0].run({client});
  const registry = new AppRegistryService(new PostgresAppRegistryRepository(client), {host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>[]}});
  const record = await registry.register(admin,manifest());
  const ledger = new AppMigrationLedger(registry,client,()=>new Date(time));
  return {db,client,registry,record,ledger,failInsert:()=>{failInsert=true;},setTime:(value:string)=>{time=value;},setStatus:(value:string|null)=>{transactionStatus=value;}};
}
const begin = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const attempt=await f.ledger.beginNext(admin,f.record.appId,f.record.revision); assert.ok(attempt); return attempt;
};

async function receiptFixture() {
 const f=await fixture();
 await f.db.exec(APP_STORAGE_LEASE_SQL); await f.db.exec(APP_MIGRATION_RECEIPT_SQL);
 const b=binding(f.record); assert.equal(b.mode,'managed'); if(b.mode!=='managed') throw new Error('fixture');
 await f.db.exec(`CREATE ROLE "${b.ownerRole}" NOLOGIN`);
 const a=await begin(f);
 const request={binding:b,revision:a.registeredRevision,attemptId:a.id,ordinal:a.ordinal,
  step:{id:a.migrationId,artifactId:a.artifactId,path:a.artifactPath,sha256:a.artifactSha256,bytes:a.artifactBytes,sql:'',declarationJson:''}};
 const receipts=new AppMigrationReceipts(f.client);
 const database=(await f.db.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
 return {...f,a,request,receipts,database};
}

test('durable dispatch cannot replay; xid registers exactly once and committed reconciliation is audited',async()=>{
 const f=await receiptFixture(); try {
  await f.receipts.dispatch(f.request);
  await assert.rejects(f.receipts.dispatch(f.request));
  await assert.rejects(f.receipts.recordTransaction({...f.request,ordinal:1},{xid:'10',database:f.database}),/MIGRATION_RECEIPT_CONFLICT/);
  await f.receipts.recordTransaction(f.request,{xid:'10',database:f.database});
  await assert.rejects(f.receipts.recordTransaction(f.request,{xid:'11',database:f.database}),/MIGRATION_RECEIPT_CONFLICT/);
  await f.ledger.finish(admin,f.record.appId,f.a.id,'uncertain');
  const done=await f.ledger.reconcile(admin,f.record.appId,f.a.id); assert.equal(done.status,'applied');
  assert.deepEqual(await f.ledger.reconcile(admin,f.record.appId,f.a.id),done);
  const audit=await f.db.query<{evidence:string;previous_status:string}>('SELECT * FROM platform_app_migration_reconciliations');
  assert.equal(audit.rows.length,1); assert.equal(audit.rows[0].evidence,'committed'); assert.equal(audit.rows[0].previous_status,'uncertain');
 } finally {await f.db.close();}
});

test('missing dispatch blocks; dispatched but no xid can roll back only with quiescent owner',async()=>{
 const f=await receiptFixture(); try {
  await assert.rejects(f.ledger.reconcile(admin,f.record.appId,f.a.id),/MIGRATION_RECONCILIATION_BLOCKED/);
  await f.receipts.dispatch(f.request);
  await f.db.exec(`ALTER ROLE "${f.request.binding.ownerRole}" LOGIN`);
  await assert.rejects(f.ledger.reconcile(admin,f.record.appId,f.a.id),/MIGRATION_RECONCILIATION_NOT_QUIESCENT/);
  await f.db.exec(`ALTER ROLE "${f.request.binding.ownerRole}" NOLOGIN`);
  await f.db.query(`INSERT INTO platform_app_storage_leases(id,installation_id,owner_role,registered_revision,status,expires_at)
   VALUES('00000000-0000-4000-8000-000000000099',$1,$2,1,'active',clock_timestamp()+interval '1 minute')`,[f.record.id,f.request.binding.ownerRole]);
  await assert.rejects(f.ledger.reconcile(admin,f.record.appId,f.a.id),/MIGRATION_RECONCILIATION_NOT_QUIESCENT/);
  await f.db.query("UPDATE platform_app_storage_leases SET status='released',released_at=clock_timestamp() WHERE installation_id=$1",[f.record.id]);
  assert.equal((await f.ledger.reconcile(admin,f.record.appId,f.a.id)).status,'rolled_back');
  assert.notEqual((await begin(f)).id,f.a.id);
 } finally {await f.db.close();}
});

test('unknown/in-progress transactions remain blocked; aborted evidence permits audited retry',async()=>{
 const f=await receiptFixture(); try {
  await f.receipts.dispatch(f.request); await f.receipts.recordTransaction(f.request,{xid:'10',database:f.database});
  for(const status of [null,'in progress']) {
   f.setStatus(status); await assert.rejects(f.ledger.reconcile(admin,f.record.appId,f.a.id),/MIGRATION_RECONCILIATION_BLOCKED/);
  }
  await f.db.query("UPDATE platform_app_migration_receipts SET database_name='wrong-database' WHERE attempt_id=$1",[f.a.id]);
  await assert.rejects(f.ledger.reconcile(admin,f.record.appId,f.a.id),/MIGRATION_RECEIPT_CONFLICT/);
  await f.db.query('UPDATE platform_app_migration_receipts SET database_name=$2 WHERE attempt_id=$1',[f.a.id,f.database]);
  assert.equal((await f.db.query('SELECT * FROM platform_app_migration_reconciliations')).rows.length,0);
  f.setStatus('aborted'); assert.equal((await f.ledger.reconcile(admin,f.record.appId,f.a.id)).status,'rolled_back');
 } finally {await f.db.close();}
});

test('disk-backed ledger retains an unresolved attempt after database close and reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-'));
  t.diagnostic(`Isolated ledger diagnostic directory retained: ${directory}`);
  const open = () => {
    const db = new PGlite(directory);
    const client: QueryableClient = {query:async(sql,values)=>values ? db.query(sql,[...values]) : db.exec(sql)};
    const registry = new AppRegistryService(new PostgresAppRegistryRepository(client), {
      host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]}), authorization:{listPermissions:async()=>[]}
    });
    return {db,client,registry,ledger:new AppMigrationLedger(registry,client,()=>new Date(now))};
  };
  const first = open();
  let attemptId: string;
  try {
    await APP_REGISTRY_MIGRATIONS[0].run({client:first.client});
    await APP_MIGRATION_LEDGER_MIGRATIONS[0].run({client:first.client});
    await first.registry.register(admin,manifest());
    const attempt = await first.ledger.beginNext(admin,'tool-lending',1);
    assert.ok(attempt); attemptId = attempt.id;
  } finally { await first.db.close(); }
  const reopened = open();
  try {
    const history = await reopened.ledger.listHistory(admin,'tool-lending');
    assert.equal(history.length,1); assert.equal(history[0].id,attemptId); assert.equal(history[0].status,'running');
    await assert.rejects(reopened.ledger.beginNext(admin,'tool-lending',1),/MIGRATION_ATTEMPT_BLOCKED/);
    await reopened.ledger.finish(admin,'tool-lending',attemptId,'rolled_back');
    const retry = await reopened.ledger.beginNext(admin,'tool-lending',1);
    assert.ok(retry); assert.notEqual(retry.id,attemptId); assert.equal(retry.ordinal,0);
  } finally { await reopened.db.close(); }
});

test('durable ledger survives service restart, uses manifest order and never replays applied migrations', async () => {
  const f=await fixture();
  try {
    const first=await begin(f);
    assert.equal(first.ordinal,0); assert.equal(first.migrationId,'sql-0'); assert.equal(first.status,'running');
    assert.equal(first.artifactSha256,'0'.repeat(64)); assert.equal(first.finishedAt,null);
    await f.ledger.finish(admin,f.record.appId,first.id,'applied');
    const restarted = new AppMigrationLedger(f.registry,f.client,()=>new Date(now));
    const second=await restarted.beginNext(admin,f.record.appId,1); assert.ok(second); assert.equal(second.ordinal,1); assert.equal(second.artifactPath.length,256);
    await restarted.finish(admin,f.record.appId,second.id,'applied');
    assert.equal(await restarted.beginNext(admin,f.record.appId,1),null);
    const history=await restarted.listHistory(admin,f.record.appId,0,1);
    assert.equal(history.length,1); assert.equal(history[0].id,first.id);
    const page=await restarted.listHistory(admin,f.record.appId,history[0].sequence,1);
    assert.equal(page[0].id,second.id); assert.equal(page[0].status,'applied');
    assert.equal('sql' in page[0],false); assert.equal('credentialDigest' in page[0],false);
    const tables=await f.db.query<{name:string}>("SELECT tablename AS name FROM pg_tables WHERE schemaname='public'");
    assert.deepEqual(tables.rows.map(row=>row.name).sort(),['platform_app_installation_history','platform_app_installations','platform_app_migration_attempts']);
  } finally { await f.db.close(); }
});

test('running/uncertain block forever; confirmed rollback retries with new identity and terminal retries are immutable', async () => {
  const f=await fixture();
  try {
    const first=await begin(f);
    await assert.rejects(begin(f),/MIGRATION_ATTEMPT_BLOCKED/);
    const finished=await f.ledger.finish(admin,f.record.appId,first.id,'rolled_back');
    f.setTime('2030-01-01T00:00:00.000Z');
    assert.deepEqual(await f.ledger.finish({...admin,person:{...admin.person,id:'another-admin'}},f.record.appId,first.id,'rolled_back'),finished);
    await assert.rejects(f.ledger.finish(admin,f.record.appId,first.id,'applied'),/MIGRATION_TERMINAL_CONFLICT/);
    const retry=await begin(f); assert.notEqual(retry.id,first.id); assert.equal(retry.ordinal,0);
    await f.ledger.finish(admin,f.record.appId,retry.id,'uncertain');
    f.setTime('2040-01-01T00:00:00.000Z');
    await assert.rejects(begin(f),/MIGRATION_ATTEMPT_BLOCKED/);
    await assert.rejects(f.ledger.finish(admin,f.record.appId,retry.id,'rolled_back'),/MIGRATION_TERMINAL_CONFLICT/);
    assert.deepEqual((await f.ledger.listHistory(admin,f.record.appId)).map(row=>row.status),['rolled_back','uncertain']);
  } finally { await f.db.close(); }
});

test('native authorization is checked before querying; reads need read permission and pagination is bounded', async () => {
  const f=await fixture();
  try {
    let queries=0;
    const forbidden = new AppMigrationLedger(f.registry,{query:async()=>{queries++;throw new Error('unexpected query');}});
    const contexts=[{...admin,execution:{type:'application' as const,appId:f.record.appId}},
      {...admin,authorize:async(code:string)=>({...await admin.authorize(code),allowed:false})}];
    for (const context of contexts) {
      await assert.rejects(forbidden.beginNext(context,f.record.appId,1),/STORAGE_ACCESS_DENIED/);
      await assert.rejects(forbidden.finish(context,f.record.appId,'invalid','applied'),/STORAGE_ACCESS_DENIED/);
      await assert.rejects(forbidden.listHistory(context,f.record.appId),/STORAGE_ACCESS_DENIED/);
    }
    assert.equal(queries,0);
    const reader={...admin,authorize:async(code:string)=>({...await admin.authorize(code),allowed:code.endsWith('.read')})};
    assert.deepEqual(await f.ledger.listHistory(reader,f.record.appId),[]);
    await assert.rejects(f.ledger.beginNext(reader,f.record.appId,1),/STORAGE_ACCESS_DENIED/);
    for (const [after,limit] of [[-1,1],[0,0],[0,201],[0,1.2],[2147483648,1]]) await assert.rejects(f.ledger.listHistory(admin,f.record.appId,after,limit),/INVALID_PAGE/);
  } finally { await f.db.close(); }
});

test('fresh revision and shared connection required; concurrent commands produce exactly one reservation', async () => {
  const f=await fixture();
  try {
    await f.registry.setEnabled(admin,f.record.appId,1,true);
    await assert.rejects(begin(f),/STALE_REVISION/);
    const wrongClient:QueryableClient={query:(sql,values)=>f.client.query(sql,values)};
    await assert.rejects(new AppMigrationLedger(f.registry,wrongClient).beginNext(admin,f.record.appId,2),/ATOMIC_CONNECTION_MISMATCH/);
    const results=await Promise.allSettled([f.ledger.beginNext(admin,f.record.appId,2),f.ledger.beginNext(admin,f.record.appId,2)]);
    assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
    assert.equal((await f.ledger.listHistory(admin,f.record.appId)).length,1);
    const attempt=(results.find(item=>item.status==='fulfilled') as PromiseFulfilledResult<AppMigrationAttempt>).value;
    assert.equal(attempt.registeredRevision,2);
    // A grant/config revision change cannot prevent recording an already-reserved attempt's outcome.
    await f.registry.setEnabled(admin,f.record.appId,2,false);
    await f.ledger.finish(admin,f.record.appId,attempt.id,'applied');
  } finally { await f.db.close(); }
});

test('failed write rolls back reservation; installation scope, clock and outcome remain fail closed', async () => {
  const f=await fixture();
  try {
    f.failInsert(); await assert.rejects(begin(f),/simulated write interruption/);
    assert.deepEqual(await f.ledger.listHistory(admin,f.record.appId),[]);
    const attempt=await begin(f);
    const other=await f.registry.register(admin,manifest('other-app'));
    await assert.rejects(f.ledger.finish(admin,other.appId,attempt.id,'applied'),/MIGRATION_ATTEMPT_NOT_FOUND/);
    await assert.rejects(f.ledger.finish(admin,f.record.appId,attempt.id,'failed' as 'applied'),/INVALID_MIGRATION_OUTCOME/);
    f.setTime('2020-01-01T00:00:00.000Z');
    await assert.rejects(f.ledger.finish(admin,f.record.appId,attempt.id,'applied'),/MIGRATION_CLOCK_REGRESSION/);
    assert.equal((await f.ledger.listHistory(admin,f.record.appId))[0].status,'running');
  } finally { await f.db.close(); }
});

test('SQL constraints reject malformed metadata, mismatched terminal timestamps, duplicate active/applied and missing installation', async () => {
  const f=await fixture();
  try {
    const attempt=await begin(f);
    for (const assignment of ["manifest_digest='bad'","artifact_sha256='bad'",'ordinal=-1','ordinal=128','artifact_bytes=0','artifact_bytes=1048577',
      "status='applied'","status='failed'","finished_by='admin'","started_by=''","started_at='infinity'",'registered_revision=0',
      "installation_id='00000000-0000-4000-8000-000000000000'"])
      await assert.rejects(f.db.query(`UPDATE platform_app_migration_attempts SET ${assignment} WHERE id=$1`,[attempt.id]));
    const copy = `INSERT INTO platform_app_migration_attempts(id,installation_id,registered_revision,manifest_digest,ordinal,migration_id,artifact_id,artifact_path,artifact_sha256,artifact_bytes,status,started_at,started_by,finished_at,finished_by)
      SELECT '00000000-0000-4000-8000-000000000001',installation_id,registered_revision,manifest_digest,ordinal,migration_id,artifact_id,artifact_path,artifact_sha256,artifact_bytes,status,started_at,started_by,finished_at,finished_by FROM platform_app_migration_attempts WHERE id=$1`;
    await assert.rejects(f.db.query(copy,[attempt.id]),/unique/);
    await f.ledger.finish(admin,f.record.appId,attempt.id,'applied');
    await assert.rejects(f.db.query(copy,[attempt.id]),/unique/);
    await assert.rejects(f.db.query('DELETE FROM platform_app_installations WHERE id=$1',[f.record.id]),/foreign key/);
  } finally { await f.db.close(); }
});

test('registered manifest metadata is authoritative; malformed/out-of-order ledger and nonmanaged storage cannot proceed', async () => {
  const f=await fixture();
  try {
    const attempt=await begin(f);
    await f.db.query('UPDATE platform_app_migration_attempts SET ordinal=1 WHERE id=$1',[attempt.id]);
    await assert.rejects(f.ledger.finish(admin,f.record.appId,attempt.id,'applied'),/MIGRATION_LEDGER_CONFLICT/);
    await f.db.query("UPDATE platform_app_migration_attempts SET status='applied',finished_at=started_at,finished_by=started_by WHERE id=$1",[attempt.id]);
    await assert.rejects(begin(f),/MIGRATION_LEDGER_CONFLICT/);
    for (const storage of [{mode:'none' as const},{mode:'external' as const,configurationRef:'external-db'}]) {
      const m=manifest(storage.mode);m.storage=storage;m.artifacts=[];
      const record=await f.registry.register(admin,m);
      await assert.rejects(f.ledger.beginNext(admin,record.appId,1),/MIGRATION_STORAGE_NOT_MANAGED/);
    }
  } finally { await f.db.close(); }
});
