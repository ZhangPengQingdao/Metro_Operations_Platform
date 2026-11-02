import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {DeveloperKeys} from '../src/app-platform/developer/keys.ts';
import {readPublicDirectory,PUBLIC_DIRECTORIES,publicDirectoryOperation} from '../src/app-platform/developer/directory.ts';
import {registerDeveloperApi} from '../src/app-platform/developer/routes.ts';
import {registerEmployeeRoutes} from '../src/app-platform/employee/routes.ts';
import {EmployeeIdentityService,EMPLOYEE_SESSION_COOKIE} from '../src/platform/employee-identity/index.ts';
import {AppInterfaces} from '../src/app-platform/developer/app-interfaces.ts';
import {validateAppManifestV2} from '@metro/platform-sdk/manifest';
import {createAppServerContext} from '@metro/platform-sdk/server';
import {readFile} from 'node:fs/promises';

async function fixture(){
 const pg=new PGlite(),db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}},pool={...db,connect:async()=>db};
 await initializePlatformDatabase(db);assert.deepEqual(await initializePlatformDatabase(db),[]);
 const person=randomUUID(),other=randomUUID(),org=randomUUID(),position=randomUUID(),account=randomUUID();
 await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,status,created_at,updated_at) VALUES($1,'dev-team','开发工班','workgroup','active',now(),now())",[org]);
 await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'dev-position','员工','active',now(),now())",[position]);
 for(const id of [person,other]){
  await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,phone,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,'测试员工',$2,$3,'13800000000','active',now(),now())",[id,org,position]);
  await pg.query("INSERT INTO platform_employee_accounts(id,person_id,username,password_hash,status) VALUES($1,$2::uuid,$2::text,'test-fingerprint','active')",[id===person?account:randomUUID(),id]);
 }
 return {pg,pool,person,other,org,position,account,keys:new DeveloperKeys(pool)};
}

test('development keys are hashed, scoped, idempotent, owner-only and follow live identity state',async()=>{
 const f=await fixture();try{
  const input={requestId:randomUUID(),name:'本地开发',days:30,scopes:['directory']};
  const result=await f.keys.create(f.person,input);assert.ok(result.token);
  const token=result.token!,header=`Bearer ${token}`;
  const auth=await f.keys.authenticate(header);assert.equal(auth.personId,f.person);assert.deepEqual(auth.scopes,['directory']);
  const storage=JSON.stringify((await f.pg.query('SELECT * FROM platform_developer_keys')).rows);assert.ok(!storage.includes(token));assert.ok(!JSON.stringify(await f.keys.list(f.person)).includes(token));
  assert.equal((await f.keys.create(f.person,input)).token,null);
  await assert.rejects(f.keys.create(f.person,{...input,name:'changed'}),/REQUEST_ID_REUSED/);
  await f.keys.revoke(f.other,auth.id,randomUUID());assert.ok(await f.keys.authenticate(header));
  for(const sql of ["UPDATE platform_employee_accounts SET status='disabled' WHERE id=$1"]){
   await f.pg.query(sql,[f.account]);await assert.rejects(f.keys.authenticate(header),/DEVELOPER_AUTH_REQUIRED/);
   await f.pg.query("UPDATE platform_employee_accounts SET status='active' WHERE id=$1",[f.account]);
  }
  await f.pg.query("INSERT INTO platform_employee_sessions(token_hash,account_id,expires_at,password_change_required) VALUES('forced',$1,now()+interval '1 hour',true)",[f.account]);await assert.rejects(f.keys.authenticate(header),/DEVELOPER_AUTH_REQUIRED/);await f.pg.query("DELETE FROM platform_employee_sessions WHERE token_hash='forced'");
  for(const [table,column,id,disabled] of [['platform_people','employment_status',f.person,'departed'],['platform_organization_units','status',f.org,'inactive'],['platform_positions','status',f.position,'inactive']]){
   await f.pg.query(`UPDATE ${table} SET ${column}=$1 WHERE id=$2`,[disabled,id]);await assert.rejects(f.keys.authenticate(header),/DEVELOPER_AUTH_REQUIRED/);await f.pg.query(`UPDATE ${table} SET ${column}='active' WHERE id=$1`,[id]);
  }
  await f.pg.query("UPDATE platform_employee_accounts SET password_hash='changed' WHERE id=$1",[f.account]);await assert.rejects(f.keys.authenticate(header),/DEVELOPER_AUTH_REQUIRED/);
  await f.pg.query("UPDATE platform_employee_accounts SET password_hash='test-fingerprint' WHERE id=$1",[f.account]);
  await f.keys.revoke(f.person,auth.id,randomUUID());await f.keys.revoke(f.person,auth.id,randomUUID());await assert.rejects(f.keys.authenticate(header),/DEVELOPER_AUTH_REQUIRED/);
  const events=await f.keys.history(f.person);assert.equal(events.events.length,2);
  const expiring=await f.keys.create(f.person,{...input,requestId:randomUUID()});await f.pg.query("UPDATE platform_developer_keys SET expires_at=now()-interval '1 second' WHERE id=$1",[expiring.id]);await assert.rejects(f.keys.authenticate(`Bearer ${expiring.token}`),/DEVELOPER_AUTH_REQUIRED/);
  for(let i=0;i<5;i++)await f.keys.create(f.person,{...input,requestId:randomUUID()});await assert.rejects(f.keys.create(f.person,{...input,requestId:randomUUID()}),/DEVELOPER_KEY_LIMIT/);
 }finally{await f.pg.close();}
});

