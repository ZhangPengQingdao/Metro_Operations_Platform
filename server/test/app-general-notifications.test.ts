import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {registerEmployeeRoutes} from '../src/app-platform/employee/routes.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {createNotificationGatewayOperations} from '../src/app-platform/gateway/notifications.ts';
import {EmployeeIdentityService} from '../src/platform/employee-identity/index.ts';
import type {GatewayActorContext} from '../src/app-platform/gateway/model.ts';

test('general notifications bind source and routes, enforce recipients and preserve signature behavior',async()=>{
 const pg=new PGlite();const db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}};const pool={...db,connect:async()=>db};
 try{
 await initializePlatformDatabase(db);
 const org=randomUUID(),position=randomUUID(),person=randomUUID(),other=randomUUID(),inactive=randomUUID();
 await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,status,created_at,updated_at) VALUES($1,'team','Team','workgroup','active',now(),now())",[org]);
 await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'worker','Worker','active',now(),now())",[position]);
 for(const id of [person,other,inactive])await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,'Person',$2,$3,$4,now(),now())",[id,org,position,id===inactive?'inactive':'active']);
 const manifest={id:'demo',name:'Demo',ui:{mode:'sandbox'},routes:[{id:'home',path:'/'},{id:'records',path:'/Records_1'}]};
 const installationId=randomUUID();
 await pg.query('INSERT INTO platform_app_installations(id,app_id,revision,record) VALUES($1,$2,1,$3)',[installationId,'demo',JSON.stringify({id:installationId,appId:'demo',revision:1,enabled:true,manifest,grants:[],serviceIdentityId:null,credentialDigest:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})]);
 const allow=async()=>({allowed:true});
 const context={actorType:'service',execution:{type:'service',appId:'demo',serviceIdentityId:randomUUID()},request:{requestId:randomUUID(),traceId:randomUUID(),startedAt:new Date().toISOString()},authorize:allow,authorizeApplication:allow,employeeActor:{actorType:'person',person:{id:person},execution:{type:'application',appId:'demo'}}} as unknown as GatewayActorContext;
 const ops=createNotificationGatewayOperations(pool),publish=ops.find(op=>op.name.endsWith('.publish'))!,legacy=ops.find(op=>op.name.endsWith('.create'))!,cancel=ops.find(op=>op.name.endsWith('.cancel'))!;
 const input={id:randomUUID(),entityType:'record',entityId:randomUUID(),personIds:[person],title:'Changed',body:'Please check',routeId:'records'};
 const invoke=(op:typeof publish,p:unknown,c=context)=>op.execute(c,p,new AbortController().signal);
 assert.equal(publish.validateParams(input),true);
 for(const p of [{...input,appId:'other'},{...input,url:'https://example.com'},{...input,personIds:[person,person]},{...input,personIds:[]}])assert.equal(publish.validateParams(p),false);
 await assert.rejects(invoke(publish,{...input,routeId:'missing'}),/INVALID_PARAMS/);
 await assert.rejects(invoke(publish,{...input,personIds:[inactive]}));
 await assert.rejects(invoke(publish,input,{...context,employeeActor:undefined}),/ACCESS_DENIED/);
 await assert.rejects(invoke(publish,input,{...context,authorize:async()=>({allowed:false})} as any));
 assert.deepEqual(await invoke(publish,input),{id:input.id});
 const row=(await pg.query<any>('SELECT * FROM platform_notifications WHERE id=$1',[input.id])).rows[0];
 assert.equal(row.source_app_id,'demo');assert.equal(row.source_entity_type,'record');assert.equal(row.category,'application');assert.equal(row.read_behavior,'mark_read');assert.equal(row.navigation_ref.href,'/employee/app/demo/Records_1');
 assert.deepEqual(await invoke(publish,input),{id:input.id});
 await assert.rejects(invoke(publish,{...input,body:'Different'}));
 const identity=new EmployeeIdentityService(pool);
 const admin={actorType:'administrator',administrator:{id:randomUUID()},execution:{type:'platform'},authorize:allow} as any;
 await identity.create(admin,{personId:person,username:'recipient',password:'Notification-test-123'});
 await identity.create(admin,{personId:other,username:'outsider',password:'Notification-test-123'});
 const session=await identity.login({username:'recipient',password:'Notification-test-123'}),outside=await identity.login({username:'outsider',password:'Notification-test-123'});
 await assert.rejects(identity.markNotificationRead(outside.token,input.id),/NOTIFICATION_ACCESS_DENIED/);
 const http=Fastify();await http.register(cookie);registerEmployeeRoutes(http,{origin:'https://platform.example',service:identity,resolveAdmin:async()=>{throw Error('ADMIN_DENIED');}});
 try{
  const url=`/api/employee/notifications/${input.id}/read`;
  assert.equal((await http.inject({method:'POST',url,headers:{origin:'https://platform.example'}})).statusCode,401);
  assert.equal((await http.inject({method:'POST',url,headers:{origin:'https://evil.example',cookie:`mop_employee_session=${session.token}`}})).statusCode,403);
  assert.equal((await http.inject({method:'POST',url,headers:{origin:'https://platform.example',cookie:`mop_employee_session=${outside.token}`}})).statusCode,403);
  const response=await http.inject({method:'POST',url,headers:{origin:'https://platform.example',cookie:`mop_employee_session=${session.token}`}});assert.equal(response.statusCode,200,response.body);assert.ok(response.json().readAt);
 }finally{await http.close();}
 const read=await identity.markNotificationRead(session.token,input.id);assert.ok(read.readAt);
 assert.equal((await identity.notifications(session.token)).notifications.length,1);
 assert.equal((await identity.notifications(outside.token)).notifications.length,0);
 const old={id:randomUUID(),entityId:randomUUID(),personId:person,title:'Sign',body:'Please sign'};
 await invoke(legacy,old);await assert.rejects(identity.markNotificationRead(session.token,old.id),/NOTIFICATION_STATE_BOUND/);
 await assert.rejects(invoke(cancel,{id:input.id},{...context,execution:{...context.execution,appId:'other'},employeeActor:{...context.employeeActor!,execution:{type:'application',appId:'other'}}} as any),/ACCESS_DENIED/);
 await invoke(cancel,{id:input.id});assert.equal((await identity.notifications(session.token)).notifications.length,1);
 await pg.query("UPDATE platform_app_installations SET record=jsonb_set(record,'{enabled}','false') WHERE app_id='demo'");
 await assert.rejects(invoke(publish,{...input,id:randomUUID()}),/ACCESS_DENIED/);
 }finally{await pg.close();}
});
