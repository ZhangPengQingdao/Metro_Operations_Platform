import {createAppGatewayClient,AppGatewayClientError,type AppGatewayJson} from './app-gateway.js';
/** Minimal browser message surface, injectable for protocol conformance tests. */
export interface AppSandboxPort {
 parent:object;
 send(message:unknown,targetOrigin:string):void;
 listen(listener:(event:{source:unknown;origin:string;data:unknown})=>void):()=>void;
}
/** App-side adapter for the existing platform SandboxBridgeBroker. No wildcard origin,
 * ambient credentials, operation grants, iframe creation or automatic replay. */
export function createAppSandboxClient(options:{appId:string;platformOrigin:string;port:AppSandboxPort;timeoutMs?:number}) {
 const {appId,platformOrigin,port}=options,timeoutMs=options.timeoutMs??10_000;
 let url:URL;try{url=new URL(platformOrigin);}catch{throw new AppGatewayClientError('INVALID_SANDBOX','not_started');}
 if(url.origin!==platformOrigin||!['https:','http:'].includes(url.protocol)||appId.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(appId)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new AppGatewayClientError('INVALID_SANDBOX','not_started');
 const parent=port.parent,send=port.send.bind(port);let session:string|undefined,closed=false,sequence=0;
 const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
 let unlisten=()=>{};
 const close=()=>{if(closed)return;closed=true;unlisten();for(const item of pending.values())item.reject(new AppGatewayClientError('ABORTED','unknown'));pending.clear();};
 unlisten=port.listen(event=>{
  if(closed||event.source!==parent||event.origin!==platformOrigin)return;
  const value=event.data;
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const frame=value as Record<string,unknown>;
  if(frame.version!=='1.0'||frame.appId!==appId)return;
  if(frame.type==='init'){
   if(Object.keys(frame).sort().join(',')!=='appId,session,type,version'||typeof frame.session!=='string'||! /^[0-9a-f]{32}$/.test(frame.session))return;
   if(session!==undefined){if(session!==frame.session)close();return;}session=frame.session;return;
  }
  if(frame.type!=='response'||!session||frame.session!==session||typeof frame.id!=='number')return;
  const item=pending.get(frame.id);if(!item)return;
  pending.delete(frame.id);
  const keys=Object.keys(frame).sort().join(',');
  if(frame.ok===true&&keys==='appId,id,ok,result,session,type,version')item.resolve({version:'1.0',requestId:`sandbox-${frame.id}`,traceId:`sandbox-${frame.id}`,result:frame.result});
  else if(frame.ok===false&&keys==='appId,error,id,ok,session,type,version'&&['INVALID_REQUEST','UNKNOWN_METHOD','LIMIT_EXCEEDED','DENIED','FAILED'].includes(String(frame.error)))
   item.reject(new AppGatewayClientError(String(frame.error),['FAILED','DENIED'].includes(String(frame.error))?'unknown':'not_started'));
  else item.reject(new AppGatewayClientError('INVALID_RESPONSE','unknown'));
 });
 const client=createAppGatewayClient(async(request,signal)=>{
  if(closed||!session)throw new AppGatewayClientError('SANDBOX_NOT_READY','not_started');
  if(pending.size>=8||sequence>=128)throw new AppGatewayClientError('LIMIT_EXCEEDED','not_started');
  const id=++sequence;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort=()=>{};
  try{return await new Promise<unknown>((resolve,reject)=>{
   pending.set(id,{resolve,reject});
   abort=()=>{pending.delete(id);reject(new AppGatewayClientError('ABORTED','unknown'));};
   signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{pending.delete(id);reject(new AppGatewayClientError('TIMEOUT','unknown'));},timeoutMs);
   try{send({version:'1.0',type:'request',appId,session,id,method:request.operation,params:request.params},platformOrigin);}
   catch{pending.delete(id);reject(new AppGatewayClientError('TRANSPORT_FAILED','unknown'));}
  });}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 });
 return Object.freeze({invoke:(operation:string,params:AppGatewayJson,signal?:AbortSignal)=>client.invoke(operation,params,signal),ready:()=>!closed&&!!session,close});
}

/** Invoke a manifest-declared application API through the employee sandbox host. */
export function createAppApiClient(client:Pick<ReturnType<typeof createAppSandboxClient>,'invoke'>){
 return Object.freeze({invoke(apiId:string,payload:AppGatewayJson,signal?:AbortSignal){
  if(typeof apiId!=='string'||apiId.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(apiId))return Promise.reject(new AppGatewayClientError('INVALID_REQUEST','not_started'));
  return client.invoke(`application.api.${apiId}`,payload,signal);
 }});
}
