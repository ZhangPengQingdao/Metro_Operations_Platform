import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readEmployeeNavigation} from '../src/app-platform/employee/navigation.ts';
import {initializePlatformDatabase} from '../src/setup/schema.ts';
import {AppBusinessAuthorization} from '../src/app-platform/business-authorization/service.ts';
import {createManagementApiAuthorization} from '../src/app-platform/management/gateway.ts';
import {AppRegistryService,PostgresAppRegistryRepository} from '../src/app-platform/registry/index.ts';
import {createPostgresAuthorizationRepository} from '../src/platform/authorization/index.ts';
import {demoManifest} from '../../src/app-platform/samples/host-demo/manifest.ts';
import type {PlatformAdministratorContext} from '../src/platform/context/index.ts';

const manifest={routes:[{id:'items',path:'/',permission:'app.huicetong.read'},{id:'bindings',path:'/bindings',permission:'app.huicetong.manage'}],navigation:[{id:'items',routeId:'items',label:'计划提报',order:0},{id:'bindings',routeId:'bindings',label:'基础配置',order:1}]};

test('employee catalog removes both management navigation and its route without manage permission',async()=>{
 const result=await readEmployeeNavigation(manifest,async permission=>permission==='app.huicetong.read');
 assert.deepEqual(result.routes,[manifest.routes[0]]);
 assert.deepEqual(result.navigation,[manifest.navigation[0]]);
 assert.equal(result.routes.some(route=>route.path==='/bindings'),false);
 assert.deepEqual(await readEmployeeNavigation(manifest,async()=>true),manifest);
 assert.deepEqual(await readEmployeeNavigation(manifest,async()=>false),{routes:[],navigation:[]});
});

test('unrestricted legacy routes remain, shared permissions are checked once, and errors fail closed',async()=>{
 const current={routes:[...manifest.routes,{id:'second',path:'/second',permission:'app.huicetong.read'},{id:'public',path:'/public'}],navigation:[...manifest.navigation,{id:'public',routeId:'public',label:'公开入口',order:2},{id:'orphan',routeId:'missing',label:'不存在',order:3}]};
 const calls:string[]=[];
 const result=await readEmployeeNavigation(current,async permission=>{calls.push(permission);return permission==='app.huicetong.read';});
 assert.deepEqual(calls,['app.huicetong.read','app.huicetong.manage']);
 assert.deepEqual(result.routes.map(route=>route.id),['items','second','public']);
 assert.deepEqual(result.navigation.map(item=>item.id),['items','public']);
 await assert.rejects(readEmployeeNavigation(manifest,async()=>{throw Error('authorization unavailable');}),/authorization unavailable/);
});

test('real scoped business authorization filters navigation and reflects manage grant removal',async()=>{
 const pg=new PGlite(),db={query:async(sql:string,args?:readonly unknown[])=>args?pg.query(sql,[...args]):(await pg.exec(sql)).at(-1)!,release(){}},pool={...db,connect:async()=>db};
 try{
  await initializePlatformDatabase(db);
  const team=randomUUID(),position=randomUUID(),owner=randomUUID(),member=randomUUID();
  await pg.query("INSERT INTO platform_organization_units(id,code,name,unit_type,status,created_at,updated_at) VALUES($1,'nav-team','Team','workgroup','active',now(),now())",[team]);
  await pg.query("INSERT INTO platform_positions(id,code,name,status,created_at,updated_at) VALUES($1,'nav-worker','Worker','active',now(),now())",[position]);
  for(const id of [owner,member])await pg.query("INSERT INTO platform_people(id,employee_no,name,organization_unit_id,position_id,employment_status,created_at,updated_at) VALUES($1::uuid,$1::text,$1::text,$2,$3,'active',now(),now())",[id,team,position]);
  const context:PlatformAdministratorContext={actorType:'administrator',administrator:{id:randomUUID(),username:'admin',displayName:'Admin'},execution:{type:'platform'},request:{requestId:'nav-test',traceId:'nav-test',startedAt:new Date().toISOString()},authorize:async permissionCode=>({id:'t',allowed:true,reasonCode:'allowed',permissionCode,subjectType:'administrator',effectiveScopes:[],decidedAt:new Date().toISOString()})};
  const app=structuredClone(demoManifest),read=app.permissions.defined[0].code,manage=`app.${app.id}.manage`;
  app.permissions.defined[0].scopeKinds=['workgroup'];
  app.permissions.defined.push({code:manage,description:'Manage',scopeKinds:['workgroup']});
  app.routes=[{id:'items',path:'/',permission:read},{id:'bindings',path:'/bindings',permission:manage}];
  app.navigation=structuredClone(manifest.navigation);
  const registry=new AppRegistryService(new PostgresAppRegistryRepository(db),{authorization:createPostgresAuthorizationRepository(db),host:()=>({platformVersion:'0.23.6',capabilities:[],applications:[]})});
  let installation=await registry.register(context,app);installation=await registry.setEnabled(context,app.id,installation.revision,true);
  const business=new AppBusinessAuthorization(pool);
  await business.setOwner(context,app.id,{personId:owner,revision:null});
  let state=await business.snapshot(app.id,owner);
  state=await business.change(app.id,owner,{action:'role',revision:state.revision,name:'Scoped employee',status:'active',rules:[{permission:read,scope:'workgroup',organizationIds:[]}]});
  const role=(state.roles[0] as {id:string}).id;
  state=await business.change(app.id,owner,{action:'member',revision:state.revision,personId:member,roleId:role,enabled:true});
  state=await business.change(app.id,owner,{action:'activate',revision:state.revision,confirm:true});
  const authorization=createManagementApiAuthorization(pool);
  const navigation=async()=>{
   authorization.clearSessions();
   const actor=await authorization.contextResolver.resolve({actorType:'person',trustedIdentity:{source:'session',userId:member},execution:{type:'application',appId:app.id},requestId:'nav-test',traceId:'nav-test'});
   return readEmployeeNavigation(app,permission=>authorization.authorize(actor,permission));
  };
  assert.deepEqual((await navigation()).navigation.map(item=>item.id),['items']);
  state=await business.change(app.id,owner,{action:'role',revision:state.revision,id:role,name:'Scoped manager',status:'active',rules:[read,manage].map(permission=>({permission,scope:'workgroup',organizationIds:[]}))});
  assert.deepEqual((await navigation()).navigation.map(item=>item.id),['items','bindings']);
  state=await business.change(app.id,owner,{action:'role',revision:state.revision,id:role,name:'Scoped employee',status:'active',rules:[{permission:read,scope:'workgroup',organizationIds:[]}]});
  assert.deepEqual((await navigation()).routes.map(route=>route.path),['/']);
 }finally{await pg.close();}
});
