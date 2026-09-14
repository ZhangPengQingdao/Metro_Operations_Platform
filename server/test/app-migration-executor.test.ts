import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { AppMigrationExecutor, AppMigrationLedger, AppMigrationPlanner, AppStorageService, compileAppMigration,
  APP_MIGRATION_LEDGER_MIGRATIONS, type AppRestrictedMigrationDriver } from '../src/app-platform/storage/index.ts';
import { AppRegistryService, PostgresAppRegistryRepository, APP_REGISTRY_MIGRATIONS } from '../src/app-platform/registry/index.ts';
import type { QueryableClient } from '../src/core/database/index.ts';
import type { PlatformPersonActorContext } from '../src/platform/context/index.ts';
import type { AppManifest } from '../src/app-platform/manifest/index.ts';

const now='2026-09-10T00:00:00.000Z';
const admin: PlatformPersonActorContext = {
  actorType:'person', trustedIdentity:{source:'session',userId:'admin'}, execution:{type:'platform'},
  request:{requestId:'r',traceId:'t',startedAt:now},
  person:{id:'admin',employeeNo:'1',name:'Admin',avatarUrl:null,organization:{id:'org',code:'org',name:'Org',unitType:'company'},position:{id:'p',code:'p',name:'P'}},
  authorize:async permissionCode => ({id:'decision',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'person',effectiveScopes:[],decidedAt:now}),
};
async function fixture(provision=true) {
  const db=new PGlite(); let failFinish=false, reads=0;
  const client:QueryableClient={query:async(sql,values)=>{
    const result=values ? await db.query(sql,[...values]) : await db.exec(sql);
    if(failFinish && sql.startsWith('UPDATE platform_app_migration_attempts')) { failFinish=false;throw new Error('secret provider failure'); }
    return result;
  }};
  await APP_REGISTRY_MIGRATIONS[0].run({client});
  await APP_MIGRATION_LEDGER_MIGRATIONS[0].run({client});
  const database=(await db.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
  await db.exec(`REVOKE CREATE,TEMPORARY ON DATABASE "${database}" FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  const sql=['first','second'].map(table=>JSON.stringify({migrationVersion:'1.0',operations:[{kind:'createTable',table,columns:[{name:'id',type:'integer',nullable:false}]}]}));
  const artifacts=sql.map((text,i)=>({id:`sql-${i}`,kind:'migration' as const,path:`migrations/${i}.json`,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}));
  const manifest:AppManifest={manifestVersion:'1.0',id:'tool-lending',version:'1.0.0',name:'Tools',description:'fixture',publisherId:'example',
    compatibility:{platform:{minInclusive:'0.0.1',maxExclusive:'2.0.0'},capabilities:[],applications:[]},permissions:{requested:[],defined:[]},
    ui:{mode:'none'},backend:{mode:'external',origin:'https://example.com'},storage:{mode:'managed',migrations:artifacts.map(item=>({id:item.id,artifactId:item.id}))},
    routes:[],api:[],navigation:[],events:{publish:[],subscribe:[]},tools:[],jobs:[],resources:[],artifacts,network:{frontendOrigins:[],backendOrigins:[]}};
  const registry=new AppRegistryService(new PostgresAppRegistryRepository(client),{host:()=>({platformVersion:'0.0.1',capabilities:[],applications:[]}),authorization:{listPermissions:async()=>[]}});
  await registry.register(admin,manifest);
  const storage=new AppStorageService(registry,client);
  if(provision) await storage.provision(admin,manifest.id);
  const planner=new AppMigrationPlanner(registry,{read:async request=>{reads++;return Buffer.from(sql[artifacts.findIndex(item=>item.id===request.artifactId)]);}});
  const ledger=new AppMigrationLedger(registry,client);
  const executor=(driver?:AppRestrictedMigrationDriver)=>new AppMigrationExecutor(registry,planner,storage,ledger,driver);
  return {db,client,registry,storage,planner,ledger,executor,sql,appId:manifest.id,reads:()=>reads,failFinish:()=>{failFinish=true;}};
}
const run=(f:Awaited<ReturnType<typeof fixture>>, driver?:AppRestrictedMigrationDriver)=>f.executor(driver).executeNext(admin,f.appId,1);

test('trusted fake driver receives frozen verified minimal input, one step per call and completion never replays',async()=>{
  const f=await fixture();try {
    let calls=0;
    const driver:AppRestrictedMigrationDriver={execute:async request=>{
      assert.ok(Object.isFrozen(request)&&Object.isFrozen(request.step)&&Object.isFrozen(request.binding));
      assert.deepEqual(Object.keys(request).sort(),['attemptId','binding','ordinal','revision','step']);
      assert.equal(request.ordinal,calls);assert.equal(request.step.sql,compileAppMigration(f.sql[calls],request.binding.schema).join('\n'));
      const history=await f.ledger.listHistory(admin,f.appId);
      assert.equal(history.at(-1)?.id,request.attemptId);assert.equal(history.at(-1)?.status,'running');
      calls++;return 'applied';
    }};
    assert.equal((await run(f,driver)).status,'applied');assert.equal(calls,1);
    assert.equal((await run(f,driver)).status,'applied');assert.equal(calls,2);
    assert.deepEqual(await run(f,driver),{status:'complete'});assert.equal(calls,2);
    // The fake deliberately executes NO SQL: these tests are not a production sandbox claim.
    assert.equal((await f.db.query("SELECT 1 FROM pg_tables WHERE tablename IN ('first','second')")).rows.length,0);
  }finally{await f.db.close();}
});

test('missing driver and unauthorized application fail before artifacts or reservations',async()=>{
  const f=await fixture();try {
    await assert.rejects(run(f),/MIGRATION_DRIVER_REQUIRED/);
    await assert.rejects(f.executor().executeNext({...admin,authorize:async()=>{throw Error('password=secret');}},f.appId,1), /^AppStorageError: MIGRATION_COORDINATION_FAILED$/);
    await assert.rejects(f.executor({execute:async()=>{throw Error('unexpected');}}).executeNext({...admin,execution:{type:'application',appId:f.appId}},f.appId,1),/STORAGE_ACCESS_DENIED/);
    assert.equal(f.reads(),0);assert.deepEqual(await f.ledger.listHistory(admin,f.appId),[]);
  }finally{await f.db.close();}
});

test('readiness never provisions missing schema, rejects retained and privilege drift before reservation',async()=>{
  const f=await fixture(false);try {
    const driver:AppRestrictedMigrationDriver={execute:async()=>{throw Error('must not invoke');}};
    await assert.rejects(run(f,driver),/STORAGE_NOT_PROVISIONED/);
    assert.equal((await f.db.query("SELECT 1 FROM pg_namespace WHERE nspname LIKE 'app_%'")).rows.length,0);
    assert.equal((await f.db.query("SELECT 1 FROM pg_roles WHERE rolname LIKE 'app_%'")).rows.length,0);
    await f.storage.provision(admin,f.appId);
    const binding=await f.storage.assertReady(admin,f.appId);
    await f.db.exec(`GRANT CREATE ON SCHEMA "${binding.schema}" TO "${binding.runtimeRole}"`);
    await assert.rejects(run(f,driver),/STORAGE_ACL_DRIFT/);
    await f.db.exec(`REVOKE CREATE ON SCHEMA "${binding.schema}" FROM "${binding.runtimeRole}"`);
    await f.storage.preserve(admin,f.appId);
    await assert.rejects(run(f,driver),/STORAGE_RETAINED/);
    assert.deepEqual(await f.ledger.listHistory(admin,f.appId),[]);
  }finally{await f.db.close();}
});

test('stale revision and artifact mismatch fail before reservation',async()=>{
  const f=await fixture();try {
    const driver:AppRestrictedMigrationDriver={execute:async()=>{throw Error('must not invoke');}};
    await assert.rejects(f.executor(driver).executeNext(admin,f.appId,2),/STALE_REVISION/);
    const bad=new AppMigrationPlanner(f.registry,{read:async()=>Buffer.from('wrong')});
    await assert.rejects(new AppMigrationExecutor(f.registry,bad,f.storage,f.ledger,driver).executeNext(admin,f.appId,1),/MIGRATION_BYTE_LENGTH_MISMATCH/);
    assert.deepEqual(await f.ledger.listHistory(admin,f.appId),[]);
  }finally{await f.db.close();}
});

test('confirmed rollback allows new attempt; malformed or thrown driver outcomes remain uncertain and block',async()=>{
  for(const mode of ['uncertain','malformed','throw'] as const){
    const f=await fixture();try {
      const first=await run(f,{execute:async()=> 'rolled_back'});
      assert.equal(first.status,'rolled_back');
      let calls=0;
      const driver:AppRestrictedMigrationDriver={execute:async()=>{calls++;if(mode==='throw')throw Error('password=secret');return mode==='malformed' ? {} as 'applied' : 'uncertain';}};
      const result=await run(f,driver);assert.equal(result.status,'uncertain');assert.equal(calls,1);
      await assert.rejects(run(f,driver),/MIGRATION_ATTEMPT_BLOCKED/);assert.equal(calls,1);
      const history=await f.ledger.listHistory(admin,f.appId);assert.deepEqual(history.map(a=>a.status),['rolled_back','uncertain']);
      assert.notEqual(history[0].id,history[1].id);assert.equal(JSON.stringify(history).includes('secret'),false);
    }finally{await f.db.close();}
  }
});

test('reservation metadata mismatch and late registry revision changes are recorded rolled back without driver',async()=>{
  for(const mode of ['mismatch','revision','retained'] as const){
    const f=await fixture();try {
      const ledger={finish:f.ledger.finish.bind(f.ledger),beginNext:async(context:PlatformPersonActorContext,id:string,revision:number)=>{
        const attempt=await f.ledger.beginNext(context,id,revision);assert.ok(attempt);
        if(mode==='revision')await f.registry.setEnabled(admin,id,revision,true);
        if(mode==='retained')await f.storage.preserve(admin,id);
        return mode==='mismatch' ? {...attempt,artifactSha256:'f'.repeat(64)} : attempt;
      }};
      let calls=0;
      const executor=new AppMigrationExecutor(f.registry,f.planner,f.storage,ledger,{execute:async()=>{calls++;return 'applied';}});
      await assert.rejects(executor.executeNext(admin,f.appId,1),mode==='mismatch'? /MIGRATION_RESERVATION_MISMATCH/ : mode==='revision'? /STALE_REVISION/:/STORAGE_RETAINED/);
      assert.equal(calls,0);assert.equal((await f.ledger.listHistory(admin,f.appId))[0].status,'rolled_back');
    }finally{await f.db.close();}
  }
});

test('reported commit with failed result persistence never reports success and running blocks all replay',async()=>{
  const f=await fixture();try {
    let calls=0;
    const driver:AppRestrictedMigrationDriver={execute:async()=>{calls++;f.failFinish();return 'applied';}};
    await assert.rejects(run(f,driver),(error:unknown)=>{
      assert.ok(error instanceof Error);assert.equal(error.message,'MIGRATION_RECONCILIATION_REQUIRED');
      assert.match((error as Error & {attemptId:string}).attemptId,/^[0-9a-f-]{36}$/);return true;
    });
    assert.equal((await f.ledger.listHistory(admin,f.appId))[0].status,'running');
    await assert.rejects(run(f,driver),/MIGRATION_ATTEMPT_BLOCKED/);assert.equal(calls,1);
  }finally{await f.db.close();}
});

test('authorization revoked after reservation blocks execution and preserves a reconciliation-required attempt',async()=>{
  const f=await fixture();try {
    let revoked=false, calls=0;
    const context:PlatformPersonActorContext={...admin,authorize:async permission=>{
      const decision=await admin.authorize(permission);
      return {...decision,allowed:!revoked};
    }};
    const ledger={finish:f.ledger.finish.bind(f.ledger),beginNext:async(...args:Parameters<AppMigrationLedger['beginNext']>)=>{
      const attempt=await f.ledger.beginNext(...args);revoked=true;return attempt;
    }};
    const executor=new AppMigrationExecutor(f.registry,f.planner,f.storage,ledger,{execute:async()=>{calls++;return 'applied';}});
    await assert.rejects(executor.executeNext(context,f.appId,1),/MIGRATION_RECONCILIATION_REQUIRED/);
    assert.equal(calls,0);
    assert.equal((await f.ledger.listHistory(admin,f.appId))[0].status,'running');
    await assert.rejects(run(f,{execute:async()=>{calls++;return 'applied';}}),/MIGRATION_ATTEMPT_BLOCKED/);
    assert.equal(calls,0);
  }finally{await f.db.close();}
});
