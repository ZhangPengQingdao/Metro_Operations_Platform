import {createServer} from 'node:http';
import {chmod,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ConnectablePool} from '../../core/database/index.js';
import type {PlatformAdministratorContext} from '../../platform/context/index.js';
import {appendAdminAudit} from '../../core/admin-identity/index.js';
import type {MaintenanceSnapshot} from './maintenance.js';
export async function maintenanceActor(pool:ConnectablePool,actorId:string,taskId:string):Promise<PlatformAdministratorContext>{
 const db=await pool.connect();
 try{
  const result=await db.query("SELECT id,username,display_name FROM platform_admin_accounts WHERE id=$1 AND status='active'",[actorId]) as {rows:{id:string;username:string;display_name:string}[]};
  const row=result.rows[0];if(!row)throw Error('MAINTENANCE_ADMIN_DISABLED');
  return {actorType:'administrator',administrator:{id:row.id,username:row.username,displayName:row.display_name},execution:{type:'platform'},request:{requestId:taskId,traceId:taskId,startedAt:new Date().toISOString()},authorize:async permission=>{
   const client=await pool.connect();try{
    const result=await client.query("SELECT 1 FROM platform_admin_accounts WHERE id=$1 AND status='active'",[actorId]) as {rows:unknown[]};
    const allowed=result.rows.length===1&&['platform.authorization.read','platform.authorization.manage','platform.system.update'].includes(permission);
    return {id:randomUUID(),allowed,reasonCode:allowed?'allowed':'permission_not_granted',permissionCode:permission,subjectType:'administrator',effectiveScopes:allowed?[{source:'role',scope:{kind:'all',targets:[]}}]:[],decidedAt:new Date().toISOString()};
   }finally{client.release();}
  }};
 }finally{db.release();}
}
/** Dedicated Unix socket inside an owner-only directory, never mounted on public HTTP routes. */
export async function startMaintenanceControl(options:{socketPath:string;pool:ConnectablePool;status:()=>MaintenanceSnapshot|null;prepare:(context:PlatformAdministratorContext,taskId:string)=>Promise<unknown>;restore:(context:PlatformAdministratorContext,taskId:string)=>Promise<unknown>}){
 const input=z.object({taskId:z.string().uuid(),actorId:z.string().uuid(),action:z.enum(['prepare','restore'])}).strict();
 const server=createServer(async(req,res)=>{
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  try{
   if(req.method==='GET'&&req.url==='/status'){send(200,{protocol:1,snapshot:options.status()});return;}
   if(req.method!=='POST'||req.url!=='/maintenance')throw Error('INVALID_REQUEST');
   let bytes=0;const chunks:Buffer[]=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw Error('INVALID_REQUEST');chunks.push(chunk);}
   const body=input.parse(JSON.parse(Buffer.concat(chunks).toString()));
   const context=await maintenanceActor(options.pool,body.actorId,body.taskId);
   const db=await options.pool.connect();try{await appendAdminAudit(db,{actorId:body.actorId,action:`platform.update.maintenance.${body.action}`,targetId:body.taskId});}finally{db.release();}
   const snapshot=await options[body.action](context,body.taskId);send(200,{protocol:1,snapshot});
  }catch(error){const message=error instanceof Error?error.message:'';send(409,{error:/^(MAINTENANCE_|ENABLED_APPLICATION_NOT_SERVING|RUNTIME_WORK_PENDING|APPROVAL_|APP_RUNTIME_APPROVAL_REQUIRED)/.test(message)?message:'MAINTENANCE_NOT_COMPLETED',snapshot:options.status()});}
 });
 server.requestTimeout=15000;
 try{await unlink(options.socketPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.socketPath,resolve);});await chmod(options.socketPath,0o600);
 return {close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
