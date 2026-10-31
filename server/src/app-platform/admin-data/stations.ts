import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {runDatabaseTransaction,type QueryableClient} from '../../core/database/index.js';
import {createPostgresLocationDirectoryRepository,createLocationDirectoryService,type LocationDirectoryProfile} from '../../platform/locations/index.js';
import type {AdminDataActor} from './index.js';
import {AdminDataError} from './errors.js';

const stationNumber=z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/,'车站编号须为 1–50 位字母、数字、点、下划线或连字符，以字母或数字开头').nullable().optional();
const membership=z.object({lineId:z.string().uuid(),stationNumber,sortOrder:z.number().int().min(1).max(100000)}).strict();
const stationInput=z.object({name:z.string().trim().min(1).max(200),shortName:z.string().trim().max(100).nullable().optional(),status:z.enum(['active','inactive']),lines:z.array(membership).min(1).max(50),requestId:z.string().uuid()}).strict();
const directoryQuery=z.object({q:z.string().trim().max(200).default(''),status:z.enum(['','active','inactive']).default(''),lineId:z.string().uuid().optional(),page:z.coerce.number().int().min(1).max(10000).default(1)}).strict();
function row(profile:LocationDirectoryProfile){
  const {location,stationLines}=profile;
  const memberships=stationLines.map(({line,lineStation})=>({lineId:line.id,lineName:line.name,lineStatus:line.status,stationNumber:lineStation.stationNumber??null,sortOrder:lineStation.sortOrder,status:lineStation.status}));
  // Include the complete stored profile, so an older editor cannot overwrite changed memberships.
  const revision=createHash('sha256').update(JSON.stringify({location,stationLines})).digest('hex');
  return {id:location.id,name:location.name,shortName:location.shortName,status:location.status,lines:memberships,revision};
}
export function createAdminStationDirectory(client:QueryableClient,options:{authorize(actor:AdminDataActor):void;audit(event:{actorId:string;action:string;targetId:string}):Promise<void>}){
  const repo=createPostgresLocationDirectoryRepository(client),locations=createLocationDirectoryService(repo);
  async function write(actor:AdminDataActor,id:string|null,input:unknown){
    options.authorize(actor);
    const parsed=id?stationInput.extend({revision:z.string().regex(/^[a-f0-9]{64}$/)}).parse(input):stationInput.parse(input);
    if(new Set(parsed.lines.map(item=>item.lineId)).size!==parsed.lines.length)throw new AdminDataError('DUPLICATE_STATION_LINE','同一线路只能选择一次');
    if(id)z.string().uuid().parse(id);
    return runDatabaseTransaction(client,async()=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-line-stations',0))");
      const requestHash=createHash('sha256').update(JSON.stringify({actorId:actor.id,id,parsed})).digest('hex');
      const saved=await client.query('SELECT request_hash,result FROM admin_station_requests WHERE request_id=$1',[parsed.requestId]) as {rows:{request_hash:string;result:ReturnType<typeof row>}[]};
      if(saved.rows[0]){
        if(saved.rows[0].request_hash!==requestHash)throw new AdminDataError('REQUEST_ID_REUSED','请求编号已用于其他操作',409);
        return saved.rows[0].result;
      }
      const previous=id?await repo.getLocationProfile(id):null;
      if(id&&previous?.location.locationType!=='station')throw new AdminDataError('STATION_NOT_FOUND','车站不存在',404);
      if(previous&&row(previous).revision!==('revision' in parsed?parsed.revision:null))throw new AdminDataError('STALE_REVISION','车站已变化，请刷新后重新编辑',409);
      for(const selected of parsed.lines){
        const line=await repo.findLineById(selected.lineId);
        if(!line)throw new AdminDataError('LINE_NOT_FOUND','所选线路不存在');
        const old=previous?.stationLines.find(item=>item.line.id===selected.lineId);
        if(selected.stationNumber){
          const duplicate=await client.query('SELECT id FROM platform_line_stations WHERE line_id=$1 AND lower(station_number)=lower($2) AND ($3::uuid IS NULL OR station_id<>$3)',[selected.lineId,selected.stationNumber,id]) as {rows:unknown[]};
          if(duplicate.rows.length)throw new AdminDataError('DUPLICATE_STATION_NUMBER',`${line.name}的车站编号已被使用`,409);
        }
        if(line.status!=='active'&&(!old||old.lineStation.status!=='active'||old.lineStation.sortOrder!==selected.sortOrder||(selected.stationNumber!==undefined&&selected.stationNumber!==(old.lineStation.stationNumber??null))))throw new AdminDataError('LINE_INACTIVE','停用线路不能新增或调整车站');
        const occupied=await repo.findLineStationByOrder(selected.lineId,selected.sortOrder);
        if(occupied&&occupied.stationId!==id)throw new AdminDataError('DUPLICATE_LINE_SORT_ORDER',`${line.name}的站序 ${selected.sortOrder} 已被占用`);
      }
      const station=id?await locations.updateLocationDetails(id,{name:parsed.name,shortName:parsed.shortName??null,status:parsed.status}):await locations.createLocation({code:`loc-${randomUUID().replaceAll('-','')}`,name:parsed.name,shortName:parsed.shortName,locationType:'station',status:parsed.status});
      // Memberships have no external references. Replacing them atomically preserves station IDs,
      // business records and responsibility scopes, while allowing a station to leave a line.
      await client.query('DELETE FROM platform_line_stations WHERE station_id=$1',[station.id]);
      const now=new Date().toISOString();
      for(const selected of parsed.lines){
        const old=previous?.stationLines.find(item=>item.line.id===selected.lineId)?.lineStation;
        await repo.createLineStation({id:old?.id??randomUUID(),lineId:selected.lineId,stationId:station.id,stationCode:old?.stationCode??`ST-${randomUUID().replaceAll('-','')}`,sortOrder:selected.sortOrder,status:'active',createdAt:old?.createdAt??now,updatedAt:now});
        await client.query('UPDATE platform_line_stations SET station_number=$3 WHERE line_id=$1 AND station_id=$2',[selected.lineId,station.id,selected.stationNumber===undefined?old?.stationNumber??null:selected.stationNumber]);
      }
      await options.audit({actorId:actor.id,action:id?'data.stations.update':'data.stations.create',targetId:station.id});
      const result=row((await repo.getLocationProfile(station.id))!);
      await client.query('INSERT INTO admin_station_requests(request_id,request_hash,result) VALUES($1,$2,$3)',[parsed.requestId,requestHash,JSON.stringify(result)]);
      return result;
    });
  }
  return {
    async stationDirectory(actor:AdminDataActor,input:unknown={}){
      options.authorize(actor);const query=directoryQuery.parse(input);
      // A consistent snapshot prevents a list row from combining two different directory revisions.
      return runDatabaseTransaction(client,async()=>{
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const lines=await repo.listLines(),profiles=await repo.listLocationProfiles({locationType:'station'});
        const filtered=profiles.map(row).filter(station=>(!query.status||station.status===query.status)&&(!query.lineId||station.lines.some(line=>line.lineId===query.lineId&&line.status==='active'))&&(!query.q||[station.name,station.shortName??'',...station.lines.flatMap(line=>[line.lineName,line.stationNumber??''])].some(value=>value.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()))));
        if(query.lineId)filtered.sort((a,b)=>(a.lines.find(line=>line.lineId===query.lineId)!.sortOrder-b.lines.find(line=>line.lineId===query.lineId)!.sortOrder)||a.id.localeCompare(b.id));
        const offset=(query.page-1)*50;
        return {lines:lines.map(line=>({id:line.id,name:line.name,shortName:line.shortName,status:line.status,nextSortOrder:Math.max(0,...profiles.flatMap(profile=>profile.stationLines.filter(item=>item.line.id===line.id).map(item=>item.lineStation.sortOrder)))+1})),stations:filtered.slice(offset,offset+50),total:filtered.length,page:query.page,hasNext:offset+50<filtered.length};
      });
    },
    createStation:(actor:AdminDataActor,input:unknown)=>write(actor,null,input),
    updateStation:(actor:AdminDataActor,id:string,input:unknown)=>write(actor,id,input),
  };
}
