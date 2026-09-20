import {AppBusinessAuthorization} from '../business-authorization/service.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
import {createEmployeeRoleManagement} from './employee-roles.js';
import {parsePolicy} from '../developer/publisher-policy.js';
import {AppPackageError} from '../developer/package.js';
import {AppStorageError} from '../storage/binding.js';
import {getCoreConfig} from '../../core/config/index.js';
import {InstallError} from '../install/journal.js';
import type {AppManagement} from '../management/service.js';
import {registerAdminAiRoutes} from './ai-routes.js';
import {createAdminDataService,adminDataResources,AdminDataError} from '../admin-data/index.js';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {PLATFORM_CAPABILITY_CATALOG} from '@metro/platform-sdk';
import {ADMIN_SESSION_COOKIE,appendAdminAudit,AdminIdentityError,type AdminIdentityService} from '../../core/admin-identity/index.js';
import {type ConnectablePool,type QueryableClient} from '../../core/database/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import {AppRegistryError,AppRegistryService,PostgresAppRegistryRepository} from '../registry/index.js';
import type {AppLifecycleRoutesOptions} from '../runtime/lifecycle-routes.js';
import type {AppInstallRoutesOptions} from '../install/routes.js';
import {withInstallUpload,INSTALL_BODY_LIMIT} from '../install/wire.js';

