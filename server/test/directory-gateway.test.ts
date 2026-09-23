import test from 'node:test';
import assert from 'node:assert/strict';
import {AppGateway} from '../src/app-platform/gateway/gateway.ts';
import {createDirectoryGatewayOperations} from '../src/app-platform/gateway/directory.ts';
import type {PlatformActorContextResolver,PlatformActorContext} from '../src/platform/context/index.ts';
import type {Location} from '../src/platform/locations/index.ts';
import type {Asset} from '../src/platform/assets/index.ts';
const one='52000000-0000-4000-8000-000000000001',two='52000000-0000-4000-8000-000000000002',assetId='52000000-0000-4000-8000-000000000003',typeId='52000000-0000-4000-8000-000000000004';
function fixture(){
 const state={assetReads:0,locationId:one,moveDuringResult:false,allowed:true,identityCalls:0};
 const operations=createDirectoryGatewayOperations({locations:{findLocationById:async id=>({id,code:'station',name:'Station',organizationUnitId:null,locationType:'station',status:'active',privateField:'secret'} as unknown as Location)},
 assets:{findAssetById:async()=>{state.assetReads++;return {id:assetId,displayName:'Device',assetCode:'D1',locationId:state.moveDuringResult&&state.assetReads===2?two:state.locationId,typeId,lifecycleState:'active',remark:'private'} as Asset;}}});
 const authorize=async(_permission:string,resource?:{targets?:readonly {id:string}[]})=>({allowed:state.allowed&&!resource?.targets?.some(t=>t.id===two)});
 const contextResolver={resolve:async()=>({actorType:'person',person:{id:one},execution:{type:'application',appId:'reader'},authorize})} as unknown as Pick<PlatformActorContextResolver,'resolve'>;
 const gateway=new AppGateway({registry:{authenticateServiceCredential:async()=>{throw Error('not used');}},contextResolver,operations});
 const request={version:'1.0',operation:'platform.assets.get',params:{id:assetId}};
 return {state,gateway,request,operations,call:()=>gateway.invokeDelegated('reader',{source:'session',userId:one},request)};
}
test('actual asset result uses a field whitelist and its real location scope',async()=>{
 const f=fixture();const response=await f.call();assert.deepEqual(Object.keys(response.result as object).sort(),['assetCode','displayName','id','lifecycleState','locationId','organizationUnitId','typeId']);
 f.state.locationId=two;await assert.rejects(f.call(),/ACCESS_DENIED/);
});
test('result from an unauthorized intermediate location is denied even if current location moved back',async()=>{
 const f=fixture();f.state.moveDuringResult=true;await assert.rejects(f.call(),/ACCESS_DENIED/);assert.equal(f.state.assetReads,3);
});
test('session revocation and identity replacement during a call never deliver a result',async()=>{
 for(const mode of ['revoked','changed']){
  const f=fixture();await assert.rejects(f.gateway.invokeDelegatedFromSession('reader',async()=>{
   f.state.identityCalls++;
   // Revoke after the actual asset read, independently of checkpoint implementation count.
   if(f.state.assetReads>=2){if(mode==='revoked')throw Error('session gone');return {source:'session',userId:two};}
   return {source:'session',userId:one};
  },f.request));assert.ok(f.state.assetReads>=2);
 }
});
test('directory parameters reject scope spoofing and missing records before execution',async()=>{
 const f=fixture();for(const params of [{},{id:'no'},{id:assetId,scope:'all'},{id:assetId,actor:one}])await assert.rejects(f.gateway.invokeDelegated('reader',{source:'session',userId:one},{...f.request,params}),/INVALID_PARAMS/);
 assert.equal(f.state.assetReads,0);
 const [operation]=createDirectoryGatewayOperations({locations:{findLocationById:async()=>null},assets:{findAssetById:async()=>null}});
 await assert.rejects(operation.resolveResources({} as PlatformActorContext,{id:one}),/ACCESS_DENIED/);
});

test('platform.assets.list validates params, checks scopes, paginates and rejects unauthorized row targets',async()=>{
 const listAssets=async(p:{afterId?:string;pageSize:number;organizationUnitId?:string})=>{
  const all=[
   {id:assetId,displayName:'Asset 1',assetCode:'A1',locationId:one,typeId,lifecycleState:'active',organizationUnitId:p.organizationUnitId??one},
   {id:'52000000-0000-4000-8000-000000000005',displayName:'Asset 2',assetCode:'A2',locationId:two,typeId,lifecycleState:'active',organizationUnitId:p.organizationUnitId??one}
  ];
  return all.filter(r=>!p.afterId||r.id>p.afterId).slice(0,p.pageSize+1);
 };
 const operations=createDirectoryGatewayOperations({
  locations:{findLocationById:async id=>({id,code:'station',name:'Station',organizationUnitId:null,locationType:'station',status:'active'} as unknown as Location)},
  assets:{findAssetById:async()=>null},
  listAssets
 });
 const authorize=async(_permission:string,resource?:{targets?:readonly {id:string}[]})=>({
  allowed:!resource?.targets?.some(t=>t.id===two)
 });
 const contextResolver={resolve:async()=>({actorType:'person',person:{id:one},execution:{type:'application',appId:'reader'},authorize})} as unknown as Pick<PlatformActorContextResolver,'resolve'>;
 const gateway=new AppGateway({registry:{authenticateServiceCredential:async()=>{throw Error('not used');}},contextResolver,operations});

 // 1. Param validation
 for(const invalid of [{pageSize:0},{pageSize:51},{afterId:'not-a-uuid'},{search:'a'.repeat(101)},{lifecycleState:'invalid'},{unknown:true}]) {
  await assert.rejects(gateway.invokeDelegated('reader',{source:'session',userId:one},{version:'1.0',operation:'platform.assets.list',params:invalid}),/INVALID_PARAMS/);
 }

 // 2. Keyset pagination with page size 1
 const page1=await gateway.invokeDelegated('reader',{source:'session',userId:one},{version:'1.0',operation:'platform.assets.list',params:{pageSize:1}});
 assert.equal((page1.result as {rows:unknown[]}).rows.length,1);
 assert.equal((page1.result as {nextCursor:string}).nextCursor,assetId);

 // 3. Next page returns second asset, which has locationId=two (unauthorized target) -> ACCESS_DENIED
 await assert.rejects(gateway.invokeDelegated('reader',{source:'session',userId:one},{version:'1.0',operation:'platform.assets.list',params:{pageSize:1,afterId:assetId}}),/ACCESS_DENIED/);

 // 4. Provider returning mismatched organizationUnitId throws INVALID_RESULT (502)
 const badProviderOps=createDirectoryGatewayOperations({
  locations:{findLocationById:async()=>null},assets:{findAssetById:async()=>null},
  listAssets:async()=>[{id:assetId,displayName:'Asset 1',assetCode:'A1',locationId:one,typeId,lifecycleState:'active',organizationUnitId:two}]
 });
 const badGateway=new AppGateway({registry:{authenticateServiceCredential:async()=>{throw Error('not used');}},contextResolver:{resolve:async()=>({actorType:'person',person:{id:one},execution:{type:'application',appId:'reader'},authorize:async()=>({allowed:true})})} as unknown as Pick<PlatformActorContextResolver,'resolve'>,operations:badProviderOps});
 await assert.rejects(badGateway.invokeDelegated('reader',{source:'session',userId:one},{version:'1.0',operation:'platform.assets.list',params:{organizationUnitId:one}}),/INVALID_RESULT/);
});
