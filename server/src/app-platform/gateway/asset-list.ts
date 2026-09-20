import type {QueryableClient} from '../../core/database/index.js';
import {assetListInput} from './directory.js';

/** Keyset pagination with organization unit join. Literal substring search without wildcard ambiguity. */
export function createAssetListReader(client:QueryableClient){
 return async(value:unknown)=>{
  const p=assetListInput.parse(value);
  const result=await client.query(`SELECT a.id, a.display_name AS "displayName", a.asset_code AS "assetCode",
    a.location_id AS "locationId", a.type_id AS "typeId", a.lifecycle_state AS "lifecycleState",
    l.organization_unit_id AS "organizationUnitId"
    FROM platform_assets a
    JOIN platform_locations l ON l.id = a.location_id
    WHERE ($1::uuid IS NULL OR a.id > $1::uuid)
      AND ($2::uuid IS NULL OR l.organization_unit_id = $2::uuid)
      AND ($3::text IS NULL OR a.lifecycle_state = $3)
      AND ($4::text IS NULL OR strpos(lower(coalesce(a.asset_code, '') || ' ' || a.display_name), lower($4)) > 0)
      AND ($5::uuid IS NULL OR a.location_id = $5::uuid)
      AND ($6::uuid IS NULL OR a.type_id = $6::uuid)
    ORDER BY a.id LIMIT $7`,
   [p.afterId ?? null, p.organizationUnitId ?? null, p.lifecycleState ?? null, p.search ?? null, p.locationId ?? null, p.typeId ?? null, p.pageSize + 1]);
  return (result as {rows:unknown[]}).rows as {id:string;displayName:string;assetCode:string|null;locationId:string;typeId:string;lifecycleState:string;organizationUnitId:string|null}[];
 };
}
