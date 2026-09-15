import test from 'node:test';
import assert from 'node:assert/strict';
import {AppRuntimeDataService} from '../src/app-platform/storage/runtime-data.ts';
import type {PlatformActorContext} from '../src/platform/context/index.ts';
const id='54000000-0000-4000-8000-000000000001';
function fixture(){
 let connections=0;
 const service=new AppRuntimeDataService({endpoint:{host:'127.0.0.1',port:5432,database:'test',ssl:false},connectAdmin:async()=>{connections++;throw Error('private');},findInstallation:async()=>null});
 const actor={actorType:'service',execution:{type:'service',appId:'example',serviceIdentityId:id},authorize:async()=>({allowed:true})} as PlatformActorContext;
 return {service,actor,connections:()=>connections};
}
test('runtime storage validates bounded row intent without accepting SQL, schema, keys or arbitrary scope',()=>{
 const [get,write]=fixture().service.operations();
 assert.equal(get.name,'platform.app_data.get');assert.equal(write.permissionCode,'platform.app_data.write');
 assert.ok(get.validateParams({table:'records',id}));
 for(const input of [{table:'public.records',id},{table:'records',id,schema:'public'},{table:'records',id,actor:{}},{table:'records',id:'1'},{table:'pg_class',id}])assert.equal(get.validateParams(input),false);
 assert.ok(write.validateParams({table:'records',id,requestId:id,action:'insert',values:{value:'a'}}));
 for(const input of [
  {table:'records',id,action:'insert',values:{value:'a'}},
  {table:'records',id,requestId:id,action:'update',values:{}},
  {table:'records',id,requestId:id,action:'update',values:{id}},
  {table:'records',id,requestId:id,action:'delete',values:{value:'a'}},
  {table:'records',id,requestId:id,action:'insert',values:{value:'x'.repeat(17000)}},
 ])assert.equal(write.validateParams(input),false);
});
test('employee, platform, revoked service and cancelled calls never open privileged storage sessions',async()=>{
 const f=fixture(),signal=new AbortController().signal;
 for(const actor of [{...f.actor,actorType:'person'},{...f.actor,actorType:'administrator'},{...f.actor,execution:{type:'platform'}}]){
  await assert.rejects(f.service.execute(actor as PlatformActorContext,{table:'records',id},false,signal),/ACCESS_DENIED/);
  await assert.rejects(f.service.operations()[0].resolveResources(actor as PlatformActorContext,{}),/ACCESS_DENIED/);
 }
 await assert.rejects(f.service.execute({...f.actor,authorize:async()=>({allowed:false})} as PlatformActorContext,{table:'records',id},false,signal),/ACCESS_DENIED/);
 const abort=new AbortController();abort.abort();await assert.rejects(f.service.execute(f.actor,{table:'records',id},false,abort.signal),/ABORTED/);
 assert.equal(f.connections(),0);
});
test('storage connection errors are sanitized and do not initiate retries',async()=>{
 const f=fixture();await assert.rejects(f.service.execute(f.actor,{table:'records',id},false,new AbortController().signal),error=>{
  assert.equal((error as Error).message,'STORAGE_OPERATION_FAILED');return true;
 });assert.equal(f.connections(),1);
});

test('SDK preserves caller write intent and never retries an unknown result',async()=>{
 const {createAppDataClient,createAppGatewayClient,AppGatewayClientError}=await import('@metro/platform-sdk/app-gateway');
 const requests:unknown[]=[];
 const client=createAppDataClient(createAppGatewayClient(async request=>{
  requests.push(request);return {version:'1.0',error:{code:'STORAGE_WRITE_UNCERTAIN',writeOutcome:'unknown'}};
 }));
 await assert.rejects(client.insert('entries',id,id,{value:{note:'test'}}),error=>error instanceof AppGatewayClientError&&error.writeOutcome==='unknown');
 assert.equal(requests.length,1);
 assert.equal(JSON.stringify(requests[0]),JSON.stringify({version:'1.0',operation:'platform.app_data.write',params:{table:'entries',id,requestId:id,action:'insert',values:{value:{note:'test'}}}}));
});
