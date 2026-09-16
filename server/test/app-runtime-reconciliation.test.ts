import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRuntimeWrite} from '../src/app-platform/storage/runtime-reconciliation.ts';
import type {PlatformManagementContext} from '../src/platform/context/index.ts';
import type {ManagedAppStorage} from '../src/app-platform/storage/binding.ts';
const requestId='55000000-0000-4000-8000-000000000001';
function fixture(){
 const state={receipt:true,quiet:true,system:'system-1',oid:'42',database:'app-test',digest:'request-digest',outcome:'committed' as string|null,writes:0,permission:true};
 const context={actorType:'administrator',administrator:{id:requestId},execution:{type:'platform'},authorize:async()=>({allowed:state.permission})} as unknown as PlatformManagementContext;
 const client={async query(sql:string){
  if(sql.includes('SELECT status,manifest_digest'))return {rows:[{status:'dispatched',manifest_digest:'manifest-digest',request_digest:'request-digest'}]};
  if(sql.includes('AS quiet'))return {rows:[{quiet:state.quiet}]};
  if(sql.includes('SELECT * FROM public.platform_app_runtime_write_receipts'))return {rows:state.receipt?[{transaction_id:'123',system_identifier:state.system,database_oid:state.oid,database_name:state.database,manifest_digest:'manifest-digest',request_digest:state.digest}]:[]};
  if(sql.includes('FROM pg_control_system()'))return {rows:[{system:'system-1',oid:'42',database:'app-test'}]};
  if(sql.includes('pg_xact_status'))return {rows:[{status:state.outcome}]};
  if(sql.startsWith('INSERT')||sql.startsWith('UPDATE'))state.writes++;
  return {rows:[]};
 }};
 const plan={installationId:requestId,runtimeRole:'app_test_runtime'} as ManagedAppStorage;
 return {state,run:()=>reconcileRuntimeWrite(client,context,plan,requestId)};
}
test('runtime reconciliation refuses absent, mismatched, live and expired original evidence without modifying records',async()=>{
 for(const patch of [{receipt:false},{quiet:false},{system:'other'},{oid:'99'},{database:'restored'},{digest:'tampered'},{outcome:null},{outcome:'in progress'},{outcome:'unknown'},{permission:false}]){
  const f=fixture();Object.assign(f.state,patch);await assert.rejects(f.run());assert.equal(f.state.writes,0);
 }
});
test('runtime reconciliation persists a separate decision only for positive commit or abort evidence',async()=>{
 for(const [outcome,status] of [['committed','completed'],['aborted','rolled_back']]){
  const f=fixture();f.state.outcome=outcome;assert.equal((await f.run()).status,status);assert.equal(f.state.writes,2);
 }
});
