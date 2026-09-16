import type {QueryableClient} from '../../core/database/index.js';
import {locationListInput} from './directory.js';
/** Parameterized keyset query. Literal substring search, no totals or hidden-row cursor. */
export function createLocationListReader(client:QueryableClient){
 return async(value:unknown)=>{
  const p=locationListInput.parse(value);
  const result=await client.query(`SELECT id,code,name,location_type AS "locationType",status,organization_unit_id AS "organizationUnitId"
   FROM platform_locations
   WHERE ($1::uuid IS NULL OR id>$1::uuid)
    AND ($2::uuid IS NULL OR organization_unit_id=$2::uuid)
    AND ($3::text IS NULL OR status=$3)
    AND ($4::text IS NULL OR strpos(lower(code || ' ' || name),lower($4))>0)
   ORDER BY id LIMIT $5`,[p.afterId??null,p.organizationUnitId??null,p.status??null,p.search??null,p.pageSize+1]);
  return (result as {rows:unknown[]}).rows as {id:string;code:string;name:string;locationType:string;status:string;organizationUnitId:string|null}[];
 };
}
