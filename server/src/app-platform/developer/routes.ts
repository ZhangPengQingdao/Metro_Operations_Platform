import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {ConnectablePool,QueryableClient} from '../../core/database/index.js';
import {EmployeeIdentityError} from '../../platform/employee-identity/index.js';
import type {AppManagement} from '../management/service.js';
import {GatewayError} from '../gateway/model.js';
import {AppV2CallError} from '../v2/host.js';
import {DeveloperKeys} from './keys.js';
import {PUBLIC_DIRECTORIES,readPublicDirectory,directoryQuery} from './directory.js';
import {appCallInput} from './app-interfaces.js';
import {registerDeveloperDownloads} from '../admin/developer-downloads.js';
type Options={pool:ConnectablePool&QueryableClient;management?:AppManagement};
function limiter(){const entries=new Map<string,{count:number;until:number}>();return (id:string)=>{const now=Date.now();for(const [key,row] of entries)if(row.until<=now)entries.delete(key);if(!entries.has(id)&&entries.size>=10000)throw new EmployeeIdentityError(429,'DEVELOPER_RATE_LIMIT');const row=entries.get(id)??{count:0,until:now+60000};entries.set(id,row);if(++row.count>60)throw new EmployeeIdentityError(429,'DEVELOPER_RATE_LIMIT');};}
/** Must be mounted inside the employee session/Origin/password-change protected scope. */
export function registerEmployeeDeveloperRoutes(app:FastifyInstance,options:Options&{personId(req:FastifyRequest):Promise<string>}){
 const keys=new DeveloperKeys(options.pool),limit=limiter();registerDeveloperDownloads(app);
 app.get('/developer/keys',async req=>keys.list(await options.personId(req)));
 app.post('/developer/keys',{bodyLimit:4096},async req=>{const personId=await options.personId(req);limit(personId);return keys.create(personId,req.body);});
 app.post<{Params:{id:string}}>('/developer/keys/:id/revoke',{bodyLimit:1024},async req=>{const {requestId}=z.object({requestId:z.string().uuid()}).strict().parse(req.body);return keys.revoke(await options.personId(req),req.params.id,requestId);});
 app.get('/developer/history',async req=>keys.history(await options.personId(req)));
 app.get('/developer/directories',async()=>({directories:PUBLIC_DIRECTORIES}));
 app.get('/developer/directory',async req=>{const personId=await options.personId(req);limit(personId);const p=directoryQuery.parse(req.query);await keys.audit(personId,null,'directory.read',p.resource);return readPublicDirectory(options.pool,p);});
 app.get('/developer/interfaces',async req=>({interfaces:await options.management?.interfaces.catalog(await options.personId(req))??[]}));
 app.get('/developer/catalog',async req=>({interfaces:await options.management?.interfaces.describe(await options.personId(req))??[]}));
 app.post('/developer/call',{bodyLimit:65536},async req=>{
  if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
  const personId=await options.personId(req);limit(personId);const p=appCallInput.parse(req.body);await keys.audit(personId,null,'app.call',`${p.appId}/${p.apiId}`);
  return {result:await options.management.interfaces.call(personId,p)};
 });
}
/** Bearer-only development API. Never accepted by employee or administrator management routes. */
export function registerDeveloperApi(app:FastifyInstance,options:Options&{origin:string}){
 const keys=new DeveloperKeys(options.pool),limit=limiter();
 app.register(async scoped=>{
  const identities=new WeakMap<FastifyRequest,Awaited<ReturnType<DeveloperKeys['authenticate']>>>();
  scoped.addHook('preHandler',async(req,reply)=>{
   reply.header('Cache-Control','no-store');
   if(req.headers.origin&&req.headers.origin!==options.origin)throw new EmployeeIdentityError(403,'DEVELOPER_ORIGIN_DENIED');
   const identity=await keys.authenticate(req.headers.authorization);limit(identity.id);identities.set(req,identity);
  });
  scoped.setErrorHandler((error,_req,reply)=>{
   if(error instanceof EmployeeIdentityError||error instanceof GatewayError||error instanceof AppV2CallError)return reply.code(error.statusCode).send({error:error.code});
   if(error instanceof z.ZodError)return reply.code(400).send({error:'INVALID_PARAMS'});
   if(error&&typeof error==='object'&&'statusCode' in error&&typeof error.statusCode==='number'&&error.statusCode>=400&&error.statusCode<500)return reply.code(error.statusCode).send({error:error.statusCode===413?'PAYLOAD_TOO_LARGE':'INVALID_PARAMS'});
   return reply.code(503).send({error:'DEVELOPER_UNAVAILABLE'});
  });
  async function access(req:FastifyRequest,scope:'directory'|'apps',action:string,target:string){
   const identity=identities.get(req)!;if(!identity.scopes.includes(scope))throw new EmployeeIdentityError(403,'ACCESS_DENIED');
   await keys.audit(identity.personId,identity.id,action,target);return identity;
  }
  registerDeveloperDownloads(scoped,undefined,'/downloads');
  scoped.get('/catalog',async req=>{const identity=await access(req,'apps','app.catalog','');const interfaces=await options.management?.interfaces.describe(identity.personId)??[];await keys.authenticate(req.headers.authorization);return {interfaces};});
  scoped.get('/directories',async req=>{await access(req,'directory','directory.catalog','');return {directories:PUBLIC_DIRECTORIES};});
  scoped.get('/directory',async req=>{const p=directoryQuery.parse(req.query);await access(req,'directory','directory.read',p.resource);const result=await readPublicDirectory(options.pool,p);await keys.authenticate(req.headers.authorization);return result;});
  scoped.get('/interfaces',async req=>{const identity=await access(req,'apps','app.catalog','');const interfaces=await options.management?.interfaces.catalog(identity.personId)??[];await keys.authenticate(req.headers.authorization);return {interfaces};});
  scoped.post('/call',{bodyLimit:65536},async req=>{
   if(!options.management)throw new EmployeeIdentityError(503,'APP_MANAGEMENT_UNAVAILABLE');
   const p=appCallInput.parse(req.body),identity=await access(req,'apps','app.call',`${p.appId}/${p.apiId}`);
   const result=await options.management.interfaces.call(identity.personId,p);await keys.authenticate(req.headers.authorization);return {result};
  });
 },{prefix:'/api/developer'});
}
