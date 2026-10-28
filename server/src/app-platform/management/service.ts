import {AppToolService,type ToolBinding} from '../tools/index.js';
import {createToolOperations} from '../gateway/tools.js';
import {readEmployeeDashboard} from '../employee/dashboard.js';
import type {ChatCapability} from '../../platform/chat/index.js';
import type {AppAgentInput} from '@metro/platform-sdk/app-agent';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {PlatformMaintenance} from '../updates/maintenance.js';
import {getDatabasePool} from '../../core/database/index.js';
import {PLATFORM_CAPABILITY_CATALOG} from '@metro/platform-sdk';
import {getCoreConfig} from '../../core/config/index.js';
import {AppRegistryError,AppRegistryService,PostgresAppRegistryRepository} from '../registry/index.js';
import {type PlatformManagementContext} from '../../platform/context/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {createAuthorizationService,createPostgresAuthorizationRepository} from '../../platform/authorization/index.js';
import {loadAppManagementConfig,AppManagementError} from './config.js';
import {createManagementQueue} from './queue.js';
import {createManagementGateway,createManagementApiAuthorization} from './gateway.js';
import {GatewayError} from '../gateway/model.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
import {EmployeeAppAccess} from '../employee/access.js';
import {EmployeeAppSessions} from '../employee/app-session.js';
import {readEmployeeNavigation} from '../employee/navigation.js';
import {admitEmployeeApplication,employeeAdmissionKey,assertEmployeeAdmissionKey} from '../employee/admission.js';
import {bindEmployeeAttachmentActor} from '../employee/attachment-service.js';
import {AppDataServiceV2} from '../v2/data.js';
import {createAppRuntimeV2} from '../v2/runtime.js';
import {previewAppPackageV2,summarizeInstallation} from '../v2/preview.js';
import {devAdministratorContext,startDevAppsWatcher} from '../v2/dev.js';

type ResolveIdentity=Parameters<ReturnType<typeof createManagementGateway>['invokeDelegatedFromSession']>[1];

