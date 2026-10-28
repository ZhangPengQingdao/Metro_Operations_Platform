import {KnowledgeIndexer} from './platform/knowledge/indexer.js';
import {ChatService} from './platform/chat/index.js';
import {startMaintenanceControl} from './app-platform/updates/control.js';
import {registerAppSubmissionRoutes} from './app-platform/submissions/routes.js';
import {registerRegistrationRoutes} from './platform/employee-identity/registration.js';
import {AppBusinessAuthorization} from './app-platform/business-authorization/service.js';
import {registerUnifiedLogin} from './platform/employee-identity/unified-login.js';
import Fastify from 'fastify';
import {registerPlatformUpdateRoutes} from './app-platform/admin/update-routes.js';
import {getCoreConfig} from './core/config/index.js';
import {resolvePlatformSites} from './core/http/index.js';
import {getDatabasePool} from './core/database/index.js';
import {createFastifyRuntimeOptions} from './core/http/index.js';
import {createProductionAdminIdentityService,registerAdminIdentityRoutes} from './core/admin-identity/index.js';
import {registerAdminConsoleRoutes,createAdministratorContext} from './app-platform/admin/routes.js';
import {createAppManagement} from './app-platform/management/service.js';
import {registerCookie} from './plugins/cookie.js';
import {registerCors} from './plugins/cors.js';
import {registerSecurity} from './plugins/security.js';
import {registerErrorHandler} from './middleware/error-handler.js';
import {registerHealthRoutes} from './core/health/index.js';
import {EmployeeIdentityService} from './platform/employee-identity/index.js';
import {registerEmployeeRoutes} from './app-platform/employee/routes.js';
import {EmployeeAppAccess} from './app-platform/employee/access.js';

export async function buildApp(){
 const config=getCoreConfig();
 const app=Fastify(createFastifyRuntimeOptions(config));
 await registerCors(app);await registerSecurity(app);await registerCookie(app);await registerErrorHandler(app);
 await registerHealthRoutes(app);
 const pool=getDatabasePool();
 if(!pool)throw new Error('DATABASE_URL_REQUIRED');
 const identity=createProductionAdminIdentityService(pool);
 const origin=new URL(config.http.publicBaseUrl.value??config.http.corsOrigin.value).origin;
 const sites=resolvePlatformSites(origin,process.env.ADMIN_PUBLIC_BASE_URL),adminOrigin=sites.admin;
 app.get('/api/platform/sites',async(_req,reply)=>{reply.header('Cache-Control','no-store');return sites;});
 registerAdminIdentityRoutes(app,{origin:adminOrigin,service:identity});
 let indexPaused=false,indexJobAbort=new AbortController(),indexWork:Promise<void>|undefined;
 const file=process.env.MOP_APP_MANAGEMENT_CONFIG;
 const management=file?await createAppManagement(file,origin):undefined;
 if(management)app.addHook('onClose',async()=>management.close());
 app.addHook('onRequest',async(request,reply)=>{
  if(management?.maintenanceActive()&&!['/api/health/live','/api/health/ready','/api/admin/updates/status'].includes(request.url.split('?')[0]))return reply.code(503).send({error:'PLATFORM_MAINTENANCE',message:'平台正在更新维护，请稍后重试。'});
 });
 if(process.env.MOP_MAINTENANCE_SOCKET&&management){
  const control=await startMaintenanceControl({socketPath:process.env.MOP_MAINTENANCE_SOCKET,pool,status:management.maintenanceStatus,prepare:async(context,taskId)=>{
   indexPaused=true;indexJobAbort.abort();await indexWork;
   try{return await management.prepareMaintenance(context,taskId);}
   finally{indexPaused=management.maintenanceActive();}
  },restore:async(context,taskId)=>{
   try{return await management.restoreMaintenance(context,taskId);}
   finally{indexPaused=management.maintenanceActive();}
  }});
  app.addHook('onClose',async()=>control.close());
 }
 const resolveContext=(request:import('fastify').FastifyRequest)=>createAdministratorContext(request,identity);
 registerPlatformUpdateRoutes(app,{origin:adminOrigin,pool,resolveAdmin:resolveContext,socketPath:process.env.MOP_UPDATER_SOCKET});
 const employeeIdentity=new EmployeeIdentityService(pool);
 const chat=new ChatService({pool,
  capabilities:personId=>management?management.employeeAgentCapabilities(async()=>({source:'session',userId:personId})):Promise.resolve([]),
  invoke:(personId,capability,input,signal)=>management!.invokeEmployeeAgent(capability,async()=>({source:'session',userId:personId}),input,signal),
  report:error=>app.log.error(error,'Conversation failed')});
 await chat.initialize();
 const indexer=new KnowledgeIndexer(pool),indexAbort=new AbortController();
 let indexTimer:ReturnType<typeof setTimeout>|undefined;
 const indexTick=async()=>{
  try{if(!indexPaused&&!management?.maintenanceActive()){indexJobAbort=new AbortController();await indexer.runOnce(AbortSignal.any([indexAbort.signal,indexJobAbort.signal]));}}
  catch{app.log.error('Knowledge indexing database operation failed');}
  finally{if(!indexAbort.signal.aborted)indexTimer=setTimeout(()=>{indexWork=indexTick();},2000);}
 };
 app.addHook('onReady',async()=>{indexWork=indexTick();});
 app.addHook('onClose',async()=>{indexAbort.abort();clearTimeout(indexTimer);await indexWork;});
 app.addHook('onClose',async()=>chat.close());
 registerAppSubmissionRoutes(app,{pool,origin,adminOrigin,employee:employeeIdentity,resolveAdmin:resolveContext,management});
 await registerRegistrationRoutes(app,{origin,adminOrigin,pool,resolveAdmin:resolveContext});
 registerUnifiedLogin(app,{origin,adminOrigin,pool,admin:identity,employee:employeeIdentity});
 registerEmployeeRoutes(app,{origin,adminOrigin,service:employeeIdentity,business:new AppBusinessAuthorization(pool),access:new EmployeeAppAccess(pool),resolveAdmin:resolveContext,management,chat});
 await registerAdminConsoleRoutes(app,{origin:adminOrigin,identity,pool,management,
  lifecycle:management?{getHost:management.getHost}:undefined});
 return app;
}
