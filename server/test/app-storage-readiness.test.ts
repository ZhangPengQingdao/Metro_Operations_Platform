import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedAppStorageService } from '../src/app-platform/storage/managed-storage.ts';
import type { ManagedAppOperations, ManagedAppLockedScope } from '../src/app-platform/storage/managed-operations.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';

// Composition checks; isolated PostgreSQL integration owns ACL, lock and lease evidence.
function fixture() {
  const calls: string[] = [];
  const row = { status:'applied',ordinal:0,manifest_digest:'a'.repeat(64),migration_id:'initial',artifact_id:'migration',artifact_path:'initial.json',artifact_sha256:'b'.repeat(64),artifact_bytes:10 };
  const state = { rows:[{...row}], stale:false, retained:false };
  const binding = { mode:'managed' as const, installationId:'44000000-0000-4000-8000-000000000001', appId:'demo', schema:'app_demo',ownerRole:'owner',runtimeRole:'runtime',manifestDigest:row.manifest_digest };
  const scope = {
    binding,
    storage:{assertReady:async()=>{calls.push('storage');if(state.retained)throw Error('STORAGE_RETAINED');return binding;}},
    registry:{get:async()=>({manifest:{storage:{mode:'managed',migrations:[{id:'initial',artifactId:'migration'}]},artifacts:[{id:'migration',path:row.artifact_path,sha256:row.artifact_sha256,bytes:row.artifact_bytes}]}})},
    client:{query:async(sql:string)=>{if(sql.includes('platform_app_storage_restores'))return {rows:[]};if(sql.includes('migration_adoptions'))return {rows:[]};calls.push('ledger');return {rows:state.rows};}},
    revalidate:async()=>{calls.push('revalidate');if(state.stale)throw Error('STALE_REVISION');},
    withOwner:async()=>{throw Error('OWNER_MUST_NOT_BE_ISSUED');},
  } as unknown as ManagedAppLockedScope;
  const operations = {withLock:async(_context:unknown,appId:string,revision:number,work:(scope:ManagedAppLockedScope)=>Promise<unknown>)=>{
    assert.equal(appId,'demo');assert.equal(revision,7);calls.push('lock');
    try{return await work(scope);}finally{calls.push('unlock');}
  }} as unknown as ManagedAppOperations;
  const service = new ManagedAppStorageService(operations,{read:async()=>{throw Error('ARTIFACT_MUST_NOT_BE_READ');}});
  const check=()=>service.assertReady({} as PlatformActorContext,'demo',7);
  return {calls,row,state,binding,check};
}
test('storage readiness reuses lock, physical storage and exact ledger then revalidates',async()=>{
  const f=fixture();const result=await f.check();
  assert.deepEqual(result,{binding:f.binding,revision:7});
  assert.ok(Object.isFrozen(result.binding));
  assert.deepEqual(f.calls,['lock','storage','ledger','revalidate','unlock']);
});
test('incomplete and uncertain migrations block readiness',async()=>{
  for(const status of ['running','uncertain']){const f=fixture();f.state.rows[0].status=status;await assert.rejects(f.check(),/MIGRATION_ATTEMPT_BLOCKED/);}
  const f=fixture();f.state.rows=[];await assert.rejects(f.check(),/MIGRATIONS_NOT_COMPLETE/);
});
test('migration identity, bytes and manifest must match exactly',async()=>{
  for(const key of ['manifest_digest','migration_id','artifact_id','artifact_path','artifact_sha256'] as const){
    const f=fixture();f.state.rows[0][key]='different';await assert.rejects(f.check(),/MIGRATION_LEDGER_CONFLICT/);
  }
  const f=fixture();f.state.rows[0].artifact_bytes++;await assert.rejects(f.check(),/MIGRATION_LEDGER_CONFLICT/);
});
test('retained storage and final revision change never return a ready result',async()=>{
  const a=fixture();a.state.retained=true;await assert.rejects(a.check(),/STORAGE_RETAINED/);assert.deepEqual(a.calls,['lock','storage','unlock']);
  const b=fixture();b.state.stale=true;await assert.rejects(b.check(),/STALE_REVISION/);assert.equal(b.calls.at(-1),'unlock');
});
