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
 const filePending=new Map<number,{method:'upload'|'read'|'list';resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
 const routeListeners=new Set<(path:string)=>void>();let pendingRoute:string|undefined;
 let unlisten=()=>{};
 const close=()=>{if(closed)return;closed=true;unlisten();routeListeners.clear();for(const item of pending.values())item.reject(new AppGatewayClientError('ABORTED','unknown'));pending.clear();for(const item of filePending.values())item.reject(new AppGatewayClientError('ABORTED','unknown'));filePending.clear();};
 const deliverRoute=(path:string)=>{
  if(!routeListeners.size){pendingRoute=path;return;}
  try{for(const listener of routeListeners)listener(path);}catch{return;}
  pendingRoute=undefined;
  setTimeout(()=>{if(!closed&&session)try{send({version:'1.0',type:'route-ready',appId,session,path},platformOrigin);}catch{close();}},0);
 };
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
  if(frame.type==='route'){
   if(!session||frame.session!==session||Object.keys(frame).sort().join(',')!=='appId,path,session,type,version'||typeof frame.path!=='string'||frame.path.length>256||!(frame.path==='/'||/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(frame.path)))return;
   deliverRoute(frame.path);return;
  }
  if(frame.type==='file-response'&&session&&frame.session===session&&typeof frame.id==='number'){
   const item=filePending.get(frame.id);if(!item)return;filePending.delete(frame.id);
   const keys=Object.keys(frame).sort().join(',');
   if(frame.ok===false&&keys==='appId,error,id,ok,session,type,version'&&typeof frame.error==='string'&&['INVALID_REQUEST','UNKNOWN_METHOD','LIMIT_EXCEEDED','DENIED','FAILED','FILE_TOO_LARGE','UNSUPPORTED_FILE','INVALID_FILE','ATTACHMENT_LIMIT','ACCESS_DENIED'].includes(frame.error)){
    item.reject(new AppGatewayClientError(frame.error,frame.error==='FAILED'?'unknown':'not_started'));return;
   }
   if(frame.ok===true&&keys==='appId,id,ok,result,session,type,version'){
    if(item.method==='read'){
     const result=frame.result as {blob?:unknown;fileName?:unknown};
     if(result&&typeof result==='object'&&Object.keys(result).sort().join(',')==='blob,fileName'&&result.blob instanceof Blob&&result.blob.size>0&&result.blob.size<=50*1024*1024&&typeof result.fileName==='string'&&result.fileName.length<=180){item.resolve(result);return;}
    }else if(frame.result&&typeof frame.result==='object'&&!Array.isArray(frame.result)){item.resolve(frame.result);return;}
   }
   item.reject(new AppGatewayClientError('INVALID_RESPONSE','unknown'));return;
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
  if(pending.size>=8||sequence>=2147483647)throw new AppGatewayClientError('LIMIT_EXCEEDED','not_started');
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
 const fileRequest=(method:'upload'|'read'|'list',params:AppGatewayJson,blob?:Blob,signal?:AbortSignal):Promise<unknown>=>{
  if(closed||!session) return Promise.reject(new AppGatewayClientError('SANDBOX_NOT_READY','not_started'));
  if(filePending.size>=2||sequence>=2147483647||method==='upload'&&(!(blob instanceof Blob)||blob.size<1||blob.size>50*1024*1024))return Promise.reject(new AppGatewayClientError('INVALID_REQUEST','not_started'));
  const id=++sequence;
  return new Promise((resolve,reject)=>{
   let timer:ReturnType<typeof setTimeout>;
   const finish=(error?:Error,value?:unknown)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);filePending.delete(id);if(error)reject(error);else resolve(value);};
   const abort=()=>finish(new AppGatewayClientError('ABORTED','unknown'));
   timer=setTimeout(()=>finish(new AppGatewayClientError('TIMEOUT','unknown')),600_000);
   filePending.set(id,{method,resolve:value=>finish(undefined,value),reject:error=>finish(error)});
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted){abort();return;}
   try{send({version:'1.0',type:'file-request',appId,session,id,method,params,...(blob?{blob}:{})},platformOrigin);}
   catch{finish(new AppGatewayClientError('TRANSPORT_FAILED','unknown'));}
  });
 };
 return Object.freeze({invoke:(operation:string,params:AppGatewayJson,signal?:AbortSignal)=>client.invoke(operation,params,signal),ready:()=>!closed&&!!session,
  uploadAttachment:(blob:Blob,params:AppGatewayJson,signal?:AbortSignal)=>fileRequest('upload',params,blob,signal),
  readAttachment:(params:AppGatewayJson,signal?:AbortSignal)=>fileRequest('read',params,undefined,signal),
  listAttachments:(params:AppGatewayJson,signal?:AbortSignal)=>fileRequest('list',params,undefined,signal),
  onRouteChange(listener:(path:string)=>void){if(closed)throw new AppGatewayClientError('ABORTED','not_started');routeListeners.add(listener);if(pendingRoute)deliverRoute(pendingRoute);return()=>routeListeners.delete(listener);},close});
}

/** Invoke a manifest-declared application API through the employee sandbox host. */
export function createAppApiClient(client:Pick<ReturnType<typeof createAppSandboxClient>,'invoke'>){
 return Object.freeze({invoke(apiId:string,payload:AppGatewayJson,signal?:AbortSignal){
  if(typeof apiId!=='string'||apiId.length>64||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(apiId))return Promise.reject(new AppGatewayClientError('INVALID_REQUEST','not_started'));
  return client.invoke(`application.api.${apiId}`,payload,signal);
 }});
}