test('public directory whitelist, paging, active relations and bearer/session route separation',async()=>{
 const f=await fixture(),app=Fastify();try{
  const line=randomUUID(),station=randomUUID(),inactive=randomUUID(),system=randomUUID(),category=randomUUID(),type=randomUUID();
  await f.pg.query("INSERT INTO platform_lines(id,code,name,line_number,status,sort_order,created_at,updated_at) VALUES($1,'line','一号线','01','active',1,now(),now())",[line]);
  for(const [id,state,name] of [[station,'active','测试站'],[inactive,'inactive','停用站']])await f.pg.query("INSERT INTO platform_locations(id,code,name,location_type,status,created_at,updated_at) VALUES($1::uuid,$1::text,$2,'station',$3,now(),now())",[id,name,state]);
  await f.pg.query("INSERT INTO platform_line_stations(id,line_id,station_id,station_code,station_number,sort_order,status,created_at,updated_at) VALUES($1,$2,$3,'s1','001',1,'active',now(),now())",[randomUUID(),line,station]);
  await f.pg.query("INSERT INTO platform_responsibility_scopes(id,organization_unit_id,location_id,include_descendants,status,created_at,updated_at) VALUES($1,$2,$3,false,'active',now(),now())",[randomUUID(),f.org,station]);
  await f.pg.query("INSERT INTO platform_asset_systems(id,code,name,status,created_at,updated_at) VALUES($1,'afc','AFC','active',now(),now())",[system]);
  await f.pg.query("INSERT INTO platform_asset_categories(id,system_id,code,name,status,created_at,updated_at) VALUES($1,$2,'ticket','票务','active',now(),now())",[category,system]);
  await f.pg.query("INSERT INTO platform_asset_types(id,system_id,category_id,code,name,status,created_at,updated_at) VALUES($1,$2,$3,'tvm','售票机','active',now(),now())",[type,system,category]);
  const operation=publicDirectoryOperation(f.pool);await assert.rejects(operation.resolveResources({} as any,{}),/ACCESS_DENIED/);assert.deepEqual(await operation.resolveResources({employeeActor:{person:{id:f.person}}} as any,{}),[{}]);
  for(const item of PUBLIC_DIRECTORIES){const page=await readPublicDirectory(f.pool,{resource:item.id});assert.ok(page.rows.length>0,item.id);assert.ok(!JSON.stringify(page).includes('13800000000'));}
  const stations=await readPublicDirectory(f.pool,{resource:'stations'});assert.equal(stations.rows.length,1);assert.equal(stations.rows[0].id,station);
  assert.equal((await readPublicDirectory(f.pool,{resource:'line-stations',search:'001'})).rows[0].stationNumber,'001');
  assert.deepEqual((await readPublicDirectory(f.pool,{resource:'workgroup-stations'})).rows[0].workgroups,[{id:f.org,name:'开发工班'}]);
  await f.pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) SELECT gen_random_uuid(),'p'||n,'岗位'||n,'active',now(),now() FROM generate_series(1,3) n");
  const first=await readPublicDirectory(f.pool,{resource:'positions',pageSize:2}),second=await readPublicDirectory(f.pool,{resource:'positions',pageSize:2,afterId:first.nextCursor});assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,4);assert.equal(second.nextCursor,null);
  for(const resource of ['people','assets','dictionaries',"stations;DROP TABLE platform_people"]){await assert.rejects(readPublicDirectory(f.pool,{resource}));}
  await app.register(cookie);registerDeveloperApi(app,{pool:f.pool,origin:'https://platform.test'});
  registerEmployeeRoutes(app,{pool:f.pool,origin:'https://platform.test',service:new EmployeeIdentityService(f.pool),resolveAdmin:async()=>{throw Error('not allowed');}});
  const created=await f.keys.create(f.person,{requestId:randomUUID(),name:'cli',days:7,scopes:['directory']});const headers={authorization:`Bearer ${created.token}`};
  assert.equal((await app.inject('/api/developer/directory?resource=stations')).statusCode,401);
  assert.equal((await app.inject({url:'/api/developer/directory?resource=stations',headers})).statusCode,200);
  assert.equal((await app.inject({url:'/api/developer/interfaces',headers})).statusCode,403);
  assert.equal((await app.inject({url:'/api/employee/developer/keys',headers})).statusCode,401);
  assert.equal((await app.inject({url:'/api/developer/directory?resource=stations',headers:{...headers,origin:'https://evil.test'}})).statusCode,403);
  for(const [payload,status,error] of [['{',400,'INVALID_PARAMS'],[JSON.stringify({input:'x'.repeat(65536)}),413,'PAYLOAD_TOO_LARGE']] as const){
   const response=await app.inject({method:'POST',url:'/api/developer/call',headers:{...headers,'content-type':'application/json'},payload});
   assert.equal(response.statusCode,status);assert.equal(response.json().error,error);
  }
  const session='a'.repeat(64);const {createHash}=await import('node:crypto');await f.pg.query("INSERT INTO platform_employee_sessions(token_hash,account_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[createHash('sha256').update(session).digest('hex'),f.account]);
  const browser={cookie:`${EMPLOYEE_SESSION_COOKIE}=${session}`};
  assert.equal((await app.inject({url:'/api/employee/developer/directory?resource=stations',headers:browser})).statusCode,200);
  assert.equal((await app.inject({url:'/api/employee/developer/downloads',headers:browser})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/employee/developer/keys',headers:browser,payload:{}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/developer/directory?resource=stations',headers:browser})).statusCode,401);
  for(let i=0;i<60;i++)await app.inject({url:'/api/developer/directories',headers});assert.equal((await app.inject({url:'/api/developer/directories',headers})).statusCode,429);
 }finally{await app.close();await f.pg.close();}
});

