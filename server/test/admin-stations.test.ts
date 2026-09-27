import {ADMIN_PASSWORD_SESSION_SQL} from '../src/setup/password-policy-migration.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {PGlite} from '@electric-sql/pglite';
import {ADMIN_IDENTITY_MIGRATION,AdminIdentityService,registerAdminIdentityRoutes} from '../src/core/admin-identity/index.ts';
import {registerAdminConsoleRoutes} from '../src/app-platform/admin/routes.ts';
import {createAdminDataService} from '../src/app-platform/admin-data/index.ts';
import {PLATFORM_PEOPLE_DIRECTORY_SQL} from '../src/platform/people/index.ts';
import {PLATFORM_LOCATION_DIRECTORY_SQL} from '../src/platform/locations/index.ts';
import {PLATFORM_ASSET_DIRECTORY_SQL} from '../src/platform/assets/index.ts';
import {PLATFORM_RESPONSIBILITY_SQL} from '../src/platform/responsibility/index.ts';
import {createResponsibleStationReader} from '../src/app-platform/gateway/responsible-stations.ts';

test('administrator maintains one station on multiple lines with atomic audit, conflict protection and scoped directory continuity',async()=>{
 const db=new PGlite();await db.exec(ADMIN_IDENTITY_MIGRATION+PLATFORM_PEOPLE_DIRECTORY_SQL+PLATFORM_LOCATION_DIRECTORY_SQL+PLATFORM_ASSET_DIRECTORY_SQL+PLATFORM_RESPONSIBILITY_SQL);await db.exec(ADMIN_PASSWORD_SESSION_SQL);
 const client={query:(sql:string,args?:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):db.query(sql,[...(args??[])]),release(){}};
 const pool={connect:async()=>client},identity=new AdminIdentityService(pool),origin='https://platform.example';
 const actor=await identity.bootstrap({username:'station.admin',displayName:'车站管理员',password:'Station-directory-test-123'});
 const app=Fastify();await app.register(cookie);registerAdminIdentityRoutes(app,{origin,service:identity});await registerAdminConsoleRoutes(app,{origin,identity,pool});
 try{
  const login=await app.inject({method:'POST',url:'/api/admin/auth/login',headers:{origin},payload:{username:actor.username,password:'Station-directory-test-123'}});
  assert.equal(login.statusCode,200,login.body);
  const headers={origin,cookie:String(login.headers['set-cookie']).split(';')[0]};
  async function request(method:'GET'|'POST'|'PUT',path:string,payload?:unknown){return app.inject({method,url:'/api/admin/data/'+path,headers,payload});}
  for(const [method,path] of [['GET','line-stations'],['POST','stations'],['PUT','stations/10000000-0000-4000-8000-000000000001']] as const){
   assert.equal((await app.inject({method,url:'/api/admin/data/'+path,headers:{origin},payload:method==='GET'?undefined:{}})).statusCode,401);
   if(method!=='GET')assert.equal((await app.inject({method,url:'/api/admin/data/'+path,headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode,403);
  }
  const line1=(await request('POST','lines',{name:'一号线'})).json(),line2=(await request('POST','lines',{name:'六号线'})).json();
  const draft={name:'换乘测试站',shortName:'换乘',status:'active',lines:[{lineId:line1.id,sortOrder:2},{lineId:line2.id,sortOrder:3}]};
  for(const invalid of [{...draft,lines:[]},{...draft,lines:[draft.lines[0],draft.lines[0]]},{...draft,parentId:line1.id},{...draft,organizationUnitId:line1.id}])assert.equal((await request('POST','stations',invalid)).statusCode,400);
  const created=await request('POST','stations',draft);assert.equal(created.statusCode,200,created.body);let station=created.json();
  assert.equal(station.lines.length,2);assert.ok(!('parentId' in station)&&!('organizationUnitId' in station));
  const original=(await db.query('SELECT id,station_code FROM platform_line_stations WHERE station_id=$1 AND line_id=$2',[station.id,line1.id])).rows[0];
  const company=(await request('POST','organizations',{name:'测试公司',unitType:'company'})).json();
  const group=(await request('POST','organizations',{name:'测试工班',unitType:'workgroup',parentId:company.id})).json();
  const parent=(await request('POST','locations',{name:'历史上级位置',locationType:'operational_area'})).json();
  await db.query('UPDATE platform_locations SET parent_id=$1,organization_unit_id=$2 WHERE id=$3',[parent.id,company.id,station.id]);
  station=(await request('GET','line-stations')).json().stations.find((row:{id:string})=>row.id===station.id);
  assert.equal((await request('PUT',`organizations/${group.id}/stations`,{stationIds:[station.id]})).statusCode,200);
  const scope=(await db.query('SELECT id FROM platform_responsibility_scopes WHERE location_id=$1',[station.id])).rows[0];
  const list=(await request('GET','line-stations?q=六号线')).json();assert.equal(list.total,1);assert.equal(list.stations[0].id,station.id);
  assert.equal((await request('GET',`line-stations?lineId=${line2.id}`)).json().stations[0].lines.length,2);
  const occupied=(await request('POST','stations',{...draft,name:'另一个站',lines:[{lineId:line1.id,sortOrder:1}]})).json();
  const conflict=await request('PUT',`stations/${station.id}`,{...draft,name:'不应保存',lines:[{lineId:line1.id,sortOrder:1}],revision:station.revision});
  assert.equal(conflict.statusCode,400);assert.equal(conflict.json().error,'DUPLICATE_LINE_SORT_ORDER');
  assert.equal((await db.query('SELECT name FROM platform_locations WHERE id=$1',[station.id])).rows[0].name,draft.name);
  const changed=await request('PUT',`stations/${station.id}`,{...draft,name:'改名换乘站',revision:station.revision});assert.equal(changed.statusCode,200,changed.body);
  assert.equal((await request('PUT',`stations/${station.id}`,{...draft,revision:station.revision})).statusCode,409);
  const service=createAdminDataService(client,{audit:async()=>{throw Error('audit failure');}});
  await assert.rejects(service.updateStation(actor,station.id,{...draft,revision:changed.json().revision}));
  assert.equal((await db.query('SELECT name FROM platform_locations WHERE id=$1',[station.id])).rows[0].name,'改名换乘站');
  await assert.rejects(service.createStation(actor,{...draft,name:'回滚新站',lines:[{lineId:line1.id,sortOrder:10}]}));
  assert.equal((await db.query("SELECT count(*)::int AS total FROM platform_locations WHERE name='回滚新站'")).rows[0].total,0);
  const removed=await request('PUT',`stations/${station.id}`,{...draft,lines:[draft.lines[0]],revision:changed.json().revision});assert.equal(removed.statusCode,200,removed.body);
  assert.equal(removed.json().id,station.id);assert.equal(removed.json().lines.length,1);
  assert.deepEqual((await db.query('SELECT parent_id,organization_unit_id FROM platform_locations WHERE id=$1',[station.id])).rows[0],{parent_id:parent.id,organization_unit_id:company.id});
  assert.deepEqual((await db.query('SELECT id,station_code FROM platform_line_stations WHERE station_id=$1',[station.id])).rows[0],original);
  assert.equal((await db.query('SELECT id FROM platform_responsibility_scopes WHERE location_id=$1',[station.id])).rows[0].id,scope.id);
  const responsibility=await createResponsibleStationReader(client)({organizationUnitId:group.id});assert.equal(responsibility.stations.length,1);assert.equal(responsibility.stations[0].lineId,line1.id);
  await db.query("UPDATE platform_lines SET status='inactive' WHERE id=$1",[line2.id]);
  assert.equal((await request('POST','stations',{...draft,lines:[{lineId:line2.id,sortOrder:5}]})).statusCode,400);
  const archived=await request('PUT',`stations/${station.id}`,{...draft,status:'inactive',lines:[draft.lines[0]],revision:removed.json().revision});assert.equal(archived.statusCode,200,archived.body);
  assert.equal((await request('GET','line-stations?status=inactive')).json().total,1);
  assert.equal((await request('GET','line-stations?status=invalid')).statusCode,400);
  assert.equal((await request('PUT',`stations/${occupied.id}`,{...draft,revision:'0'.repeat(64)})).statusCode,409);
  assert.equal((await db.query("SELECT count(*)::int AS total FROM platform_admin_audit WHERE action='data.stations.create'")).rows[0].total,2);
 }finally{await app.close();await db.close();}
});

test('station directory searches and paginates all records beyond the former hundred-record limit',async()=>{
 const db=new PGlite();await db.exec(PLATFORM_PEOPLE_DIRECTORY_SQL+PLATFORM_LOCATION_DIRECTORY_SQL);
 try{
  await db.exec("INSERT INTO platform_locations(id,code,name,location_type,status,created_at,updated_at) SELECT md5(i::text)::uuid,'S'||i,'车站'||i,'station','active',now(),now() FROM generate_series(1,125) i;");
  const service=createAdminDataService({query:(sql,args)=>db.query(sql,[...(args??[])])},{audit:async()=>{}}),actor={id:'admin',username:'admin',displayName:'Admin'};
  const first=await service.stationDirectory(actor,{}),last=await service.stationDirectory(actor,{page:'3'});
  assert.equal(first.total,125);assert.equal(first.stations.length,50);assert.equal(last.stations.length,25);assert.equal(last.hasNext,false);
  const search=await service.stationDirectory(actor,{q:'车站125'});assert.equal(search.total,1);assert.equal(search.stations[0].name,'车站125');
 }finally{await db.close();}
});
