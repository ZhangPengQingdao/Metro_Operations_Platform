import {z} from 'zod';
import type {LocationDirectoryRepository} from '../../platform/locations/index.js';
import type {AssetDirectoryRepository} from '../../platform/assets/index.js';
import {GatewayError,type AppGatewayOperation} from './model.js';

const input=z.object({id:z.string().uuid()}).strict();
export const locationListInput=z.object({afterId:z.string().uuid().optional(),pageSize:z.number().int().min(1).max(50).default(20),search:z.string().max(100).optional(),status:z.enum(['active','inactive']).optional(),organizationUnitId:z.string().uuid().optional()}).strict();
export const assetListInput=z.object({afterId:z.string().uuid().optional(),pageSize:z.number().int().min(1).max(50).default(20),search:z.string().max(100).optional(),lifecycleState:z.enum(['planned','active','suspended','retired']).optional(),organizationUnitId:z.string().uuid().optional(),locationId:z.string().uuid().optional(),typeId:z.string().uuid().optional()}).strict();
const locationResult=z.object({id:z.string().uuid(),code:z.string(),name:z.string(),locationType:z.string(),status:z.string(),organizationUnitId:z.string().uuid().nullable()}).strict();
const assetResult=z.object({id:z.string().uuid(),displayName:z.string(),assetCode:z.string().nullable(),locationId:z.string().uuid(),typeId:z.string().uuid(),lifecycleState:z.string(),organizationUnitId:z.string().uuid().nullable()}).strict();
const locationScope=(row:z.infer<typeof locationResult>)=>({organizationUnitId:row.organizationUnitId,targets:[{type:'location' as const,id:row.id}]});
const assetScope=(row:z.infer<typeof assetResult>)=>({organizationUnitId:row.organizationUnitId,targets:[{type:'asset' as const,id:row.id},{type:'location' as const,id:row.locationId},{type:'asset_type' as const,id:row.typeId}]});

/** Directory fields are whitelisted; list scopes must pass authorization before querying. */
export function createDirectoryGatewayOperations(options:{
 locations:Pick<LocationDirectoryRepository,'findLocationById'>;
 assets:Pick<AssetDirectoryRepository,'findAssetById'>;
 listLocations?:(input:z.infer<typeof locationListInput>)=>Promise<z.infer<typeof locationResult>[]>;
 listAssets?:(input:z.infer<typeof assetListInput>)=>Promise<z.infer<typeof assetResult>[]>;
}):AppGatewayOperation[]{
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
 const pageResult=z.object({organizationUnitId:z.string().uuid().nullable(),rows:z.array(locationResult).max(50),nextCursor:z.string().uuid().nullable()}).strict();
 const assetPageResult=z.object({organizationUnitId:z.string().uuid().nullable(),rows:z.array(assetResult).max(50),nextCursor:z.string().uuid().nullable()}).strict();
 const listScope=(value:unknown)=>{const p=locationListInput.parse(value);return p.organizationUnitId?{organizationUnitId:p.organizationUnitId}:{};};
 const assetListScope=(value:unknown)=>{const p=assetListInput.parse(value);return p.organizationUnitId?{organizationUnitId:p.organizationUnitId}:{};};
 const locationList=async(value:unknown)=>{
  const p=locationListInput.parse(value),rows=await options.listLocations!(p);
  if(rows.length>p.pageSize+1||rows.some(row=>p.organizationUnitId&&row.organizationUnitId!==p.organizationUnitId))throw new GatewayError('INVALID_RESULT',502);
  const page=rows.slice(0,p.pageSize);return {organizationUnitId:p.organizationUnitId??null,rows:page,nextCursor:rows.length>p.pageSize?page.at(-1)!.id:null};
 };
 const assetList=async(value:unknown)=>{
  const p=assetListInput.parse(value),rows=await options.listAssets!(p);
  if(rows.length>p.pageSize+1||rows.some(row=>p.organizationUnitId&&row.organizationUnitId!==p.organizationUnitId))throw new GatewayError('INVALID_RESULT',502);
  const page=rows.slice(0,p.pageSize);return {organizationUnitId:p.organizationUnitId??null,rows:page,nextCursor:rows.length>p.pageSize?page.at(-1)!.id:null};
 };
 return [
  {name:'platform.locations.get',permissionCode:'platform.locations.read',mode:'read',validateParams:v=>input.safeParse(v).success,
   resolveResources:async(_c,v)=>[locationScope(await location(v))],execute:async(_c,v)=>location(v),validateResult:v=>locationResult.safeParse(v).success,
   resolveResultResources:async(_c,v)=>[locationScope(locationResult.parse(v))]},
  {name:'platform.assets.get',permissionCode:'platform.assets.read',mode:'read',validateParams:v=>input.safeParse(v).success,
   resolveResources:async(_c,v)=>[assetScope(await asset(v))],execute:async(_c,v)=>asset(v),validateResult:v=>assetResult.safeParse(v).success,
   resolveResultResources:async(_c,v)=>[assetScope(assetResult.parse(v))]},
  ...(options.listLocations?[{name:'platform.locations.list',permissionCode:'platform.locations.read',mode:'read' as const,validateParams:(v:unknown)=>locationListInput.safeParse(v).success,
   resolveResources:async(_c:unknown,v:unknown)=>[listScope(v)],execute:async(_c:unknown,v:unknown)=>locationList(v),validateResult:(v:unknown)=>pageResult.safeParse(v).success,
   resolveResultResources:async(_c:unknown,v:unknown)=>{const page=pageResult.parse(v);return [page.organizationUnitId?{organizationUnitId:page.organizationUnitId}:{},...page.rows.map(locationScope)];}}]:[]),
  ...(options.listAssets?[{name:'platform.assets.list',permissionCode:'platform.assets.read',mode:'read' as const,validateParams:(v:unknown)=>assetListInput.safeParse(v).success,
   resolveResources:async(_c:unknown,v:unknown)=>[assetListScope(v)],execute:async(_c:unknown,v:unknown)=>assetList(v),validateResult:(v:unknown)=>assetPageResult.safeParse(v).success,
   resolveResultResources:async(_c:unknown,v:unknown)=>{const page=assetPageResult.parse(v);return [page.organizationUnitId?{organizationUnitId:page.organizationUnitId}:{},...page.rows.map(assetScope)];}}]:[]),
 ];
}
