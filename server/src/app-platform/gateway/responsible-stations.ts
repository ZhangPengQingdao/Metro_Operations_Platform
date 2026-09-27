import type {QueryableClient} from '../../core/database/index.js';

/** Active stations assigned to a workgroup through platform responsibility scopes. */
export function createResponsibleStationReader(client:QueryableClient){
 const base=`WITH RECURSIVE ancestors AS (
   SELECT id AS station_id,id AS ancestor_id,parent_id,0 AS depth FROM platform_locations
   WHERE location_type='station' AND status='active'
   UNION ALL
   SELECT ancestors.station_id,parent.id,parent.parent_id,ancestors.depth+1
   FROM ancestors JOIN platform_locations parent ON parent.id=ancestors.parent_id
   WHERE parent.status='active' AND ancestors.depth<32
  ), responsible AS (
   SELECT DISTINCT ancestors.station_id FROM ancestors
   JOIN platform_responsibility_scopes scope ON scope.location_id=ancestors.ancestor_id
   WHERE scope.organization_unit_id=$1 AND scope.status='active'
    AND (ancestors.station_id=ancestors.ancestor_id OR scope.include_descendants)
  )`;
 return async(input:{organizationUnitId:string;lineName?:string;stationId?:string;search?:string})=>{
  const lines=await client.query(`${base}
   SELECT DISTINCT line.id,line.name FROM responsible
   JOIN platform_line_stations relation ON relation.station_id=responsible.station_id AND relation.status='active'
   JOIN platform_lines line ON line.id=relation.line_id AND line.status='active'
   ORDER BY line.name,line.id LIMIT 51`,[input.organizationUnitId]);
  const lineRows=(lines as {rows:{id:string;name:string}[]}).rows;
  if(lineRows.length>50)throw Error('STATION_DIRECTORY_LIMIT');
  const stations=await client.query(`${base}
   SELECT station.id,station.name,line.id AS "lineId",line.name AS "lineName"
   FROM responsible
   JOIN platform_locations station ON station.id=responsible.station_id
   JOIN platform_line_stations relation ON relation.station_id=station.id AND relation.status='active'
   JOIN platform_lines line ON line.id=relation.line_id AND line.status='active'
   WHERE ($2::text IS NULL OR line.name=$2) AND ($3::uuid IS NULL OR station.id=$3)
    AND ($4::text IS NULL OR strpos(lower(station.code || ' ' || station.name),lower($4))>0)
   ORDER BY station.name,station.id,line.id LIMIT 50`,[input.organizationUnitId,input.lineName??null,input.stationId??null,input.search??null]);
  return {organizationUnitId:input.organizationUnitId,lines:lineRows,stations:(stations as {rows:{id:string;name:string;lineId:string;lineName:string}[]}).rows};
 };
}
