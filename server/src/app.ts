import {registerRegistrationRoutes} from './platform/employee-identity/registration.js';
import {AppBusinessAuthorization} from './app-platform/business-authorization/service.js';
import {registerUnifiedLogin} from './platform/employee-identity/unified-login.js';
import Fastify from 'fastify';
import {registerPlatformUpdateRoutes} from './app-platform/admin/update-routes.js';
import {getCoreConfig} from './core/config/index.js';
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
 registerAdminIdentityRoutes(app,{origin,service:identity});
 const file=process.env.MOP_APP_MANAGEMENT_CONFIG;
 const management=file?await createAppManagement(file,origin):undefined;
 if(management)app.addHook('onClose',async()=>management.close());
 const resolveContext=(request:import('fastify').FastifyRequest)=>createAdministratorContext(request,identity);
 registerPlatformUpdateRoutes(app,{origin,pool,resolveAdmin:resolveContext,socketPath:process.env.MOP_UPDATER_SOCKET});
 const employeeIdentity=new EmployeeIdentityService(pool);
 await registerRegistrationRoutes(app,{origin,pool,resolveAdmin:resolveContext});
 registerUnifiedLogin(app,{origin,pool,admin:identity,employee:employeeIdentity});
 registerEmployeeRoutes(app,{origin,service:employeeIdentity,business:new AppBusinessAuthorization(pool),access:new EmployeeAppAccess(pool),resolveAdmin:resolveContext,management});
 await registerAdminConsoleRoutes(app,{origin,identity,pool,management,
  lifecycle:management?{origin,resolveContext,getHost:management.getHost}:undefined,
  install:management?{origin,resolveContext,uploadRoot:management.uploadRoot,installer:management}:undefined});
 return app;
}