/** Application management: `.mopkg` installation, one child process per enabled app, and employee access to app pages and APIs. */
export async function createAppManagement(configFile:string,origin:string){
 const config=await loadAppManagementConfig(configFile);
 const pool=getDatabasePool();
 if(!pool)throw new AppManagementError('ADMIN_DATABASE_UNAVAILABLE');
 const db=await pool.connect();const managementQueue=createManagementQueue();
 let maintenanceBlocked=false;
 const assertOpen=()=>{if(maintenanceBlocked)throw new AppManagementError('PLATFORM_MAINTENANCE');};
 const queue={run:<T>(work:()=>Promise<T>)=>managementQueue.run(()=>{assertOpen();return work();}),close:managementQueue.close};
 try{
 const required=await db.query("SELECT to_regclass('platform_app_installations') AS installations,to_regclass('platform_app_v2_requests') AS requests");
 if(!required.rows[0].installations||!required.rows[0].requests)throw new AppManagementError('APP_MANAGEMENT_MIGRATIONS_REQUIRED');
 const repository=new PostgresAppRegistryRepository(db);
 const people=createPostgresPeopleDirectoryRepository(db);
 const authorization=createAuthorizationService(createPostgresAuthorizationRepository(db),{findPerson:id=>people.findPersonById(id)});
 const registry=new AppRegistryService(repository,{authorization,host:async()=>({platformVersion:getCoreConfig().runtime.releaseVersion.value,capabilities:PLATFORM_CAPABILITY_CATALOG.map(({id,contractVersion})=>({id,contractVersion})),applications:(await repository.list(500)).filter(record=>record.enabled).map(record=>({id:record.appId,version:record.manifest.version}))})});
 const employeeAccess=new EmployeeAppAccess(pool);
 const employeeAppSessions=new EmployeeAppSessions();
 const apiAuthorization=createManagementApiAuthorization(pool);
 // Runtime lookups use the pool, so app calls never queue behind lifecycle work on `db`.
 const lookups=new PostgresAppRegistryRepository(pool);
 const findInstallation=(appId:string)=>lookups.findByAppId(appId);
 const data=new AppDataServiceV2({pool,findInstallation});
 const tools=new AppToolService({
  async catalog({appId,personId}){
   const admission=await admitEmployee(appId,async()=>({source:'session',userId:personId}));
   const installation=admission.installation,manifest=installation.runtime?.model==='v2'?installation.runtime.manifest:null;
   const requestId=randomUUID();
   const actor=await apiAuthorization.contextResolver.resolve({actorType:'person',trustedIdentity:admission.identity,execution:{type:'application',appId},requestId,traceId:requestId});
   const result:ToolBinding[]=[];
   for(const tool of manifest?.tools??[])if(await apiAuthorization.authorize(actor,`app.${appId}.${tool.permission}`))result.push({...tool,installationId:installation.id,revision:installation.revision});
   return result;
  },
  async invoke({appId,personId},tool,args,signal){
   assertOpen();
   const resolveIdentity=async()=>({source:'session' as const,userId:personId}),admission=await admitEmployee(appId,resolveIdentity);
   if(admission.installation.id!==tool.installationId||admission.installation.revision!==tool.revision)throw new GatewayError('ACCESS_DENIED',403);
   const api=admission.installation.manifest.api.find(api=>api.id===tool.apiId)!;
   return apps.host(appId).invokeEmployeeApi(employeeApi(appId,resolveIdentity,employeeAdmissionKey(admission)),{apiId:api.id,method:api.method,path:api.path,payload:args},signal);
  }
 });
 const gateway=createManagementGateway(pool,[...data.operations(),...createToolOperations(tools)]);
 const invalidateAppSessions=()=>{employeeAppSessions.clear();apiAuthorization.clearSessions();};
 const apps=createAppRuntimeV2({root:join(config.artifactRoot,'v2'),registry,pool,gateway,api:apiAuthorization,findInstallation,
  listInstallations:()=>lookups.list(1000),platformVersion:()=>getCoreConfig().runtime.releaseVersion.value,maintenanceBlocked:()=>maintenanceBlocked});

 async function admitEmployee(appId:string,resolveIdentity:ResolveIdentity){
  const host=apps.findHost(appId);if(!host)throw new GatewayError('ACCESS_DENIED',403);
  const identity=await resolveIdentity();
  if(identity.source==='service'||!identity.userId)throw new GatewayError('ACCESS_DENIED',403);
  return employeeAppSessions.get(identity,appId,()=>{
   let first=true;
   return admitEmployeeApplication({resolveIdentity:()=>{
    if(first){first=false;return Promise.resolve(identity);}
    return resolveIdentity();
   },assertAccess:personId=>employeeAccess.assert(appId,personId),snapshot:()=>host.admittedSnapshot(),assertApproval:async()=>{}});
  });
 }

 async function employeeNavigation(admission:Awaited<ReturnType<typeof admitEmployee>>){
  const manifest=admission.installation.manifest;
  if(!manifest.routes.some(route=>route.permission))return readEmployeeNavigation(manifest,async()=>false);
  const requestId=randomUUID();
  const context=await apiAuthorization.contextResolver.resolve({actorType:'person',trustedIdentity:admission.identity,execution:{type:'application',appId:manifest.id},requestId,traceId:requestId});
  return readEmployeeNavigation(manifest,permission=>apiAuthorization.authorize(context,permission));
 }
 const employeeApi=(appId:string,resolveIdentity:ResolveIdentity,admissionKey:string)=>async()=>{const admission=await admitEmployee(appId,resolveIdentity);assertEmployeeAdmissionKey(admission,admissionKey);return admission.identity;};

 let maintenanceContext:PlatformManagementContext|undefined;
 const maintenance=process.env.MOP_MAINTENANCE_STATE?new PlatformMaintenance({
  list:async()=>{const records=await repository.list(1001);if(records.length>1000)throw Error('MAINTENANCE_APPLICATION_LIMIT');return records;},
  gate:closed=>{maintenanceBlocked=closed;},
  status:async appId=>{const record=await repository.findByAppId(appId);if(!record)throw Error('MAINTENANCE_INSTALLATION_MISSING');const host=apps.findHost(appId);return host&&maintenanceContext?host.status(maintenanceContext):{installation:record,serving:false};},
  drain:async appId=>{const host=apps.findHost(appId);if(!host)throw Error('MAINTENANCE_HOST_MISSING');await host.drainForMaintenance();},
  change:async(appId,revision,action)=>{
   if(!maintenanceContext)throw Error('MAINTENANCE_CONTEXT_REQUIRED');
   const result=await apps.host(appId).execute(maintenanceContext,{revision,action});
   invalidateAppSessions();
   return result;
  },
 },process.env.MOP_MAINTENANCE_STATE):undefined;
 await maintenance?.initialize();
 await apps.boot();
 // Local development only: `mop-app dev` drops packages here and they are installed automatically.
 const stopDevWatcher=process.env.MOP_DEV_APPS_DIR?await startDevAppsWatcher({directory:process.env.MOP_DEV_APPS_DIR,log:line=>console.log(line),
  install:bytes=>queue.run(async()=>{try{const result=await apps.installer.install(devAdministratorContext(),bytes,{dev:true});return `${result.appId} ${result.version} ${result.state}`;}finally{invalidateAppSessions();}})}):undefined;
 return {
  invalidateEmployeeSessions:invalidateAppSessions,
  maintenanceActive:()=>maintenanceBlocked,
  maintenanceStatus:()=>maintenance?.status()??null,
  prepareMaintenance:(context:PlatformManagementContext,taskId:string)=>managementQueue.run(async()=>{if(!maintenance)throw Error('MAINTENANCE_NOT_CONFIGURED');maintenanceContext=context;return maintenance.prepare(taskId,context.actorType==='administrator'?context.administrator.id:'');}),
  restoreMaintenance:(context:PlatformManagementContext,taskId:string)=>managementQueue.run(async()=>{if(!maintenance)throw Error('MAINTENANCE_NOT_CONFIGURED');maintenanceContext=context;return maintenance.restore(taskId);}),
  async employeeApps(resolveIdentity:ResolveIdentity){
   const identity=await resolveIdentity();if(identity.source==='service'||!identity.userId)throw new GatewayError('ACCESS_DENIED',403);
   const candidates=await employeeAccess.candidates(identity.userId);const applications=[];
   for(let index=0;index<candidates.length;index+=4){
    const group=await Promise.all(candidates.slice(index,index+4).map(async({appId})=>{
     try{const admitted=await admitEmployee(appId,async()=>identity);if(admitted.identity.userId!==identity.userId)throw new GatewayError('ACCESS_DENIED',403);const m=admitted.installation.manifest;
      const navigation=await employeeNavigation(admitted);
      const appPackage=admitted.installation.runtime;
      if(!navigation.routes.length||appPackage?.model!=='v2')return null;
      return {appId,name:m.name,description:m.description,version:m.version,...navigation,
       v2:{sha256:appPackage.sha256,color:appPackage.manifest.color??null,pages:appPackage.manifest.pages.map(({path,title,permission})=>({path,title,...(permission?{permission}:{})}))},
       ...(m.dashboard&&navigation.routes.some(route=>route.id===m.dashboard!.routeId)?{dashboard:{routeId:m.dashboard.routeId}}:{}),runtimeRevision:admitted.installation.revision};
     }catch(e){if(e instanceof GatewayError||e instanceof AppManagementError||e instanceof EmployeeIdentityError&&[403,404].includes(e.statusCode))return null;throw e;}
    }));
    for(const app of group)if(app)applications.push(app);
   }
   const fresh=await resolveIdentity();if(fresh.userId!==identity.userId)throw new GatewayError('ACCESS_DENIED',403);
   return {applications};
  },
  async employeeDashboard(appId:string,resolveIdentity:ResolveIdentity){
   assertOpen();
   const host=apps.findHost(appId);if(!host)throw new GatewayError('ACCESS_DENIED',403);
   return readEmployeeDashboard({admit:()=>admitEmployee(appId,resolveIdentity),navigation:employeeNavigation,
    invoke:(api,resolve)=>host.invokeEmployeeApi(resolve,{apiId:api.id,method:api.method,path:api.path,payload:{}})});
  },
  async employeeAgentCapabilities(resolveIdentity:ResolveIdentity){
   assertOpen();
   const identity=await resolveIdentity(),capabilities:ChatCapability[]=[];
   if(identity.source==='service'||!identity.userId)throw new GatewayError('ACCESS_DENIED',403);
   const candidates=await employeeAccess.candidates(identity.userId);
   for(const {appId} of candidates){
    let admission;
    try{admission=await admitEmployee(appId,async()=>identity);}
    catch(error){if(error instanceof GatewayError||error instanceof AppManagementError||error instanceof EmployeeIdentityError&&[403,404].includes(error.statusCode))continue;throw error;}
    const installation=admission.installation,manifest=installation.runtime?.model==='v2'?installation.runtime.manifest:null;
    if(!manifest?.agents?.length)continue;
    const requestId=randomUUID();
    const actor=await apiAuthorization.contextResolver.resolve({actorType:'person',trustedIdentity:identity,execution:{type:'application',appId},requestId,traceId:requestId});
    const accessKey=createHash('sha256').update(JSON.stringify({revision:installation.revision,business:await apiAuthorization.businessAuthorization(actor),organization:actor.actorType==='person'?actor.person.organization:null})).digest('hex');
    for(const agent of manifest.agents){
     const page=manifest.pages.find(page=>page.path===agent.page)!;
     if(!await apiAuthorization.authorize(actor,`app.${appId}.${agent.permission}`))continue;
     if(page.permission&&page.permission!==agent.permission&&!await apiAuthorization.authorize(actor,`app.${appId}.${page.permission}`))continue;
     capabilities.push({...agent,accessKey,key:`${installation.id}:${agent.id}`,appId,appName:manifest.name,revision:installation.revision});
    }
   }
   return capabilities;
  },
  async invokeEmployeeAgent(capability:ChatCapability,resolveIdentity:ResolveIdentity,input:AppAgentInput,signal:AbortSignal){
   assertOpen();
   const admission=await admitEmployee(capability.appId,resolveIdentity),installation=admission.installation;
   const manifest=installation.runtime?.model==='v2'?installation.runtime.manifest:null;
   const agent=manifest?.agents?.find(agent=>`${installation.id}:${agent.id}`===capability.key);
   if(!agent||installation.revision!==capability.revision)throw new GatewayError('ACCESS_DENIED',403);
   const api=installation.manifest.api.find(api=>api.id===agent.apiId)!;
   const result=await apps.host(capability.appId).invokeEmployeeApi(employeeApi(capability.appId,resolveIdentity,employeeAdmissionKey(admission)),{apiId:api.id,method:api.method,path:api.path,payload:input},signal);
   if(!result||typeof result!=='object'||Array.isArray(result)||!('ok' in result)||result.ok!==true)throw new GatewayError('INVALID_RESULT',502);
   return (result as {result:unknown}).result;
  },
  async invokeEmployeeApi(appId:string,resolveIdentity:ResolveIdentity,request:{apiId:string;method:string;path:string;payload:unknown},admissionKey:string){
   assertOpen();const host=apps.findHost(appId);if(!host)throw new GatewayError('ACCESS_DENIED',403);
   return host.invokeEmployeeApi(employeeApi(appId,resolveIdentity,admissionKey),request);
  },
  async authorizeEmployeeAttachment(appId:string,resolveIdentity:ResolveIdentity,admissionKey:string,
   request:{action:'upload'|'read'|'export';entityType:string;entityId:string;attachmentId?:string;requestId:string}){
   assertOpen();
   const first=await admitEmployee(appId,resolveIdentity);assertEmployeeAdmissionKey(first,admissionKey);
   const route=first.installation.manifest.api.find(api=>api.id==='authorize-attachment'&&api.method==='POST'&&(api.businessPermission||api.businessEntry));
   if(!route)throw new GatewayError('ACCESS_DENIED',403);
   const host=apps.findHost(appId);if(!host)throw new GatewayError('ACCESS_DENIED',403);
   const result=await host.invokeEmployeeApi(employeeApi(appId,resolveIdentity,admissionKey),{apiId:route.id,method:'POST',path:route.path,payload:request});
   if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='organizationId')throw new GatewayError('ACCESS_DENIED',403);
   const authorization=result as Record<string,unknown>;
   if(typeof authorization.organizationId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authorization.organizationId))throw new GatewayError('ACCESS_DENIED',403);
   const fresh=await admitEmployee(appId,resolveIdentity);assertEmployeeAdmissionKey(fresh,admissionKey);
   if(fresh.identity.userId!==first.identity.userId||fresh.installation.revision!==first.installation.revision)throw new GatewayError('ACCESS_DENIED',403);
   const serviceIdentityId=fresh.installation.serviceIdentityId;
   if(!serviceIdentityId)throw new GatewayError('ACCESS_DENIED',403);
   const person=await apiAuthorization.contextResolver.resolve({actorType:'person',trustedIdentity:fresh.identity,execution:{type:'application',appId},requestId:request.requestId,traceId:request.requestId});
   const service=await apiAuthorization.contextResolver.resolve({actorType:'service',trustedIdentity:{source:'service'},execution:{type:'service',appId,serviceIdentityId},requestId:request.requestId,traceId:request.requestId});
   if(person.actorType!=='person'||service.actorType!=='service')throw new GatewayError('ACCESS_DENIED',403);
   // The app's service grant bounds storage access; the employee remains the recorded uploader
   // after the app's `authorize-attachment` API has authorized this record.
   const context=bindEmployeeAttachmentActor(person,service);
   return {context,organizationId:authorization.organizationId};
  },
  /** Page session: admission key, the employee's granted permissions and the module address. */
  async employeeV2Session(appId:string,path:string,resolveIdentity:ResolveIdentity){
   assertOpen();const admission=await admitEmployee(appId,resolveIdentity),installation=admission.installation,appPackage=installation.runtime;
   if(appPackage?.model!=='v2')throw new GatewayError('ACCESS_DENIED',403);
   const page=matchPage(appPackage.manifest.pages,path);if(!page)throw new GatewayError('ACCESS_DENIED',403);
   const requestId=randomUUID();
   const actor=await apiAuthorization.contextResolver.resolve({actorType:'person',trustedIdentity:admission.identity,execution:{type:'application',appId},requestId,traceId:requestId});
   if(actor.actorType!=='person')throw new GatewayError('ACCESS_DENIED',403);
   const granted:string[]=[];
   for(const permission of appPackage.manifest.permissions)if(await apiAuthorization.authorize(actor,`app.${appId}.${permission.code}`))granted.push(permission.code);
   if(page.page.permission&&!granted.includes(page.page.permission))throw new GatewayError('ACCESS_DENIED',403);
   const css=await apps.store.read(appId,appPackage.sha256,'ui.css');
   return {appId,name:installation.manifest.name,admissionKey:employeeAdmissionKey(admission),sha256:appPackage.sha256,
    moduleUrl:`/api/employee/apps/${appId}/v2/${appPackage.sha256}/ui.js`,...(css?{cssUrl:`/api/employee/apps/${appId}/v2/${appPackage.sha256}/ui.css`}:{}),
    route:{path,pattern:page.page.path,params:page.params,title:page.page.title},
    user:{personId:actor.person.id,name:actor.person.name,organizationUnitId:actor.person.organization?.id??null,permissions:granted}};
  },
  /** Immutable page bundle for an admitted employee; the hash pins the installed version. */
  async employeeV2Asset(appId:string,sha256:string,file:'ui.js'|'ui.css',resolveIdentity:ResolveIdentity){
   assertOpen();const admission=await admitEmployee(appId,resolveIdentity);
   if(admission.installation.runtime?.model!=='v2'||admission.installation.runtime.sha256!==sha256)throw new GatewayError('ACCESS_DENIED',403);
   const bytes=await apps.store.read(appId,sha256,file);if(!bytes)throw new GatewayError('ACCESS_DENIED',403);
   return bytes;
  },
  /** Icon file of an installed app. */
  async appIcon(appId:string){
   const record=await findInstallation(appId);
   if(record?.runtime?.model!=='v2')return null;
   const svg=await apps.store.read(appId,record.runtime.sha256,'icon.svg');
   if(svg)return {contentType:'image/svg+xml',bytes:svg,color:record.runtime.manifest.color??null};
   const png=await apps.store.read(appId,record.runtime.sha256,'icon.png');
   return png?{contentType:'image/png',bytes:png,color:record.runtime.manifest.color??null}:null;
  },
  /** Read-only directory call from a page, bound to the page's admission. */
  async invokeEmployeeV2Platform(appId:string,resolveIdentity:ResolveIdentity,request:{operation:string;params:unknown},admissionKey:string){
   assertOpen();const admission=await admitEmployee(appId,resolveIdentity);assertEmployeeAdmissionKey(admission,admissionKey);
   const host=apps.findHost(appId);if(admission.installation.runtime?.model!=='v2'||!host)throw new GatewayError('ACCESS_DENIED',403);
   return host.invokeEmployeePlatform(admission.identity,request);
  },
  /** Read-only `.mopkg` preview against the current installation. */
  previewPackage:(context:PlatformManagementContext,bytes:Uint8Array)=>previewAppPackageV2(bytes,{
   platformVersion:getCoreConfig().runtime.releaseVersion.value,installAvailable:true,
   findInstalled:async appId=>{
    try{return summarizeInstallation(await registry.get(context,appId));}
    catch(error){if(error instanceof AppRegistryError&&error.code==='APP_NOT_FOUND')return null;throw error;}
   },
  }),
  installPackage:(context:PlatformManagementContext,bytes:Uint8Array)=>queue.run(async()=>{try{return await apps.installer.install(context,bytes);}finally{invalidateAppSessions();}}),
  uploadRoot:config.uploadRoot,
  async getHost(appId:string){
   if(!await findInstallation(appId))return null;
   const host=apps.host(appId);
   return {status:(context:PlatformManagementContext)=>queue.run(()=>host.status(context)),
    execute:(context:PlatformManagementContext,input:Parameters<typeof host.execute>[1])=>queue.run(async()=>{const result=await host.execute(context,input);invalidateAppSessions();return result;}),
    recover:(context:PlatformManagementContext,revision:number)=>queue.run(async()=>{const result=await host.recover(context,revision);invalidateAppSessions();return result;}),
   };
  },
  close:()=>queue.close(async()=>{stopDevWatcher?.();await apps.close();db.release();}),
 };
 }catch(error){db.release();throw error;}
}
export type AppManagement=Awaited<ReturnType<typeof createAppManagement>>;

/** Matches a page path pattern (`/records/:id`) against a concrete path. */
function matchPage(pages:readonly {path:string;title:string;permission?:string}[],path:string){
 if(typeof path!=='string'||path.length>512||!path.startsWith('/'))return null;
 const parts=path==='/'?[]:path.slice(1).split('/');
 for(const page of pages){
  const pattern=page.path==='/'?[]:page.path.slice(1).split('/');
  if(pattern.length!==parts.length)continue;
  const params:Record<string,string>={};
  if(pattern.every((segment,index)=>{const value=parts[index]!;if(segment.startsWith(':')){if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))return false;params[segment.slice(1)]=value;return true;}return segment===value;}))return {page,params};
 }
 return null;
}
