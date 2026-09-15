import {request as httpRequest} from 'node:http';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {AdminIdentityError,appendAdminAudit} from '../../core/admin-identity/index.js';
import type {ConnectablePool} from '../../core/database/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
export function callUpdater(socketPath:string,path:'/status'|'/check'|'/task',body?:unknown):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  const fail=()=>reject(new AdminIdentityError(503,'UPDATER_UNAVAILABLE'));
  const data=body===undefined?undefined:JSON.stringify(body);
  const request=httpRequest({socketPath,path,method:data===undefined?'GET':'POST',headers:data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}},response=>{
   const chunks:Buffer[]=[];let size=0;
   response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){response.destroy();fail();}else chunks.push(chunk);});
   response.on('error',fail);response.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(response.statusCode!==200)reject(new AdminIdentityError(409,'UPDATE_NOT_ACCEPTED'));else resolve(value);}catch{fail();}});
  });
  const timer=setTimeout(()=>{request.destroy();fail();},12000);request.on('close',()=>clearTimeout(timer));request.on('error',fail);request.end(data);
 });
}
export function registerPlatformUpdateRoutes(app:FastifyInstance,options:{origin:string;socketPath?:string;pool:ConnectablePool;resolveAdmin(req:FastifyRequest):Promise<PlatformAdministratorContext>;call?:typeof callUpdater}){
 app.register(async scoped=>{
  scoped.setErrorHandler((error,_req,reply)=>reply.code(error instanceof AdminIdentityError?error.statusCode:error instanceof z.ZodError?400:503).send({error:error instanceof AdminIdentityError?error.code:error instanceof z.ZodError?'ADMIN_INVALID_INPUT':'UPDATER_UNAVAILABLE'}));
  scoped.addHook('onRequest',async(req,reply)=>{reply.header('Cache-Control','no-store');if(req.method!=='GET'&&req.headers.origin!==options.origin)throw new AdminIdentityError(403,'ADMIN_ORIGIN_DENIED');
   const actor=await options.resolveAdmin(req);if(actor.actorType!=='administrator'||!(await actor.authorize('platform.system.update',{})).allowed)throw new AdminIdentityError(403,'UPDATE_ACCESS_DENIED');});
  const call=(path:'/status'|'/check'|'/task',body?:unknown)=>{if(!options.socketPath)throw new AdminIdentityError(503,'UPDATER_NOT_CONFIGURED');return (options.call??callUpdater)(options.socketPath,path,body);};
  scoped.get('/status',async()=>options.socketPath?call('/status'):{configured:false});
  scoped.post('/check',{bodyLimit:1024},async req=>{z.object({}).strict().parse(req.body??{});return call('/check',{});});
  scoped.post('/tasks',{bodyLimit:4096},async req=>{
   const input=z.object({requestId:z.string().uuid(),action:z.enum(['download','install']),version:z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)}).strict().parse(req.body);
   const context=await options.resolveAdmin(req);
   if(!(await context.authorize('platform.system.update',{})).allowed)throw new AdminIdentityError(403,'UPDATE_ACCESS_DENIED');
   if(!options.socketPath)throw new AdminIdentityError(503,'UPDATER_NOT_CONFIGURED');
   const db=await options.pool.connect();try{await appendAdminAudit(db,{actorId:context.administrator.id,action:`platform.update.${input.action}.requested`,targetId:input.requestId});}finally{db.release();}
   return call('/task',{...input,actorId:context.administrator.id});
  });
 },{prefix:'/api/admin/updates'});
}
