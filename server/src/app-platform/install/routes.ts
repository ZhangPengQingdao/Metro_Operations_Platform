import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import { assertInstallAdmin, type AppInstaller } from './service.js';
import { withInstallUpload, INSTALL_BODY_LIMIT } from './wire.js';
import { InstallError } from './journal.js';
import { AppPackageError } from '../developer/package.js';
export interface AppInstallRoutesOptions {
 origin:string;uploadRoot:string;
 installer:Pick<AppInstaller,'install'|'status'|'recover'>;
 resolveContext(request:FastifyRequest):Promise<PlatformManagementContext>;
}
export async function registerAppInstallRoutes(app:FastifyInstance,options:AppInstallRoutesOptions){
 if(new URL(options.origin).origin!==options.origin||!['https:','http:'].includes(new URL(options.origin).protocol))throw Error('INVALID_PLATFORM_ORIGIN');
 let uploads=0;const admitted=new WeakSet<FastifyRequest>();
 const contexts=new WeakMap<FastifyRequest,PlatformManagementContext>();
 const onRequest=async(request:FastifyRequest,reply:import('fastify').FastifyReply)=>{
  reply.header('Cache-Control','no-store');
  if(request.method==='POST'&&request.headers.origin!==options.origin)return reply.code(403).send({error:'INSTALL_ACCESS_DENIED'});
  try{const context=await options.resolveContext(request);await assertInstallAdmin(context);contexts.set(request,context);
   if(request.method==='POST'&&request.url==='/api/v1/app-installations'){if(uploads>=2)return reply.code(429).send({error:'INSTALL_BUSY'});uploads++;admitted.add(request);}}catch{return reply.code(403).send({error:'INSTALL_ACCESS_DENIED'});}
 };
 const failure=(error:unknown,reply:import('fastify').FastifyReply)=>{
  const code=error instanceof InstallError||error instanceof AppPackageError?error.code:'INSTALL_OUTCOME_UNKNOWN';
  return reply.code(code==='INSTALL_ACCESS_DENIED'?403:code==='INSTALL_NOT_FOUND'?404:409).send({error:code});
 };
 app.post('/api/v1/app-installations',{bodyLimit:INSTALL_BODY_LIMIT,onRequest,onResponse:async request=>{if(admitted.delete(request))uploads--;}},async(request,reply)=>{
  try{return await withInstallUpload(request.body,options.uploadRoot,input=>options.installer.install(contexts.get(request)!,input));}catch(error){return failure(error,reply);}
 });
 app.route<{Params:{appId:string}}>({method:['GET','POST'],url:'/api/v1/app-installations/:appId',bodyLimit:4096,onRequest,handler:async(request,reply)=>{
  if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(request.params.appId)||request.params.appId.length>64)return reply.code(400).send({error:'INVALID_APP_ID'});
  try{
   if(request.method==='GET')return await options.installer.status(contexts.get(request)!,request.params.appId);
   const body=request.body as {operation?:unknown;revision?:unknown}|null;
   if(!body||Object.keys(body).length!==2||body.operation!=='recover'||!Number.isSafeInteger(body.revision)||Number(body.revision)<1)return reply.code(400).send({error:'INVALID_INSTALL_REQUEST'});
   return await options.installer.recover(contexts.get(request)!,request.params.appId,Number(body.revision));
  }catch(error){return failure(error,reply);}
 }});
}