test('manifest contracts and SDK helpers do not accept implicit exposure or undeclared dependencies',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../applications/faults/app.json',import.meta.url),'utf8'));
 assert.ok(validateAppManifestV2(manifest).ok);const api=manifest.api.find((a:any)=>a.expose);
 for(const change of [{permission:undefined},{expose:{...api.expose,mode:'write'}},{expose:{...api.expose,documentation:{...api.expose.documentation,input:{type:'object'}}}}])assert.equal(validateAppManifestV2({...manifest,api:[{...api,...change}]}).ok,false);
 for(const dependencies of [[{appId:'faults',apiId:'public-query'}],[{appId:'maintenance',apiId:'list'}]])assert.equal(validateAppManifestV2({...manifest,appAccess:dependencies}).ok,false);
 const calls:unknown[]=[];const ctx=createAppServerContext({appId:'demo',employee:{} as any,gateway:{invoke:async(...args:any[])=>{calls.push(args);return {};}} as any,signal:new AbortController().signal});
 await ctx.apps.call('faults','public-query',{});await ctx.directory.list('stations');assert.equal((calls[0] as any)[0],'platform.apps.call');assert.equal((calls[1] as any)[1].resource,'stations');
});

test('shared application adapter enforces input/output, dependencies and permission revocation before returning data',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../applications/faults/app.json',import.meta.url),'utf8')),api=manifest.api.find((a:any)=>a.expose);
 const entry={appId:'faults',appName:'故障',version:'1.1.0',revision:1,apiId:api.id,permission:'read',expose:api.expose};let allowed=true,dependency=true,revoke=false,revision=1,wrong=false,upgrade=false,scopeChange=false,accessKey='scope1',calls=0;
 const interfaces=new AppInterfaces({catalog:async()=>allowed?[{...entry,revision,accessKey}]:[],assertDependency:async()=>{if(!dependency)throw Error('DEPENDENCY_DENIED');},invoke:async()=>{calls++;if(revoke)allowed=false;if(upgrade)revision++;if(scopeChange)accessKey='scope2';return {ok:true,result:wrong?{secret:'bad'}:{rows:[],cursor:''}};}});
 const value={appId:'faults',apiId:api.id,input:{}};assert.deepEqual(JSON.parse(JSON.stringify(await interfaces.call('person',value))),{rows:[],cursor:''});
 await assert.rejects(interfaces.call('person',{...value,input:{personId:'forged'}}),/INVALID_PARAMS/);assert.equal(calls,1);
 dependency=false;await assert.rejects(interfaces.call('person',value,undefined,'maintenance'),/DEPENDENCY_DENIED/);assert.equal(calls,1);dependency=true;
 allowed=false;assert.deepEqual(await interfaces.catalog('person'),[]);await assert.rejects(interfaces.call('person',value),/ACCESS_DENIED/);allowed=true;
 wrong=true;await assert.rejects(interfaces.call('person',value),/INVALID_RESULT/);wrong=false;
  upgrade=true;await assert.rejects(interfaces.call('person',value),/ACCESS_DENIED/);upgrade=false;
  scopeChange=true;await assert.rejects(interfaces.call('person',value),/ACCESS_DENIED/);scopeChange=false;
  assert.deepEqual(JSON.parse(JSON.stringify(await interfaces.call('person',value))),{rows:[],cursor:''});
 revoke=true;await assert.rejects(interfaces.call('person',value),/ACCESS_DENIED/);
});


