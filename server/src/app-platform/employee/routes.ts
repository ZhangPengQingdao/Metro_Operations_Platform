import type {AppBusinessAuthorization} from '../business-authorization/service.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {EmployeeIdentityService,EmployeeIdentityError,EMPLOYEE_SESSION_COOKIE} from '../../platform/employee-identity/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import type {AppManagement} from '../management/service.js';
import {GatewayError} from '../gateway/model.js';
import {AdminIdentityError} from '../../core/admin-identity/index.js';
import type {EmployeeAppAccess} from './access.js';
import {AppManagementError} from '../management/ui.js';
import {AppStdioApiError} from '../runtime/stdio-api.js';

export function registerEmployeeRoutes(app:FastifyInstance,options:{origin:string;service:EmployeeIdentityService;resolveAdmin(request:FastifyRequest):Promise<PlatformAdministratorContext>;management?:AppManagement;access?:EmployeeAppAccess;business?:AppBusinessAuthorization}){
 const url=new URL(options.origin);
 if(url.origin!==options.origin||!['http:','https:'].includes(url.protocol)||(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('EMPLOYEE_CANONICAL_ORIGIN_REQUIRED');
 const cookie={path:'/api/employee',httpOnly:true,secure:url.protocol==='https:',sameSite:'strict' as const};
 const attempts=new Map<string,{count:number;until:number}>();
 app.register(async scoped=>{
  scoped.setErrorHandler((error,_req,reply)=>{
   if(error instanceof z.ZodError)return reply.code(400).send({error:'EMPLOYEE_INVALID_INPUT'});
   if(error instanceof GatewayError)return reply.code(error.statusCode).send({version:'1.0',error:{code:error.code,writeOutcome:error.writeOutcome}});
   if(error instanceof AppStdioApiError)return reply.code(error.code==='ACCESS_DENIED'||error.code==='API_DENIED'?403:503).send({error:{code:'APP_API_FAILED',writeOutcome:error.writeOutcome}});
   if(error instanceof EmployeeIdentityError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof AppManagementError)return reply.code(503).send({error:error.code});
   return reply.code(503).send({error:'EMPLOYEE_SERVICE_UNAVAILABLE'});
  });
  scoped.addHook('preHandler',async(req,reply)=>{
   reply.header('Cache-Control','no-store');if(req.method!=='GET'&&req.headers.origin!==options.origin)throw new EmployeeIdentityError(403,'EMPLOYEE_ORIGIN_DENIED');
   if(req.routeOptions.url==='/api/employee/auth/login'){
    const now=Date.now();for(const [id,entry]of attempts)if(entry.until<=now)attempts.delete(id);
    if(!attempts.has(req.ip)&&attempts.size>=10000)throw new EmployeeIdentityError(429,'EMPLOYEE_RATE_LIMIT');
    const entry=attempts.get(req.ip)??{count:0,until:now+60000};attempts.set(req.ip,entry);if(++entry.count>5)throw new EmployeeIdentityError(429,'EMPLOYEE_RATE_LIMIT');
   }else await options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE]);
  });
  scoped.post('/auth/login',{bodyLimit:4096},async(req,reply)=>{const result=await options.service.login(req.body);reply.setCookie(EMPLOYEE_SESSION_COOKIE,result.token,{...cookie,maxAge:8*60*60});return result.account;});
  scoped.get('/auth/me',async req=>options.service.authenticate(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  scoped.post('/auth/logout',async(req,reply)=>{await options.service.logout(req.cookies[EMPLOYEE_SESSION_COOKIE]!);reply.clearCookie(EMPLOYEE_SESSION_COOKIE,cookie);return {ok:true};});
  scoped.get('/profile',async req=>options.service.profile(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  scoped.patch('/profile',{bodyLimit:4096},async req=>options.service.updateProfile(req.cookies[EMPLOYEE_SESSION_COOKIE]!,req.body));
  scoped.patch('/auth/password',{bodyLimit:4096},async(req,reply)=>{await options.service.changePassword(req.cookies[EMPLOYEE_SESSION_COOKIE]!,req.body);reply.clearCookie(EMPLOYEE_SESSION_COOKIE,cookie);return {ok:true};});
  scoped.get('/notifications',async req=>options.service.notifications(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  scoped.get('/managed-apps',async req=>({applications:options.business?await options.business.ownedApps((await options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE])).userId):[]}));
  async function ownerId(req:FastifyRequest){return (await options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE])).userId;}
  scoped.get<{Params:{appId:string}}>('/apps/:appId/business-authorization',async req=>{if(!options.business)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.business.snapshot(req.params.appId,await ownerId(req));});
  scoped.get<{Params:{appId:string}}>('/apps/:appId/business-directory',async req=>{if(!options.business)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.business.directory(req.params.appId,await ownerId(req),req.query);});
  scoped.post<{Params:{appId:string}}>('/apps/:appId/business-authorization',{bodyLimit:65536},async req=>{if(!options.business)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.business.change(req.params.appId,await ownerId(req),req.body);});
  scoped.get('/apps',async req=>{
   if(!options.management)return {applications:[]};
   return options.management.employeeApps(()=>options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  });
  scoped.get<{Params:{appId:string}}>('/apps/:appId/ui',async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const query=z.object({path:z.string().max(512).default('/')}).strict().parse(req.query);
   return options.management.employeeUi(req.params.appId,query.path,()=>options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE]));
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/gateway',{bodyLimit:65536},async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   return options.management.invokeEmployee(req.params.appId,()=>options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE]),req.body,z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']));
  });
  scoped.post<{Params:{appId:string}}>('/apps/:appId/api',{bodyLimit:65536},async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const input=z.object({apiId:z.string().min(1).max(100),method:z.enum(['GET','POST','PUT','PATCH','DELETE']),path:z.string().min(1).max(512),payload:z.unknown().refine(value=>value!==undefined)}).strict().parse(req.body);
   return {result:await options.management.invokeEmployeeApi(req.params.appId,()=>options.service.resolveIdentity(req.cookies[EMPLOYEE_SESSION_COOKIE]),{...input,payload:input.payload},z.string().min(1).max(256).parse(req.headers['x-mop-employee-admission']))};
  });
 },{prefix:'/api/employee'});
 app.register(async scoped=>{
  scoped.setErrorHandler((error,_req,reply)=>{
   if(error instanceof EmployeeIdentityError||error instanceof AdminIdentityError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof z.ZodError)return reply.code(400).send({error:'EMPLOYEE_INVALID_INPUT'});
   return reply.code(503).send({error:'EMPLOYEE_MANAGEMENT_UNAVAILABLE'});
  });
  scoped.addHook('preHandler',async(req,reply)=>{reply.header('Cache-Control','no-store');if(req.method!=='GET'&&req.headers.origin!==options.origin)throw new EmployeeIdentityError(403,'EMPLOYEE_ORIGIN_DENIED');});
  scoped.get('/employee-accounts',async req=>options.service.list(await options.resolveAdmin(req),req.query));
  scoped.get<{Params:{appId:string}}>('/apps/:appId/employee-access',async req=>{const context=await options.resolveAdmin(req);if(!options.access)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.access.list(context,req.params.appId);});
  scoped.put<{Params:{appId:string}}>('/apps/:appId/employee-access',{bodyLimit:4096},async req=>{const context=await options.resolveAdmin(req);if(!options.access)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');return options.access.set(context,req.params.appId,req.body);});
  scoped.post('/employee-accounts',{bodyLimit:4096},async(req,reply)=>reply.code(201).send(await options.service.create(await options.resolveAdmin(req),req.body)));
  scoped.patch<{Params:{id:string}}>('/employee-accounts/:id',{bodyLimit:4096},async req=>options.service.update(await options.resolveAdmin(req),req.params.id,req.body));
 },{prefix:'/api/admin'});
}
