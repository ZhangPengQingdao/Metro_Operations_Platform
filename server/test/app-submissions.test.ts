import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {registerAppSubmissionRoutes} from '../src/app-platform/submissions/routes.ts';
import {encodeInstallPackage} from '../src/app-platform/install/wire.ts';
import {EmployeeIdentityError} from '../src/platform/employee-identity/index.ts';
test('submissions isolate applicants, bind approval and never replay uncertain installs',async()=>{
 const pg=new PGlite(),db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}},pool={...db,connect:async()=>db},app=Fastify();
 const root=await mkdtemp(join(tmpdir(),'submission-test-')),person=randomUUID(),other=randomUUID(),org=randomUUID(),position=randomUUID();let actor=person,allowed=true,installs=0;
 try{
 await initializePlatformDatabase(db);
 await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,status,created_at,updated_at) VALUES($1,'t','Team','workgroup','active',now(),now())",[org]);
 await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'p','Position','active',now(),now())",[position]);
 for(const id of [person,other])await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,'Member',$2,$3,'active',now(),now())",[id,org,position]);
 app.decorateRequest('cookies',null);app.addHook('onRequest',async req=>{req.cookies={}});
 const context={actorType:'administrator',administrator:{id:randomUUID()},execution:{type:'platform'},authorize:async()=>({allowed:true})};
 registerAppSubmissionRoutes(app,{pool,origin:'http://127.0.0.1:3102',employee:{resolveIdentity:async()=>{if(!allowed)throw new EmployeeIdentityError(401,'AUTH_REQUIRED');return {userId:actor}}} as never,resolveAdmin:async()=>context as never,management:{uploadRoot:root,previewPackage:async()=>({digest:'verified',policyRevision:1,supported:true,compatible:true}),approvePackage:async()=>{},install:async()=>{installs++;throw Error('lost reply')}} as never});
 const signature=join(root,'signature.json');await writeFile(signature,'{}');const bundle=await encodeInstallPackage(new URL('../../examples/app-sdk/dist/sandbox/',import.meta.url).pathname,signature,randomUUID());
 const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,headers:{origin:'http://127.0.0.1:3102'},payload});
 allowed=false;assert.equal((await post('/api/employee/app-submissions',{kind:'new',package:bundle})).statusCode,401);allowed=true;
 assert.equal((await app.inject({method:'POST',url:'/api/employee/app-submissions',payload:{}})).statusCode,403);
 const first=await post('/api/employee/app-submissions',{kind:'new',package:bundle});assert.equal(first.statusCode,200,first.body);const id=first.json().id;
 assert.equal((await post('/api/employee/app-submissions',{kind:'new',package:bundle})).json().id,id);
 assert.equal((await post('/api/employee/app-submissions',{kind:'update',package:bundle})).statusCode,409);
 actor=other;assert.deepEqual((await app.inject('/api/employee/app-submissions')).json().submissions,[]);actor=person;
 const item=(await app.inject('/api/admin/app-submissions')).json().submissions[0];
 assert.equal((await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest:'wrong',policyRevision:1})).statusCode,409);
 const outcome=await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest:'verified',policyRevision:1});assert.equal(outcome.json().status,'uncertain',outcome.body);assert.equal(installs,1);
 assert.equal((await post(`/api/admin/app-submissions/${id}/review`,{revision:item.revision,decision:'approve',digest:'verified',policyRevision:1})).statusCode,409);assert.equal(installs,1);
 assert.equal((await post(`/api/admin/app-submissions/${id}/preview`,{})).statusCode,409);
 }finally{await app.close();await pg.close();await rm(root,{recursive:true,force:true})}
});
