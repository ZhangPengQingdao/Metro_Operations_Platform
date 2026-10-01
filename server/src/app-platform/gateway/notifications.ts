import {z} from 'zod';
import {runDatabaseTransaction,type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {createNotificationService,createPostgresNotificationRepository} from '../../platform/notifications/index.js';
import {GatewayError,type AppGatewayOperation,type GatewayActorContext} from './model.js';
import type {AppManifest} from '@metro/platform-sdk/app-manifest';

const uuid=z.string().uuid();
const create=z.object({
 id:uuid,entityId:uuid,personId:uuid,title:z.string().trim().min(1).max(160),body:z.string().trim().min(1).max(1000)
}).strict();
const cancel=z.object({id:uuid}).strict();
const publish=z.object({
 id:uuid,entityType:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),entityId:uuid,
 personIds:z.array(uuid).min(1).max(50).refine(ids=>new Set(ids).size===ids.length),
 title:z.string().trim().min(1).max(160),body:z.string().trim().min(1).max(1000),
 routeId:z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64).optional(),
}).strict();

/** Applications can create and retire only their own, person-targeted in-app reminders. */
export function createNotificationGatewayOperations(pool:ConnectablePool&QueryableClient):AppGatewayOperation[]{
 const bound=(context:GatewayActorContext)=>{
  if(context.actorType!=='service'||context.execution.type!=='service'||!context.employeeActor||
   context.employeeActor.execution.type!=='application'||context.employeeActor.execution.appId!==context.execution.appId)
   throw new GatewayError('ACCESS_DENIED',403);
  return context.execution.appId;
 };
 const service=(client:QueryableClient)=>{
  const people=createPostgresPeopleDirectoryRepository(client);
  return createNotificationService(createPostgresNotificationRepository(client),{
   findPerson:id=>people.findPersonById(id),findOrganizationUnit:id=>people.findOrganizationUnitById(id),
   listActiveOrganizationMembers:async()=>[]
  });
 };
 return [
  {name:'platform.notifications.create',permissionCode:'platform.notifications.create',mode:'write',
   validateParams:value=>create.safeParse(value).success,resolveResources:async context=>{bound(context);return [{}];},
   async execute(context,value,signal){
    const appId=bound(context),p=create.parse(value);
    if(signal.aborted)throw new GatewayError('ABORTED');
    const client=await pool.connect();
    try{return await runDatabaseTransaction(client,async()=>{
     const created=await service(client).createNotification(context,{id:p.id,source:{appId,entityType:'signature',entityId:p.entityId},
      notificationKey:`signature:${p.entityId}:${p.personId}`,idempotencyKey:p.id,category:'signature',readBehavior:'state_bound',
      display:{title:p.title,body:p.body,severity:'normal',sourceLabel:'在线签字'},
      navigation:{href:`/employee/app/${appId}/sign?task=${p.entityId}`,routeName:null,params:{}},recipients:[{recipientType:'person',recipientId:p.personId}],channels:['in_app']});
     if(signal.aborted)throw new GatewayError('ABORTED');return {id:created.id};
    });}finally{client.release();}
   },validateResult:value=>!!value&&typeof value==='object'&&uuid.safeParse((value as {id?:unknown}).id).success},
  {name:'platform.notifications.cancel',permissionCode:'platform.notifications.manage',mode:'write',
   validateParams:value=>cancel.safeParse(value).success,resolveResources:async context=>{bound(context);return [{}];},
   async execute(context,value,signal){
    const appId=bound(context),p=cancel.parse(value);
    if(signal.aborted)throw new GatewayError('ABORTED');
    const client=await pool.connect();
    try{return await runDatabaseTransaction(client,async()=>{
     const repo=createPostgresNotificationRepository(client),existing=await repo.findNotificationById(p.id);
     if(!existing||existing.sourceAppId!==appId||!['signature','application'].includes(existing.category??''))throw new GatewayError('ACCESS_DENIED',403);
     await service(client).cancelNotification(context,{notificationId:p.id});
     if(signal.aborted)throw new GatewayError('ABORTED');return {cancelled:true};
    });}finally{client.release();}
   },validateResult:value=>!!value&&typeof value==='object'&&(value as {cancelled?:unknown}).cancelled===true},
  {name:'platform.notifications.publish',permissionCode:'platform.notifications.create',mode:'write',
   validateParams:value=>publish.safeParse(value).success,resolveResources:async context=>{bound(context);return [{}];},
   async execute(context,value,signal){
    const appId=bound(context),p=publish.parse(value);
    if(signal.aborted)throw new GatewayError('ABORTED');
    const client=await pool.connect();
    try{return await runDatabaseTransaction(client,async()=>{
     const found=await client.query('SELECT record FROM platform_app_installations WHERE app_id=$1',[appId]) as {rows:{record:{enabled:boolean;manifest:AppManifest}}[]};
     const installation=found.rows[0]?.record;
     if(!installation?.enabled)throw new GatewayError('ACCESS_DENIED',403);
     const route=p.routeId?installation.manifest.routes.find(route=>route.id===p.routeId):undefined;
     if(p.routeId&&(!route||installation.manifest.ui.mode==='none'))throw new GatewayError('INVALID_PARAMS');
     const created=await service(client).createNotification(context,{
      id:p.id,source:{appId,entityType:p.entityType,entityId:p.entityId},
      notificationKey:`application:${p.id}`,idempotencyKey:p.id,category:'application',readBehavior:'mark_read',
      display:{title:p.title,body:p.body,severity:'normal',sourceLabel:installation.manifest.name},
      navigation:route?{href:`/employee/app/${appId}${route.path==='/'?'':route.path}`,routeName:route.id,params:{}}:null,
      recipients:p.personIds.map(personId=>({recipientType:'person' as const,recipientId:personId})),channels:['in_app'],
     });
     if(signal.aborted)throw new GatewayError('ABORTED');return {id:created.id};
    });}finally{client.release();}
   },validateResult:value=>!!value&&typeof value==='object'&&uuid.safeParse((value as {id?:unknown}).id).success}
 ];
}
