import {z} from 'zod';
import type {LocationDirectoryRepository} from '../../platform/locations/index.js';
import type {AssetDirectoryRepository} from '../../platform/assets/index.js';
import {GatewayError,type AppGatewayOperation} from './model.js';

const input=z.object({id:z.string().uuid()}).strict();
const locationResult=z.object({id:z.string().uuid(),code:z.string(),name:z.string(),locationType:z.string(),status:z.string(),organizationUnitId:z.string().uuid().nullable()}).strict();
const assetResult=z.object({id:z.string().uuid(),displayName:z.string(),assetCode:z.string().nullable(),locationId:z.string().uuid(),typeId:z.string().uuid(),lifecycleState:z.string(),organizationUnitId:z.string().uuid().nullable()}).strict();
const locationScope=(row:z.infer<typeof locationResult>)=>({organizationUnitId:row.organizationUnitId,targets:[{type:'location' as const,id:row.id}]});
const assetScope=(row:z.infer<typeof assetResult>)=>({organizationUnitId:row.organizationUnitId,targets:[{type:'asset' as const,id:row.id},{type:'location' as const,id:row.locationId},{type:'asset_type' as const,id:row.typeId}]});

/** Bounded by-ID operations only. No caller-provided scope or unrestricted directory dump. */
export function createDirectoryGatewayOperations(options:{locations:Pick<LocationDirectoryRepository,'findLocationById'>;assets:Pick<AssetDirectoryRepository,'findAssetById'>}):AppGatewayOperation[]{
 const location=async(value:unknown)=>{
  const row=await options.locations.findLocationById(input.parse(value).id);
  if(!row)throw new GatewayError('ACCESS_DENIED',403);
  return {id:row.id,code:row.code,name:row.name,locationType:row.locationType,status:row.status,organizationUnitId:row.organizationUnitId};
 };
 const asset=async(value:unknown)=>{
  const row=await options.assets.findAssetById(input.parse(value).id);
  const place=row?await options.locations.findLocationById(row.locationId):null;
  if(!row||!place)throw new GatewayError('ACCESS_DENIED',403);
  return {id:row.id,displayName:row.displayName,assetCode:row.assetCode,locationId:row.locationId,typeId:row.typeId,lifecycleState:row.lifecycleState,organizationUnitId:place.organizationUnitId};
 };
 return [
  {name:'platform.locations.get',permissionCode:'platform.locations.read',mode:'read',validateParams:v=>input.safeParse(v).success,
   resolveResources:async(_c,v)=>[locationScope(await location(v))],execute:async(_c,v)=>location(v),validateResult:v=>locationResult.safeParse(v).success,
   resolveResultResources:async(_c,v)=>[locationScope(locationResult.parse(v))]},
  {name:'platform.assets.get',permissionCode:'platform.assets.read',mode:'read',validateParams:v=>input.safeParse(v).success,
   resolveResources:async(_c,v)=>[assetScope(await asset(v))],execute:async(_c,v)=>asset(v),validateResult:v=>assetResult.safeParse(v).success,
   resolveResultResources:async(_c,v)=>[assetScope(assetResult.parse(v))]},
 ];
}
