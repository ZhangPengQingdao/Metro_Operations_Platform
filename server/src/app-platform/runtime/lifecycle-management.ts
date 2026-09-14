import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppLifecycleHost } from './lifecycle-host.js';
/** Mount only behind the platform's authenticated session/CSRF boundary. The resolver must
 * authenticate the request; no actor, credential, Engine options or settlement evidence is accepted. */
export function createAppLifecycleManagement(options: {
 host: Pick<AppLifecycleHost,'status'|'execute'|'prepareCredential'|'recover'>;
 resolveContext(request:Request):Promise<PlatformManagementContext>;
}) {
 const {host,resolveContext}=options;
 return async(request:Request):Promise<Response>=>{
  const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  try {
   const context=await resolveContext(request);
   if(!isNativeManagementActor(context)||!(await context.authorize('platform.authorization.manage',{})).allowed)return reply(403,{error:'ACCESS_DENIED'});
   if(request.method==='GET')return reply(200,await host.status(context));
   if(request.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(415,{error:'JSON_REQUIRED'});
   const reader=request.body?.getReader();if(!reader)return reply(400,{error:'INVALID_REQUEST'});
   const chunks:Uint8Array[]=[];let size=0;let timedOut=false;
   const timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{});},5000);
   try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return reply(413,{error:'PAYLOAD_TOO_LARGE'});}chunks.push(value);}}
   finally{clearTimeout(timer);reader.releaseLock();}
   if(timedOut)return reply(408,{error:'REQUEST_TIMEOUT'});
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return reply(400,{error:'INVALID_REQUEST'});}
   if(!body||typeof body!=='object'||Array.isArray(body))return reply(400,{error:'INVALID_REQUEST'});
   const input=body as Record<string,unknown>;
   if(!Number.isSafeInteger(input.revision)||Number(input.revision)<1)return reply(400,{error:'INVALID_REQUEST'});
   const revision=Number(input.revision);
   if(input.operation==='prepareCredential'||input.operation==='recover') {
    if(Object.keys(input).sort().join(',')!=='operation,revision')return reply(400,{error:'INVALID_REQUEST'});
    return reply(200,await host[input.operation](context,revision));
   }
   const keys=Object.keys(input).sort().join(',');
   if(input.operation!=='execute'||!['action,operation,revision','action,operation,revision,targetManifest'].includes(keys)||!['install','enable','disable','upgrade','rollback','uninstall'].includes(String(input.action)))return reply(400,{error:'INVALID_REQUEST'});
   return reply(200,await host.execute(context,{revision,action:input.action as Parameters<AppLifecycleHost['execute']>[1]['action'],...(Object.hasOwn(input,'targetManifest')?{targetManifest:input.targetManifest}:{})}));
  } catch {return reply(409,{error:'LIFECYCLE_NOT_COMPLETED'});}
 };
}
