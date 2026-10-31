import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {AppBusinessAuthorization} from '../src/app-platform/business-authorization/service.ts';
import {createAssigneeDirectoryOperation} from '../src/app-platform/gateway/assignees.ts';
import {AppRegistryService,PostgresAppRegistryRepository} from '../src/app-platform/registry/index.ts';
import {createPostgresAuthorizationRepository} from '../src/platform/authorization/index.ts';
import {demoManifest} from './helpers/registry-manifest.ts';

test('assignee search applies the requested action scope before paging, including non-workgroup employees',async()=>{
 const pg=new PGlite(),db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}},pool={...db,connect:async()=>db};
 try{
  await initializePlatformDatabase(db);
  const dept=randomUUID(),team=randomUUID(),outside=randomUUID(),owner=randomUUID(),member=randomUUID(),stranger=randomUUID(),position=randomUUID();
  for(const [id,type,parent] of [[dept,'department',null],[team,'workgroup',dept],[outside,'department',null]])
   await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,parent_id,status,created_at,updated_at) VALUES($1::uuid,$1::text,$1::text,$2,$3,'active',now(),now())",[id,type,parent]);
  await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'job','Job','active',now(),now())",[position]);
  const people=[[owner,dept,'负责人'],[member,team,'员工'],[stranger,outside,'外部员工'],...Array.from({length:45},(_,i)=>[randomUUID(),dept,'办公室'+i])];
  for(const [id,org,name] of people)await pg.query("INSERT INTO platform_people(id,employee_no,name,phone,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,$2,'private-phone',$3,$4,'active',now(),now())",[id,name,org,position]);
  const admin:any={actorType:'administrator',administrator:{id:randomUUID()},execution:{type:'platform'},request:{requestId:'test',traceId:'test'},authorize:async()=>({allowed:true})};
  const registry=new AppRegistryService(new PostgresAppRegistryRepository(db),{authorization:createPostgresAuthorizationRepository(db),host:()=>({platformVersion:'0.6.0',capabilities:[],applications:[]})});
  const manifest=structuredClone(demoManifest),permission='assign';manifest.permissions.defined=[{code:`app.${manifest.id}.${permission}`,description:'Assign',scopeKinds:['self','department','workgroup','all','organizations']}];
  // Existing fixture routes retain their original read permission.
  manifest.permissions.defined.push(...demoManifest.permissions.defined);
  let app=await registry.register(admin,manifest);await registry.setEnabled(admin,app.appId,app.revision,true);
  const roles=new AppBusinessAuthorization(pool);
  await roles.setOwner(admin,app.appId,{personId:owner,revision:null});
  let state=await roles.snapshot(app.appId,owner);
  state=await roles.change(app.appId,owner,{action:'role',revision:state.revision,name:'派发者',status:'active',rules:[{permission:manifest.permissions.defined[0].code,scope:'department',organizationIds:[]}]});
  const role=state.roles[0].id;
  state=await roles.change(app.appId,owner,{action:'member',revision:state.revision,personId:member,roleId:role,enabled:true});
  state=await roles.change(app.appId,owner,{action:'activate',revision:state.revision,confirm:true});
  const context:any={actorType:'service',execution:{appId:app.appId},employeeActor:{person:{id:member},execution:{type:'application',appId:app.appId}}};
  const operation=createAssigneeDirectoryOperation(pool),run=async(query:object={})=>operation.execute(context,{permission,...query},new AbortController().signal) as Promise<any>;
  const first=await run(),second=await run({afterId:first.nextCursor});
  assert.equal(first.rows.length,40);assert.ok(first.nextCursor);assert.equal(second.rows.length,7);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.rows,...second.rows].map(p=>p.id)).size,47);
  assert.ok([...first.rows,...second.rows].some(p=>p.organizationUnitId===dept));
  assert.ok(!JSON.stringify(first).includes('phone'));
  assert.equal((await run({personId:stranger})).rows.length,0);
  assert.deepEqual((await run({search:'负责人',exact:true})).rows.map(p=>p.id),[owner]);
  assert.deepEqual((await run({search:member})).rows.map(p=>p.id),[member]);
  await assert.rejects(operation.execute({...context,employeeActor:undefined},{permission},new AbortController().signal),/ACCESS_DENIED/);
  state=await roles.change(app.appId,owner,{action:'role',revision:state.revision,id:role,name:'派发者',status:'active',rules:[{permission:manifest.permissions.defined[0].code,scope:'self',organizationIds:[]}]});
  assert.deepEqual((await run()).rows.map(p=>p.id),[member]);
  state=await roles.change(app.appId,owner,{action:'role',revision:state.revision,id:role,name:'派发者',status:'inactive',rules:[{permission:manifest.permissions.defined[0].code,scope:'self',organizationIds:[]}]});
  await assert.rejects(run(),/ACCESS_DENIED/);
 }finally{await pg.close();}
});

test('UUID scope filters fit real storage limits and remain bounded and typed',async()=>{
 const {runtimeListInput,runtimeListQuery}=await import('../src/app-platform/v2/data-query.ts');
 const {AppDataServiceV2}=await import('../src/app-platform/v2/data.ts');
 const ids=Array.from({length:127},()=>randomUUID());
 const anyOf=[[{column:'organization_id',in:[...ids]}],[{column:'responsible_organization_id',in:[...ids]}],[{column:'responsible_id',value:randomUUID()}],[{column:'created_by',value:randomUUID()}]];
 const input={table:'work_records',anyOf};
 const service=new AppDataServiceV2({pool:{connect:async()=>{throw Error('unused');}} as never,findInstallation:async()=>null});
 assert.equal(service.operations().find(op=>op.name==='platform.app_data.list')!.validateParams(input),true);
 const parsed=runtimeListInput.parse(input);
 assert.throws(()=>runtimeListQuery(parsed,new Map([['organization_id','text']])),/INVALID_PARAMS/);
 for(const invalid of [[],[...ids,randomUUID()],["'); DROP TABLE work_records; --"],[null]])
  assert.equal(runtimeListInput.safeParse({table:'work_records',filters:[{column:'organization_id',in:invalid}]}).success,false);
 const db=new PGlite();try{
  await db.exec('CREATE TABLE work_records(id uuid,organization_id uuid,responsible_organization_id uuid,responsible_id uuid,created_by uuid)');
  const included=randomUUID(),excluded=randomUUID();
  await db.query('INSERT INTO work_records(id,organization_id,responsible_organization_id) VALUES($1,$2,$3),($4,$2,$2)',[included,randomUUID(),ids[126],excluded]);
  const query=runtimeListQuery(parsed,new Map(['id','organization_id','responsible_organization_id','responsible_id','created_by'].map(c=>[c,'uuid'])));
  assert.deepEqual((await db.query('SELECT id FROM work_records'+query.suffix,query.values)).rows,[{id:included}]);
 }finally{await db.close();}
});
