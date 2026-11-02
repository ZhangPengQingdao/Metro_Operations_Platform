import {requireDeveloperAccount} from './keys.js';
import {z} from 'zod';
import type {QueryableClient} from '../../core/database/index.js';
import {GatewayError,type AppGatewayOperation} from '../gateway/model.js';

export const PUBLIC_DIRECTORIES = [
 {id:'lines',title:'线路'}, {id:'stations',title:'车站'}, {id:'line-stations',title:'线路与车站关系'},
 {id:'organizations',title:'组织与工班'}, {id:'workgroup-stations',title:'工班管辖车站'}, {id:'positions',title:'岗位'},
 {id:'asset-systems',title:'设备系统'}, {id:'asset-categories',title:'设备类别'}, {id:'asset-types',title:'设备类型'},
] as const;
export const directoryQuery=z.object({resource:z.enum(['lines','stations','line-stations','organizations','workgroup-stations','positions','asset-systems','asset-categories','asset-types']),search:z.string().trim().max(100).default(''),afterId:z.string().uuid().optional(),pageSize:z.coerce.number().int().min(1).max(100).default(50)}).strict();
/** Explicit public projections: never expose people, assets, network fields or arbitrary dictionaries. */
const sources:Record<z.infer<typeof directoryQuery>['resource'],string>={
 lines:`SELECT id,code,name,short_name AS "shortName",line_number AS "lineNumber",sort_order AS "sortOrder" FROM platform_lines WHERE status='active'`,
 stations:`SELECT id,code,name,short_name AS "shortName",sort_order AS "sortOrder" FROM platform_locations WHERE status='active' AND location_type='station'`,
 'line-stations':`SELECT r.id,r.line_id AS "lineId",r.station_id AS "stationId",r.station_number AS "stationNumber",r.sort_order AS "sortOrder",s.name,l.name AS "lineName" FROM platform_line_stations r JOIN platform_lines l ON l.id=r.line_id JOIN platform_locations s ON s.id=r.station_id WHERE r.status='active' AND l.status='active' AND s.status='active' AND s.location_type='station'`,
 organizations:`SELECT id,code,name,short_name AS "shortName",parent_id AS "parentId",unit_type AS "unitType",sort_order AS "sortOrder" FROM platform_organization_units WHERE status='active'`,
 'workgroup-stations':`WITH RECURSIVE ancestry AS (SELECT id AS station_id,id AS ancestor_id,parent_id,0 AS depth FROM platform_locations WHERE status='active' AND location_type='station' UNION ALL SELECT a.station_id,p.id,p.parent_id,a.depth+1 FROM ancestry a JOIN platform_locations p ON p.id=a.parent_id WHERE p.status='active' AND a.depth<32)
 SELECT s.id,s.name,COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id',o.id,'name',o.name)) FROM ancestry a JOIN platform_responsibility_scopes r ON r.location_id=a.ancestor_id JOIN platform_organization_units o ON o.id=r.organization_unit_id WHERE a.station_id=s.id AND (a.ancestor_id=s.id OR r.include_descendants) AND r.status='active' AND o.status='active' AND o.unit_type='workgroup'),'[]'::jsonb) AS workgroups FROM platform_locations s WHERE s.status='active' AND s.location_type='station'`,
 positions:`SELECT id,code,name FROM platform_positions WHERE status='active'`,
 'asset-systems':`SELECT id,code,name,sort_order AS "sortOrder" FROM platform_asset_systems WHERE status='active'`,
 'asset-categories':`SELECT c.id,c.code,c.name,c.system_id AS "systemId",c.sort_order AS "sortOrder" FROM platform_asset_categories c JOIN platform_asset_systems s ON s.id=c.system_id WHERE c.status='active' AND s.status='active'`,
 'asset-types':`SELECT t.id,t.code,t.name,t.system_id AS "systemId",t.category_id AS "categoryId",t.sort_order AS "sortOrder" FROM platform_asset_types t JOIN platform_asset_systems s ON s.id=t.system_id LEFT JOIN platform_asset_categories c ON c.id=t.category_id WHERE t.status='active' AND s.status='active' AND (t.category_id IS NULL OR c.status='active')`,
};
export async function readPublicDirectory(db:QueryableClient,value:unknown){
 const p=directoryQuery.parse(value);
 const {rows}=await db.query(`SELECT * FROM (${sources[p.resource]}) directory WHERE ($1='' OR strpos(lower(row_to_json(directory)::text),lower($1))>0) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[p.search,p.afterId??null,p.pageSize+1]) as {rows:({id:string}&Record<string,unknown>)[]};
 const page=rows.slice(0,p.pageSize);return {rows:page,nextCursor:rows.length>p.pageSize?page.at(-1)!.id:null};
}
export function publicDirectoryOperation(db:QueryableClient):AppGatewayOperation {
 return {name:'platform.directory.list',permissionCode:'platform.directory.read',mode:'read',validateParams:v=>directoryQuery.safeParse(v).success,
  resolveResources:async c=>{if(!c.employeeActor)throw new GatewayError('ACCESS_DENIED',403);await requireDeveloperAccount(db,c.employeeActor.person.id);return [{}];},
  execute:async(_c,v)=>readPublicDirectory(db,v),validateResult:()=>true,auditMetadata:v=>({resource:directoryQuery.parse(v).resource})};
}
