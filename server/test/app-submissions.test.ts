import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {createMopkg} from '@metro/platform-sdk/mopkg';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {registerAppSubmissionRoutes} from '../src/app-platform/submissions/routes.ts';
import {EmployeeIdentityError} from '../src/platform/employee-identity/index.ts';
const encoder=new TextEncoder();
const app_json=JSON.stringify({id:'fire-check',name:'灭火器巡检',version:'1.0.0',description:'按车站巡检灭火器',color:'#e5484d',platform:'>=0.26.0',permissions:[{code:'read',name:'查看'}],pages:[{path:'/',title:'任务',permission:'read',nav:true}],api:[]});
const mopkg=Buffer.from(createMopkg([{path:'app.json',data:encoder.encode(app_json)},{path:'icon.svg',data:encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>')},{path:'ui.js',data:encoder.encode('export default {};')}])).toString('base64');
test('submissions isolate applicants, bind approval and never replay uncertain installs',async()=>{
 const pg=new PGlite(),db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}},pool={...db,connect:async()=>db},app=Fastify();
 const person=randomUUID(),other=randomUUID(),org=randomUUID(),position=randomUUID();let actor=person,allowed=true,installs=0;
 try{
 await initializePlatformDatabase(db);
 await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,status,created_at,updated_at) VALUES($1,'t','Team','workgroup','active',now(),now())",[org]);
 await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'p','Position','active',now(),now())",[position]);
 for(const id of [person,other])await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,'Member',$2,$3,'active',now(),now())",[id,org,position]);
 app.decorateRequest('cookies',null);app.addHook('onRequest',async req=>{req.cookies={}});
 const context={actorType:'administrator',administrator:{id:randomUUID()},execution:{type:'platform'},authorize:async()=>({allowed:true})};
 registerAppSubmissionRoutes(app,{pool,origin:'http://127.0.0.1:3102',employee:{resolveIdentity:async()=>{if(!allowed)throw new EmployeeIdentityError(401,'AUTH_REQUIRED');return {userId:actor}}} as never,resolveAdmin:async()=>context as never,management:{previewPackage:async()=>({sha256:'verified',installable:true}),installPackage:async()=>{installs++;throw Error('lost reply')}} as never});
 const requestId=randomUUID(),bundle={requestId,package:mopkg};
 const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{origin:'http://127.0.0.1:3102'},payload});
 allowed=false;assert.equal((await post('/api/employee/app-submissions',{kind:'new',...bundle})).statusCode,401);allowed=true;
 assert.equal((await app.inject({method:'POST',url:'/api/employee/app-submissions',payload:{}})).statusCode,403);
 const first=await post('/api/employee/app-submissions',{kind:'new',...bundle});assert.equal(first.statusCode,200,first.body);const id=first.json().id;
 assert.equal((await post('/api/employee/app-submissions',{kind:'new',...bundle})).json().id,id);
 assert.equal((await post('/api/employee/app-submissions',{kind:'update',...bundle})).statusCode,409);
 actor=other;assert.deepEqual((await app.inject('/api/employee/app-submissions')).json().submissions,[]);actor=person;
 const item=(await app.inject('/api/admin/app-submissions')).json().submissions[0];
 assert.equal((await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest:'wrong'})).statusCode,409);
 const outcome=await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest:'verified'});assert.equal(outcome.json().status,'uncertain',outcome.body);assert.equal(installs,1);
 assert.equal((await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest:'verified'})).statusCode,409);assert.equal(installs,1);
 assert.equal((await post(`/api/admin/app-submissions/${id}/preview`,{})).statusCode,409);
 }finally{await app.close();await pg.close();}
});