export interface AdminConsoleOptions {
 origin:string; identity:AdminIdentityService; pool:ConnectablePool;
 lifecycle?:AppLifecycleRoutesOptions; install?:AppInstallRoutesOptions; management?:AppManagement;
}
export function createAdministratorContext(request:FastifyRequest,identity:AdminIdentityService):Promise<PlatformAdministratorContext> {
 const token=request.cookies[ADMIN_SESSION_COOKIE];
 return identity.authenticate(token).then(account=>{
  if(!account)throw new AdminIdentityError(401,'ADMIN_AUTH_REQUIRED');
  return {actorType:'administrator',administrator:account,execution:{type:'platform'},request:{requestId:request.id,traceId:request.id,startedAt:new Date().toISOString()},
   authorize:async permission=>{
    const fresh=await identity.authenticate(token);
    const allowed=!!fresh&&fresh.id===account.id&&['platform.authorization.read','platform.authorization.manage','platform.system.update'].includes(permission);
    return {id:randomUUID(),allowed,reasonCode:allowed?'allowed':'permission_not_granted',permissionCode:permission,subjectType:'administrator',effectiveScopes:allowed?[{source:'role',scope:{kind:'all',targets:[]}}]:[],decidedAt:new Date().toISOString()};
   }};
 });
}
function registry(db:QueryableClient) {
 return new AppRegistryService(new PostgresAppRegistryRepository(db),{
  host:async()=>({platformVersion:getCoreConfig().runtime.releaseVersion.value,capabilities:PLATFORM_CAPABILITY_CATALOG.map(({id,contractVersion})=>({id,contractVersion})),applications:[]}),
  authorization:{listPermissions:async()=>{
   const result=await db.query('SELECT id,code,name,status FROM platform_permissions ORDER BY code') as {rows:{id:string;code:string;name:string;status:'active'|'inactive'}[]};
   return result.rows.map(p=>({...p,description:null,createdAt:'',updatedAt:''}));
  }}
 });
}
export async function registerAdminConsoleRoutes(app:FastifyInstance,options:AdminConsoleOptions) {
 await app.register(async scoped=>{
  let uploads=0;const admitted=new WeakSet<FastifyRequest>();
  scoped.addHook('onRequest',async(req,reply)=>{
   reply.header('Cache-Control','no-store');
   if(req.method!=='GET'&&req.headers.origin!==options.origin)throw new AdminIdentityError(403,'ADMIN_ORIGIN_DENIED');
   await createAdministratorContext(req,options.identity);
   const requestPath=req.url.split('?')[0];
   if(req.method==='POST'&&(['/api/admin/install','/api/admin/install-preview','/api/admin/install-approve'].includes(requestPath)||/^\/api\/admin\/apps\/[^/]+\/upgrade$/.test(requestPath))){
    if(uploads>=2)throw new AdminIdentityError(429,'INSTALL_BUSY');uploads++;admitted.add(req);
   }
  });
  scoped.addHook('onResponse',async req=>{if(admitted.delete(req))uploads--;});
  scoped.setErrorHandler((error,_req,reply)=>{
   if(error instanceof AdminIdentityError||error instanceof EmployeeIdentityError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof AdminDataError)return reply.code(error.statusCode).send({error:error.code,message:error.message});
   if(error instanceof AppRegistryError){
    const clientErrors:Record<string,number>={STALE_REVISION:409,APP_NOT_FOUND:404,GRANT_NOT_FOUND:404,REGISTRY_ACCESS_DENIED:403,UNDECLARED_PERMISSION:400,PERMISSION_NOT_ACTIVE:400,INVALID_DATA_SCOPE:400,INVALID_GRANT_MODE:400,SERVICE_IDENTITY_MISMATCH:400,SERVICE_RELATIVE_SCOPE:400,UNEXPECTED_SERVICE_IDENTITY:400,INVALID_GRANT_INTERVAL:400,GRANT_LIMIT:409};
    return reply.code(clientErrors[error.code]??503).send({error:error.code});
   }
   if(error instanceof AppStorageError)return reply.code(error.code==='STORAGE_ACCESS_DENIED'?403:409).send({error:error.code});
   if(error instanceof InstallError){const status=error.code==='INSTALL_NOT_FOUND'?404:error.code==='INSTALL_ACCESS_DENIED'?403:error.code.startsWith('INVALID_')?400:409;return reply.code(status).send({error:error.code});}
   if(error instanceof AppPackageError)return reply.code(400).send({error:error.code});
   if(error instanceof z.ZodError)return reply.code(400).send({error:'ADMIN_INVALID_INPUT'});
   const code=error instanceof Error&&'code' in error&&typeof error.code==='string'?error.code:'';
   return reply.code(503).send({error:/^[A-Z][A-Z_]{3,80}$/.test(code)?code:'ADMIN_SERVICE_UNAVAILABLE'});
  });
  async function withRegistry<T>(req:FastifyRequest,work:(service:AppRegistryService,context:PlatformAdministratorContext)=>Promise<T>) {
   const context=await createAdministratorContext(req,options.identity);const db=await options.pool.connect();
   try{return await work(registry(db),context);}finally{db.release();}
  }
  async function withData<T>(req:FastifyRequest,work:(service:ReturnType<typeof createAdminDataService>,context:PlatformAdministratorContext)=>Promise<T>) {
   const context=await createAdministratorContext(req,options.identity);const db=await options.pool.connect();
   try{return await work(createAdminDataService(db,{audit:event=>appendAdminAudit(db,event)}),context);}finally{db.release();}
  }
  async function withRoles<T>(req:FastifyRequest,work:(service:ReturnType<typeof createEmployeeRoleManagement>,context:PlatformAdministratorContext)=>Promise<T>){
   const context=await createAdministratorContext(req,options.identity),db=await options.pool.connect();try{return await work(createEmployeeRoleManagement(db),context);}finally{db.release();}
  }
  const business=new AppBusinessAuthorization(options.pool);
  scoped.get<{Params:{appId:string}}>('/apps/:appId/owner',async req=>business.administratorState(await createAdministratorContext(req,options.identity),req.params.appId));
  scoped.put<{Params:{appId:string}}>('/apps/:appId/owner',{bodyLimit:4096},async req=>business.setOwner(await createAdministratorContext(req,options.identity),req.params.appId,req.body));
  scoped.get<{Params:{appId:string}}>('/apps/:appId/employee-roles',async req=>withRoles(req,(s,c)=>s.list(c,req.params.appId)));
  scoped.put<{Params:{appId:string}}>('/apps/:appId/employee-roles',{bodyLimit:4096},async req=>withRoles(req,(s,c)=>s.set(c,req.params.appId,req.body)));
  scoped.get<{Params:{personId:string}}>('/employee-roles/:personId',async req=>withRoles(req,(s,c)=>s.assignment(c,req.params.personId)));
  scoped.put('/employee-roles',{bodyLimit:4096},async req=>withRoles(req,(s,c)=>s.assign(c,req.body)));
  await registerAdminAiRoutes(scoped,options.identity);
  scoped.get('/data/resources',async()=>({resources:adminDataResources()}));
  scoped.get<{Params:{key:string};Querystring:{q?:string;status?:string}}>('/data/:key',async req=>withData(req,async(service,context)=>({records:await service.list(context.administrator,req.params.key,req.query.q??'',req.query.status??'')})));
  scoped.post<{Params:{key:string}}>('/data/:key',{bodyLimit:16384},async req=>withData(req,(service,context)=>service.create(context.administrator,req.params.key,req.body)));
  scoped.patch<{Params:{key:string;id:string}}>('/data/:key/:id',{bodyLimit:16384},async req=>withData(req,(service,context)=>service.update(context.administrator,req.params.key,req.params.id,req.body)));
  scoped.get('/audit',async()=>{
   const db=await options.pool.connect();
   try {const result=await db.query('SELECT id,actor_id AS "actorId",action,target_id AS "targetId",occurred_at AS "createdAt" FROM platform_admin_audit ORDER BY occurred_at DESC,id DESC LIMIT 100');return {entries:(result as {rows:unknown[]}).rows};}finally{db.release();}
  });
  scoped.get('/apps',async req=>withRegistry(req,async(service,context)=>({applications:await service.list(context),runtimeConfigured:!!options.lifecycle,installConfigured:!!options.install})));
  scoped.get<{Params:{appId:string}}>('/apps/:appId',async req=>withRegistry(req,(service,context)=>service.get(context,req.params.appId)));
  scoped.get('/overview',async req=>withRegistry(req,async(service,context)=>{
   const apps=await service.list(context);
   return {installed:apps.length,enabled:apps.filter(a=>a.enabled).length,attention:apps.filter(a=>a.lifecycle&&a.lifecycle.status!=='completed').length,runtimeConfigured:!!options.lifecycle,installConfigured:!!options.install};
  }));
  scoped.get('/notifications',async req=>withRegistry(req,async(service,context)=>({notifications:(await service.list(context)).filter(app=>app.lifecycle&&app.lifecycle.status!=='completed'&&app.lifecycle.status!=='cancelled').map(app=>({id:app.id,title:`${app.manifest.name}：需要核对应用操作`,description:`${app.lifecycle!.action} / ${app.lifecycle!.status}`,path:'/admin/apps'}))})));
  scoped.get('/capabilities',async()=>({capabilities:PLATFORM_CAPABILITY_CATALOG.map(({id,contractVersion,permissions})=>({id,contractVersion,permissions})),runtimeConfigured:!!options.lifecycle,installConfigured:!!options.install}));
  scoped.get<{Params:{appId:string}}>('/apps/:appId/history',async req=>withRegistry(req,(service,context)=>service.listHistory(context,req.params.appId)));
  scoped.post<{Params:{appId:string}}>('/apps/:appId/grants',{bodyLimit:16384},async req=>{
   const body=z.object({revision:z.number().int().positive(),permissionCode:z.string(),mode:z.enum(['delegated_user','service']),serviceIdentityId:z.string().uuid().optional(),scope:z.object({kind:z.enum(['self','organization','organization_tree','responsibility','explicit','all']),targets:z.array(z.object({type:z.enum(['organization','location','asset_type','asset','responsibility_scope']),id:z.string()})).max(128)}).strict()}).strict().parse(req.body);
   if(!body.permissionCode.startsWith('platform.'))throw new AdminIdentityError(400,'BUSINESS_PERMISSION_MANAGED_BY_APP_OWNER');
   return withRegistry(req,(service,context)=>service.approveGrant(context,req.params.appId,body.revision!,{permissionCode:body.permissionCode!,mode:body.mode!,serviceIdentityId:body.serviceIdentityId,scope:{kind:body.scope!.kind!,targets:body.scope!.targets!.map(t=>({type:t.type!,id:t.id!}))}}));
  });
  scoped.delete<{Params:{appId:string;grantId:string}}>('/apps/:appId/grants/:grantId',{bodyLimit:1024},async req=>{
   const body=z.object({revision:z.number().int().positive()}).strict().parse(req.body);
   return withRegistry(req,(service,context)=>service.revokeGrant(context,req.params.appId,body.revision,req.params.grantId));
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/lifecycle',{bodyLimit:65536},async req=>{
   const body=z.object({revision:z.number().int().positive(),action:z.enum(['install','enable','disable','upgrade','rollback','uninstall']),targetManifest:z.unknown().optional()}).strict().parse(req.body);
   const context=await createAdministratorContext(req,options.identity);
   const host=await options.lifecycle?.getHost(req.params.appId);
   if(!host)throw new AdminIdentityError(503,'APP_RUNTIME_NOT_CONFIGURED');
   return host.execute(context,{revision:body.revision!,action:body.action!,targetManifest:body.targetManifest});
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/install-status',async req=>{
   if(!options.install)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   return options.install.installer.status(await createAdministratorContext(req,options.identity),req.params.appId);
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/install-recover',async req=>{
   const {revision}=z.object({revision:z.number().int().positive()}).strict().parse(req.body);
   if(!options.install)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   return options.install.installer.recover(await createAdministratorContext(req,options.identity),req.params.appId,revision);
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/runtime-status',async req=>{
   const host=await options.lifecycle?.getHost(req.params.appId);
   if(!host)throw new AdminIdentityError(503,'APP_RUNTIME_NOT_CONFIGURED');
   return host.status(await createAdministratorContext(req,options.identity));
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/prepare-credential',async req=>{
   const {revision}=z.object({revision:z.number().int().positive()}).strict().parse(req.body);
   const host=await options.lifecycle?.getHost(req.params.appId);
   if(!host)throw new AdminIdentityError(503,'APP_RUNTIME_NOT_CONFIGURED');
   return host.prepareCredential(await createAdministratorContext(req,options.identity),revision);
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/recover',async req=>{
   const {revision}=z.object({revision:z.number().int().positive()}).strict().parse(req.body);
   const host=await options.lifecycle?.getHost(req.params.appId);
   if(!host)throw new AdminIdentityError(503,'APP_RUNTIME_NOT_CONFIGURED');
   return host.recover(await createAdministratorContext(req,options.identity),revision);
  });
  scoped.get<{Params:{appId:string};Querystring:{path?:string}}>('/apps/:appId/ui',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_RUNTIME_NOT_CONFIGURED');
   const query=z.object({path:z.string().max(512).default('/')}).strict().parse(req.query);
   return options.management.ui(await createAdministratorContext(req,options.identity),req.params.appId,query.path);
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/upgrade',{bodyLimit:INSTALL_BODY_LIMIT},async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const body=z.object({revision:z.number().int().positive(),package:z.unknown()}).strict().parse(req.body);
   const context=await createAdministratorContext(req,options.identity);
   return withInstallUpload(body.package,options.management.uploadRoot,input=>options.management!.versionUpdate(context,{...input,appId:req.params.appId,revision:body.revision}));
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/version-status',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   return options.management.versionStatus(await createAdministratorContext(req,options.identity),req.params.appId);
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/version-recover',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const {requestId}=z.object({requestId:z.string().regex(/^[a-zA-Z0-9-]{16,64}$/)}).strict().parse(req.body);
   return options.management.versionRecover(await createAdministratorContext(req,options.identity),req.params.appId,requestId);
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/storage/migrations',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const {afterSequence}=z.object({afterSequence:z.coerce.number().int().min(0).max(2147483647).default(0)}).strict().parse(req.query);
   return options.management.migrationHistory(await createAdministratorContext(req,options.identity),req.params.appId,afterSequence);
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/storage/migrations/reconcile',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const {revision,attemptId}=z.object({revision:z.number().int().positive(),attemptId:z.string().uuid()}).strict().parse(req.body);
   return options.management.reconcileMigration(await createAdministratorContext(req,options.identity),req.params.appId,revision,attemptId);
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/storage/writes',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const {after}=z.object({after:z.string().uuid().optional()}).strict().parse(req.query);
   return options.management.writeHistory(await createAdministratorContext(req,options.identity),req.params.appId,after??null);
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/storage/writes/reconcile',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const {revision,requestId}=z.object({revision:z.number().int().positive(),requestId:z.string().uuid()}).strict().parse(req.body);
   return options.management.reconcileWrite(await createAdministratorContext(req,options.identity),req.params.appId,revision,requestId);
  });
  scoped.get('/publisher-policy',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   return options.management.approvalPolicy(await createAdministratorContext(req,options.identity));
  });
  scoped.put('/publisher-policy',{bodyLimit:262144},async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const body=z.object({revision:z.number().int().positive(),keys:z.unknown()}).strict().parse(req.body);
   const policy=parsePolicy({policyVersion:'1.0',revision:body.revision,keys:body.keys});
   return options.management.savePublisherPolicy(await createAdministratorContext(req,options.identity),body.revision,policy.keys);
  });
  scoped.post('/install-preview',{bodyLimit:INSTALL_BODY_LIMIT},async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const context=await createAdministratorContext(req,options.identity);
   return withInstallUpload(req.body,options.management.uploadRoot,input=>options.management!.previewPackage(context,input));
  });
  scoped.post('/install-approve',{bodyLimit:INSTALL_BODY_LIMIT},async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const body=z.object({revision:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/),platformCapabilities:z.boolean().default(false),package:z.unknown()}).strict().parse(req.body);
   const context=await createAdministratorContext(req,options.identity);
   return withInstallUpload(body.package,options.management.uploadRoot,input=>options.management!.approvePackage(context,input,body.revision,body.digest,body.platformCapabilities));
  });
  scoped.post('/version-approval/revoke',async req=>{
   if(!options.management)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const {revision,digest}=z.object({revision:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
   return options.management.revokeApproval(await createAdministratorContext(req,options.identity),revision,digest);
  });
  scoped.post('/install',{bodyLimit:INSTALL_BODY_LIMIT},async req=>{
   if(!options.install)throw new AdminIdentityError(503,'APP_INSTALL_NOT_CONFIGURED');
   const context=await createAdministratorContext(req,options.identity);
   return withInstallUpload(req.body,options.install.uploadRoot,input=>options.install!.installer.install(context,input));
  });
 },{prefix:'/api/admin'});
}
