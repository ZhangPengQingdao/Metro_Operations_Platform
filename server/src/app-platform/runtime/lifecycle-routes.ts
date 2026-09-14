import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppLifecycleHost } from './lifecycle-host.js';
import { createAppLifecycleManagement } from './lifecycle-management.js';

export interface AppLifecycleRoutesOptions {
 /** Trusted composition owns one stable host per installation. Never construct from request options. */
 getHost(appId:string):Promise<Pick<AppLifecycleHost,'status'|'execute'|'prepareCredential'|'recover'>|null>;
 /** Authenticate session and resolve a fresh native platform actor. */
 resolveContext(request:FastifyRequest):Promise<PlatformManagementContext>;
 /** Canonical platform origin. Mutations require this exact Origin, including bearer requests. */
 origin:string;
}
export async function registerAppLifecycleRoutes(app:FastifyInstance,options:AppLifecycleRoutesOptions) {
 const origin=new URL(options.origin).origin;
 if(origin!==options.origin||!['http:','https:'].includes(new URL(origin).protocol))throw Error('INVALID_PLATFORM_ORIGIN');
 const {getHost,resolveContext}=options;
 app.route<{Params:{appId:string}}>({method:['GET','POST'],url:'/api/v1/apps/:appId/lifecycle',bodyLimit:65536,
  async handler(request,reply){
   reply.header('Cache-Control','no-store');
   const appId=request.params.appId;
   if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(appId)||appId.length>64)return reply.code(400).send({error:'INVALID_APP_ID'});
   if(request.method==='POST'&&request.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN_DENIED'});
   try{
    const context=await resolveContext(request);
    if(!isNativeManagementActor(context)||!(await context.authorize('platform.authorization.manage',{})).allowed)return reply.code(403).send({error:'ACCESS_DENIED'});
    const host=await getHost(appId);if(!host)return reply.code(404).send({error:'APP_NOT_CONFIGURED'});
    const headers=new Headers();if(request.headers['content-type'])headers.set('content-type',request.headers['content-type']);
    const input=new Request(origin+request.url,{method:request.method,headers,...(request.method==='POST'?{body:JSON.stringify(request.body)}:{})});
    const response=await createAppLifecycleManagement({host,resolveContext:async()=>context})(input);
    return reply.code(response.status).type('application/json').send(await response.text());
   }catch{return reply.code(403).send({error:'ACCESS_DENIED'});}
  }
 });
}