test('key creation and revocation roll back together with audit failures',async()=>{
 const f=await fixture();try{
  let broken=true;
  const db={query:async(sql:string,args?:readonly unknown[])=>{if(broken&&sql.startsWith('INSERT INTO platform_developer_audit'))throw Error('AUDIT_UNAVAILABLE');return f.pool.query(sql,args);},release(){}};
  const keys=new DeveloperKeys({...db,connect:async()=>db});
  const input={requestId:randomUUID(),name:'atomic',days:7,scopes:['directory']};
  await assert.rejects(keys.create(f.person,input),/AUDIT_UNAVAILABLE/);assert.equal((await f.keys.list(f.person)).keys.length,0);
  broken=false;const created=await keys.create(f.person,input);const identity=await keys.authenticate(`Bearer ${created.token}`);
  broken=true;await assert.rejects(keys.revoke(f.person,identity.id,randomUUID()),/AUDIT_UNAVAILABLE/);assert.ok(await keys.authenticate(`Bearer ${created.token}`));
 }finally{await f.pg.close();}
});

test('default keys have no expiry, include both read scopes and keep legacy key limits and revocation',async()=>{
 const f=await fixture();try{
  const legacy=await f.keys.create(f.person,{requestId:randomUUID(),name:'legacy',days:7,scopes:['directory']});
  const before=(await f.pg.query('SELECT expires_at,scopes FROM platform_developer_keys WHERE id=$1',[legacy.id])).rows[0];
  // Exercise the additive migration against the prior NOT NULL schema with an existing key.
  await f.pg.query('ALTER TABLE platform_developer_keys ALTER COLUMN expires_at SET NOT NULL');
  const {developerKeyLifetimeMigration}=await import('../src/app-platform/developer/keys.ts');
  await developerKeyLifetimeMigration.run({client:f.pool} as any);
  assert.deepEqual((await f.pg.query('SELECT expires_at,scopes FROM platform_developer_keys WHERE id=$1',[legacy.id])).rows[0],before);
  const input={requestId:randomUUID(),name:'default'};
  const created=await f.keys.create(f.person,input),header=`Bearer ${created.token}`;
  assert.deepEqual((await f.keys.authenticate(header)).scopes,['directory','apps']);
  const row=(await f.pg.query('SELECT expires_at FROM platform_developer_keys WHERE id=$1',[created.id])).rows[0];assert.equal(row.expires_at,null);
  assert.equal((await f.keys.create(f.person,input)).token,null);
  await assert.rejects(f.keys.create(f.person,{...input,days:7}),/REQUEST_ID_REUSED/);
  await assert.rejects(f.keys.create(f.person,{...input,scopes:['directory']}),/REQUEST_ID_REUSED/);
  for(let i=0;i<3;i++)await f.keys.create(f.person,{...input,requestId:randomUUID()});
  await assert.rejects(f.keys.create(f.person,{...input,requestId:randomUUID()}),/DEVELOPER_KEY_LIMIT/);
  await f.keys.revoke(f.person,created.id!,randomUUID());await assert.rejects(f.keys.authenticate(header),/DEVELOPER_AUTH_REQUIRED/);
  const replacement=await f.keys.create(f.person,{...input,requestId:randomUUID()});
  await f.pg.query("UPDATE platform_employee_accounts SET password_hash='changed' WHERE id=$1",[f.account]);
  await assert.rejects(f.keys.authenticate(`Bearer ${replacement.token}`),/DEVELOPER_AUTH_REQUIRED/);
 }finally{await f.pg.close();}
});
