import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {createMopkg,inspectMopkg} from '@metro/platform-sdk/mopkg';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {registerAppSubmissionRoutes} from '../src/app-platform/submissions/routes.ts';
import {createAdministratorContext,registerAdminConsoleRoutes} from '../src/app-platform/admin/routes.ts';
import {registerRegistrationRoutes} from '../src/platform/employee-identity/registration.ts';
import {ADMIN_SESSION_COOKIE} from '../src/core/admin-identity/index.ts';
import {EmployeeIdentityError} from '../src/platform/employee-identity/index.ts';
const encoder=new TextEncoder();
const app_json=JSON.stringify({id:'fire-check',name:'灭火器巡检',version:'1.0.0',description:'按车站巡检灭火器',color:'#e5484d',platform:'>=0.26.0',permissions:[{code:'read',name:'查看'}],pages:[{path:'/',title:'任务',permission:'read',nav:true}],api:[]});
const packageFor=(id='fire-check',version='1.0.0')=>Buffer.from(createMopkg([{path:'app.json',data:encoder.encode(JSON.stringify({...JSON.parse(app_json),id,version}))},{path:'icon.svg',data:encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>')},{path:'ui.js',data:encoder.encode('export default {};')}])).toString('base64');
const mopkg=packageFor();
test('admin notifications track new apps, owner updates and registrations through review without replay',async()=>{
 const pg=new PGlite(),db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}},pool={...db,connect:async()=>db},app=Fastify();
 const person=randomUUID(),other=randomUUID(),org=randomUUID(),position=randomUUID();let actor=person,allowed=true,installs=0,lostReply=true;
 try{
 await initializePlatformDatabase(db);
 await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,status,created_at,updated_at) VALUES($1,'t','Team','workgroup','active',now(),now())",[org]);
 await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'p','Position','active',now(),now())",[position]);
 for(const id of [person,other])await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,'Member',$2,$3,'active',now(),now())",[id,org,position]);
 const origin='http://127.0.0.1:3102',adminOrigin='https://admin.example.test';
 const account={id:randomUUID(),username:'admin',displayName:'Admin'};
 const identity={authenticate:async(token?:string)=>token==='admin-session'?account:null} as never;
 await app.register(cookie);
 const resolveAdmin=(req:Parameters<typeof createAdministratorContext>[0])=>createAdministratorContext(req,identity);
 const writeInstallation=async(id:string,appId:string,revision:number,version:string)=>{
  const record={id,appId,revision,enabled:true,manifest:{name:'灭火器巡检',version},grants:[],serviceIdentityId:null,credentialDigest:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await pg.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,$3,$4) ON CONFLICT(app_id) DO UPDATE SET revision=excluded.revision,record=excluded.record',[id,appId,revision,JSON.stringify(record)]);
 };
 let beforeClaim:(()=>Promise<void>)|undefined;
 const management={
  previewPackage:async(_context:unknown,bytes:Uint8Array)=>({sha256:inspectMopkg(bytes).sha256,installable:true}),
  installPackage:async(_context:unknown,bytes:Uint8Array,claim:()=>Promise<void>)=>{
   await beforeClaim?.();
   await claim();
   installs++;
   if(lostReply)throw Error('lost reply');
   const manifest=inspectMopkg(bytes).manifest!;
   const [installed]=(await pg.query<{id:string;revision:number}>('SELECT id,revision FROM platform_app_installations WHERE app_id=$1',[manifest.id])).rows;
   await writeInstallation(installed?.id??randomUUID(),manifest.id,(installed?.revision??0)+1,manifest.version);
   return {state:installed?'updated':'installed'};
  }
 } as never;
 registerAppSubmissionRoutes(app,{pool,origin,adminOrigin,employee:{resolveIdentity:async()=>{if(!allowed)throw new EmployeeIdentityError(401,'AUTH_REQUIRED');return {userId:actor};}} as never,resolveAdmin,management});
 await registerRegistrationRoutes(app,{pool,origin,adminOrigin,resolveAdmin});
 await registerAdminConsoleRoutes(app,{pool,origin:adminOrigin,identity,management});
 const requestId=randomUUID(),bundle={requestId,package:mopkg},headers={cookie:ADMIN_SESSION_COOKIE+'=admin-session'};
 const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:url.startsWith('/api/admin/')?{...headers,origin:adminOrigin}:{origin},payload});
 const get=(url:string)=>app.inject({url,headers});
 const notifications=async()=>{
  const response=await get('/api/admin/notifications');
  assert.equal(response.statusCode,200,response.body);
  return response.json();
 };
 allowed=false;assert.equal((await post('/api/employee/app-submissions',{kind:'new',...bundle})).statusCode,401);allowed=true;
 assert.equal((await app.inject({method:'POST',url:'/api/employee/app-submissions',payload:{}})).statusCode,403);
 const first=await post('/api/employee/app-submissions',{kind:'new',...bundle});assert.equal(first.statusCode,200,first.body);const id=first.json().id;
 assert.equal((await post('/api/employee/app-submissions',{kind:'new',...bundle})).json().id,id);
 assert.equal((await post('/api/employee/app-submissions',{kind:'update',...bundle})).statusCode,409);
 actor=other;assert.deepEqual((await app.inject('/api/employee/app-submissions')).json().submissions,[]);actor=person;
 assert.equal((await post('/api/employee/app-submissions',{kind:'new',...bundle,requestId:randomUUID()})).json().id,id);
 assert.equal((await app.inject('/api/admin/app-submissions')).statusCode,401);
 assert.equal((await app.inject('/api/admin/notifications')).statusCode,401);
 const registration=await post('/api/auth/registration',{employeeNo:'new-user',name:'新员工',organizationId:org,password:'Employee-fixture-123'});
 assert.equal(registration.statusCode,200,registration.body);
 const reg=(await get('/api/admin/registrations')).json().applications[0];
 const pending=await notifications();
 assert.equal(pending.total,2);
 assert.deepEqual(pending.notifications.map((item:{path:string})=>item.path),[
  '/admin/apps/submissions?submission='+id,'/admin/accounts/registrations'
 ]);
 assert.match(pending.notifications[0].title,/上架申请/);
 assert.doesNotMatch(JSON.stringify(pending),/password|Employee-fixture|package_bytes/);
 const item=(await get('/api/admin/app-submissions?submission='+id)).json().selected;
 assert.equal(item.submittedBy,'Member');
 const digest=(await post(`/api/admin/app-submissions/${id}/preview`,{})).json().sha256;
 assert.equal((await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest:'wrong'})).statusCode,409);
 const outcome=await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest});assert.equal(outcome.json().status,'uncertain',outcome.body);assert.equal(installs,1);
 assert.equal((await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest})).statusCode,409);assert.equal(installs,1);
 assert.equal((await post(`/api/admin/app-submissions/${id}/preview`,{})).statusCode,409);
 assert.equal((await notifications()).total,1);
 assert.equal((await post('/api/admin/registrations/'+reg.id+'/review',{decision:'approve',organizationId:org,positionId:position})).statusCode,200);
 assert.equal((await notifications()).total,0);

 lostReply=false;
 const newRequest=await post('/api/employee/app-submissions',{kind:'new',requestId:randomUUID(),package:packageFor('another-app')});
 assert.equal(newRequest.statusCode,200,newRequest.body);
 const newId=newRequest.json().id,newItem=(await get('/api/admin/app-submissions?submission='+newId)).json().selected;
 assert.equal((await get('/api/admin/apps/another-app')).statusCode,404);
 const newPreview=(await post('/api/admin/app-submissions/'+newId+'/preview',{})).json();
 assert.equal((await post('/api/admin/app-submissions/'+newId+'/review',{revision:newItem.revision,decision:'approve',digest:newPreview.sha256})).json().status,'completed');
 const installed=(await get('/api/admin/apps/another-app')).json();
 await pg.query('INSERT INTO platform_app_authorization(installation_id,owner_person_id,revision) VALUES($1,$2,$3)',[installed.id,person,randomUUID()]);
 const updatePackage=packageFor('another-app','1.1.0');
 actor=other;
 assert.equal((await post('/api/employee/app-submissions',{kind:'update',requestId:randomUUID(),package:updatePackage})).statusCode,403);
 actor=person;
 const submitUpdate=(appId='another-app')=>post('/api/employee/app-submissions',{kind:'update',appId,requestId:randomUUID(),package:updatePackage});
 assert.equal((await submitUpdate('wrong-app')).statusCode,400);
 const update=await submitUpdate();assert.equal(update.statusCode,200,update.body);
 const updateId=update.json().id,updatePath='/api/admin/app-submissions/'+updateId;
 const retryUpload={kind:'update',appId:'another-app',requestId:randomUUID(),package:updatePackage};
 assert.equal((await post('/api/employee/app-submissions',retryUpload)).json().id,updateId);
 const updateItem=(await get('/api/admin/app-submissions?submission='+updateId)).json().selected;
 assert.equal(updateItem.kind,'update');
 assert.equal((await get('/api/admin/apps/another-app')).json().manifest.version,'1.0.0');
 assert.match((await notifications()).notifications[0].title,/更新申请/);
 const updatePreview=(await post(updatePath+'/preview',{})).json();
 beforeClaim=()=>writeInstallation(installed.id,'another-app',installed.revision+1,'1.0.1');
 const stale=await post(updatePath+'/review',{revision:updateItem.revision,decision:'approve',digest:updatePreview.sha256});
 assert.equal(stale.statusCode,409,stale.body);assert.equal(stale.json().error,'SUBMISSION_TARGET_CHANGED');
 assert.equal((await notifications()).total,1);
 beforeClaim=undefined;
 assert.equal((await post(updatePath+'/review',{revision:updateItem.revision,decision:'reject',reason:'请基于新版本重新提交'})).json().status,'rejected');
 assert.equal((await notifications()).total,0);
 assert.equal((await post('/api/employee/app-submissions',retryUpload)).json().id,updateId);
 assert.equal((await post('/api/employee/app-submissions',{...retryUpload,package:packageFor('another-app','1.2.0')})).statusCode,409);
 const rejected=(await get('/api/employee/app-submissions')).json().submissions.find((item:{id:string})=>item.id===updateId);
 assert.equal(rejected.reason,'请基于新版本重新提交');
 const retried=await submitUpdate();assert.equal(retried.statusCode,200,retried.body);
 const retriedId=retried.json().id,retriedItem=(await get('/api/admin/app-submissions?submission='+retriedId)).json().selected;
 assert.equal((await post('/api/admin/app-submissions/'+retriedId+'/review',{revision:retriedItem.revision,decision:'approve',digest:updatePreview.sha256})).json().status,'completed');
 assert.equal((await get('/api/admin/apps/another-app')).json().manifest.version,'1.1.0');
 assert.equal(installs,3);
 assert.equal((await notifications()).total,0);

 }finally{await app.close();await pg.close();}
});
