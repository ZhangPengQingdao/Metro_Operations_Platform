import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {TrustedActorIdentity} from '../../core/identity/index.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
import type {PlatformActorContext} from '../../platform/context/index.js';
import {isAppVersionInRange} from '../manifest/index.js';
import type {AppInstallation} from '../registry/model.js';
import {AppStdioApiError} from '../runtime/stdio-api.js';
import {GatewayError,type AppGatewayOperation,type GatewayActorContext,type GatewayJson} from './model.js';

const appId=z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const apiId=z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const input=z.object({appId,apiId,params:z.unknown()}).strict();

export interface AppCapabilityOperationOptions {
 getInstallation(appId:string):Promise<AppInstallation|null>;
 assertEmployeeAccess(appId:string,personId:string):Promise<unknown>;
 isPublished(installation:AppInstallation,apiId:string):Promise<boolean>;
 resolveEmployee(identity:TrustedActorIdentity,appId:string,requestId:string,traceId:string):Promise<PlatformActorContext>;
 invokeTarget(appId:string,actor:PlatformActorContext,request:{apiId:string;method:string;path:string;payload:GatewayJson},signal:AbortSignal,assertAdmission:()=>Promise<void>):Promise<GatewayJson>;
}

/** A signed source declaration, live service grant and target employee role must all agree. */
export function createAppCapabilityOperation(options:AppCapabilityOperationOptions):AppGatewayOperation {
 const bound=(context:GatewayActorContext)=>{
  if(context.actorType!=='service'||context.execution.type!=='service'||!context.employeeActor||
    context.employeeActor.actorType!=='person'||context.employeeActor.execution.type!=='application'||
    context.employeeActor.execution.appId!==context.execution.appId)
   throw new GatewayError('ACCESS_DENIED',403);
  return {sourceId:context.execution.appId,employee:context.employeeActor};
 };
 return {
  name:'platform.apps.invoke',permissionCode:'platform.apps.invoke',mode:'write',
  validateParams:value=>input.safeParse(value).success&&Object.prototype.hasOwnProperty.call(value,'params'),
  auditMetadata:value=>{const params=input.parse(value);return {targetAppId:params.appId,apiId:params.apiId};},
  resolveResources:async context=>{bound(context);return [{}];},
  async execute(context,value,signal){
   const {sourceId,employee}=bound(context),request=input.parse(value);
   if(sourceId===request.appId)throw new GatewayError('OPERATION_DENIED',403);
   const [source,target]=await Promise.all([options.getInstallation(sourceId),options.getInstallation(request.appId)]);
   if(!source?.enabled||!target?.enabled)throw new GatewayError('OPERATION_DENIED',403);
   const dependency=source.manifest.compatibility.applications.find(app=>app.id===request.appId);
   const api=target.manifest.api.find(entry=>entry.id===request.apiId&&entry.expose);
   if(!dependency||!isAppVersionInRange(target.manifest.version,dependency.version)||!api?.expose||
      !api.businessPermission||!source.manifest.permissions.requested.includes(api.businessPermission))
    throw new GatewayError('OPERATION_DENIED',403);
   if(!(await options.isPublished(target,api.id)))throw new GatewayError('APP_CAPABILITY_NOT_PUBLISHED',403);
   const assertAdmission=async()=>{
    if(signal.aborted)throw new GatewayError('ABORTED',499);
    const [freshSource,freshTarget]=await Promise.all([options.getInstallation(sourceId),options.getInstallation(request.appId)]);
    if(!freshSource?.enabled||!freshTarget?.enabled||freshSource.id!==source.id||freshTarget.id!==target.id||
       freshSource.revision!==source.revision||freshTarget.revision!==target.revision||
       !isDeepStrictEqual(freshSource.manifest,source.manifest)||!isDeepStrictEqual(freshTarget.manifest,target.manifest))
     throw new GatewayError('ACCESS_DENIED',403);
    if(!(await context.authorize('platform.apps.invoke',{})).allowed)throw new GatewayError('ACCESS_DENIED',403);
    if(!(await options.isPublished(freshTarget,api.id)))throw new GatewayError('APP_CAPABILITY_NOT_PUBLISHED',403);
    try{await options.assertEmployeeAccess(request.appId,employee.person.id);}
    catch(error){if(error instanceof EmployeeIdentityError&&error.code==='EMPLOYEE_APP_ACCESS_DENIED')throw new GatewayError('TARGET_APP_ACCESS_DENIED',403);throw error;}
    if(signal.aborted)throw new GatewayError('ABORTED',499);
   };
   await assertAdmission();
   const targetActor=await options.resolveEmployee(employee.trustedIdentity,request.appId,context.request.requestId,context.request.traceId);
   if(targetActor.actorType!=='person'||targetActor.person.id!==employee.person.id||
      targetActor.execution.type!=='application'||targetActor.execution.appId!==request.appId)
    throw new GatewayError('ACCESS_DENIED',403);
   await assertAdmission();
   let result:GatewayJson;
   try{result=await options.invokeTarget(request.appId,targetActor,{apiId:api.id,method:api.method,path:api.path,payload:request.params as GatewayJson},signal,assertAdmission);}
   catch(error){if(error instanceof AppStdioApiError&&error.code==='ACCESS_DENIED')throw new GatewayError('TARGET_APP_ACCESS_DENIED',403,error.writeOutcome);throw error;}
   await assertAdmission();
   return result;
  },
  validateResult:()=>true,
 };
}
