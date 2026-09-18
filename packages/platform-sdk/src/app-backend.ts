/** Node-only adapter for the existing credential-free L4 stdio channel. */
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Readable, Writable} from 'node:stream';
import {createAppGatewayClient, AppGatewayClientError, type AppGatewayJson} from './app-gateway.js';

const GATEWAY = 'AFC_GATEWAY_V1 ', API = 'AFC_API_V1 ';
/** Host-supplied audit identity, never a credential or a substitute for fresh authorization. */
export interface AppBackendEmployeeContext {
  readonly version: '1.0';
  readonly personId: string;
  readonly organizationUnitId: string;
  readonly requestId: string;
  readonly traceId: string;
  /** Fresh host-authorized permissions declared by this application. */
  readonly permissions?: readonly string[];
  /** Resolved application business grants. Absent only for legacy authorization. */
  readonly businessAuthorization?: {revision:string;grants:readonly AppBusinessGrant[];organizations:readonly {id:string;name:string}[]};

}
export interface AppBusinessGrant{permission:string;all:boolean;self:boolean;organizationIds:readonly string[]}
export function allowsAppResource(employee:AppBackendEmployeeContext,permission:string,resource:{organizationUnitId:string;ownerPersonId?:string|null}):boolean{
 const grant=employee.businessAuthorization?.grants.find(g=>g.permission===permission);
 return !!grant&&(grant.all||grant.organizationIds.includes(resource.organizationUnitId)||grant.self&&resource.ownerPersonId===employee.personId);
}
export function parseAppBackendEmployeeContext(value: unknown): Readonly<AppBackendEmployeeContext> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_EMPLOYEE_CONTEXT');
  const record=value as Record<string,unknown>;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!['organizationUnitId,personId,requestId,traceId,version','organizationUnitId,permissions,personId,requestId,traceId,version'].includes(Object.keys(record).filter(k=>k!=='businessAuthorization').sort().join(','))||record.version!=='1.0'||
    ![record.personId,record.organizationUnitId].every(v=>typeof v==='string'&&uuid.test(v))||
    ![record.requestId,record.traceId].every(v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f\u007f]/.test(v)))throw Error('INVALID_EMPLOYEE_CONTEXT');
  if(record.permissions!==undefined&&(!Array.isArray(record.permissions)||record.permissions.length>128||record.permissions.some(p=>typeof p!=='string'||!/^app\.[a-z0-9._-]+$/.test(p))||new Set(record.permissions).size!==record.permissions.length))throw Error('INVALID_EMPLOYEE_CONTEXT');
  if(record.businessAuthorization!==undefined){
   const a=record.businessAuthorization as {revision?:unknown;grants?:unknown;organizations?:unknown};
   if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).sort().join(',')!=='grants,organizations,revision'||typeof a.revision!=='string'||!uuid.test(a.revision)||!Array.isArray(a.grants)||a.grants.length>128)throw Error('INVALID_EMPLOYEE_CONTEXT');
   if(!Array.isArray(a.organizations)||a.organizations.length>128||a.organizations.some(o=>!o||Object.keys(o).sort().join(',')!=='id,name'||typeof o.id!=='string'||!uuid.test(o.id)||typeof o.name!=='string'||o.name.length>200))throw Error('INVALID_EMPLOYEE_CONTEXT');
   for(const g of a.grants){if(!g||typeof g!=='object'||Object.keys(g).sort().join(',')!=='all,organizationIds,permission,self'||typeof g.permission!=='string'||!/^app\.[a-z0-9._-]+$/.test(g.permission)||typeof g.all!=='boolean'||typeof g.self!=='boolean'||!Array.isArray(g.organizationIds)||g.organizationIds.length>2000||g.organizationIds.some((id:unknown)=>typeof id!=='string'||!uuid.test(id)))throw Error('INVALID_EMPLOYEE_CONTEXT');}
   record.businessAuthorization=Object.freeze({revision:a.revision,organizations:Object.freeze(a.organizations.map(o=>Object.freeze({...o}))),grants:Object.freeze(a.grants.map(g=>Object.freeze({...g,organizationIds:Object.freeze([...g.organizationIds])})))});
  }
  return Object.freeze({...record,...(record.permissions?{permissions:Object.freeze([...(record.permissions as string[])])}:{})}) as unknown as Readonly<AppBackendEmployeeContext>;
}
export interface AppBackendHandler {
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  path: string;
  /** Reject legacy frames without a host identity before executing employee business operations. */
  requireEmployeeContext?: boolean;
  execute(payload: AppGatewayJson, signal: AbortSignal, employee?: Readonly<AppBackendEmployeeContext>): Promise<AppGatewayJson>;
}
export function createAppBackend(options: {
  input: Readable;
  output: Writable;
  handlers: ReadonlyMap<string, AppBackendHandler>;
  timeoutMs?: number;
}) {
  const {input, output} = options, timeout = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000 || input.destroyed || output.destroyed || options.handlers.size > 128) throw Error('INVALID_BACKEND_OPTIONS');
  const handlers = new Map([...options.handlers].map(([key,value]) => [key,{...value}]));
  const invocation=new AsyncLocalStorage<string>();
  const controller = new AbortController();
  let buffer = Buffer.alloc(0), closed = false;
  let resolveClosed!:()=>void;
  const whenClosed = new Promise<void>(resolve=>{resolveClosed=resolve;});
  const pending = new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  const writes = new Set<(error?:Error|null)=>void>();
  const work = new Set<Promise<void>>();
  const ids = new Set<string>();
  const close = () => {
    if (closed) return;
    closed = true;buffer = Buffer.alloc(0);controller.abort();
    input.removeListener('data',receive);
    for(const entry of pending.values())entry.reject(new AppGatewayClientError('BACKEND_CLOSED'));
    pending.clear();for(const finish of writes)finish(new Error('BACKEND_CLOSED'));
    input.destroy();output.destroy();resolveClosed();
  };
  const write = (prefix:string,value:unknown,max:number) => new Promise<void>((resolve,reject)=>{
    if (closed) {reject(new AppGatewayClientError('BACKEND_CLOSED'));return;}
    let line:string;
    try {line=prefix+JSON.stringify(value)+'\n';if(Buffer.byteLength(line)>max)throw Error();}
    catch {reject(new AppGatewayClientError('INVALID_BACKEND_FRAME'));close();return;}
    let settled=false;
    const finish=(error?:Error|null)=>{if(settled)return;settled=true;clearTimeout(timer);writes.delete(finish);error?reject(error):resolve();};
    const timer=setTimeout(()=>{finish(new Error('BACKEND_TIMEOUT'));close();},timeout);
    writes.add(finish);
    try {output.write(line,finish);} catch {finish(new Error('BACKEND_WRITE_FAILED'));close();}
  });
  const gateway=createAppGatewayClient(async(request,signal)=>{
    if(closed||signal?.aborted)throw new AppGatewayClientError('BACKEND_CLOSED','not_started');
    if(pending.size>=16)throw new AppGatewayClientError('BACKEND_BUSY','not_started');
    const id=randomUUID();
    let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;
    const response=new Promise<unknown>((ok,fail)=>{resolve=ok;reject=fail;});
    pending.set(id,{resolve,reject});
    // Timeout/abort terminates this channel; never replay an uncertain write.
    const timer=setTimeout(close,timeout),abort=()=>close();signal?.addEventListener('abort',abort,{once:true});
    const invocationId=invocation.getStore();
    void write(GATEWAY,{id,request,...(invocationId?{invocationId}:{})},64*1024).catch(close);
    try{return await response;}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);pending.delete(id);}
  });
  function accept(line:Buffer) {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(line);
    const prefix=text.startsWith(GATEWAY)?GATEWAY:text.startsWith(API)?API:null;
    if(!prefix)throw Error('INVALID_BACKEND_FRAME');
    const frame=JSON.parse(text.slice(prefix.length));
    if(!frame||typeof frame!=='object'||Array.isArray(frame)||typeof frame.id!=='string'||! /^[0-9a-f-]{36}$/i.test(frame.id))throw Error('INVALID_BACKEND_FRAME');
    if(prefix===GATEWAY){
      const entry=pending.get(frame.id);if(!entry)throw Error('UNKNOWN_RESPONSE');
      const keys=Object.keys(frame).sort().join(',');
      if(keys==='id,response'){pending.delete(frame.id);entry.resolve(frame.response);}
      else if(keys==='error,id'){pending.delete(frame.id);entry.resolve({version:'1.0',error:frame.error});}
      else throw Error('INVALID_RESPONSE');
      return;
    }
    if(Object.keys(frame).sort().join(',')!=='id,request'||!frame.request||typeof frame.request!=='object'||Array.isArray(frame.request)||!['handler,method,path,payload','employee,handler,method,path,payload'].includes(Object.keys(frame.request).sort().join(',')))throw Error('INVALID_API_REQUEST');
    if(ids.has(frame.id)||ids.size>=4096||work.size>=16)throw Error('BACKEND_LIMIT');
    const handler=handlers.get(frame.request.handler);
    if(!handler||handler.method!==frame.request.method||handler.path!==frame.request.path)throw Error('API_DENIED');
    const employee='employee' in frame.request?parseAppBackendEmployeeContext(frame.request.employee):undefined;
    if(handler.requireEmployeeContext&&!employee)throw Error('EMPLOYEE_CONTEXT_REQUIRED');
    ids.add(frame.id);
    const task=Promise.resolve().then(async()=>{
      if(closed)return;
      const timer=setTimeout(close,timeout);
      try {
        const result=await invocation.run(frame.id,()=>handler.execute(frame.request.payload,controller.signal,employee));
        if(!closed)await write(API,{id:frame.id,result},256*1024);
      }finally{clearTimeout(timer);}
    }).catch(close).finally(()=>work.delete(task));
    work.add(task);
  }
  function receive(chunk:Buffer|string) {
    if(closed)return;
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    let offset=0;
    while(!closed&&offset<bytes.length){
      const newline=bytes.indexOf(10,offset),end=newline<0?bytes.length:newline;
      if(buffer.length+end-offset>256*1024){close();return;}
      buffer=Buffer.concat([buffer,bytes.subarray(offset,end)]);
      if(newline<0)return;
      const line=buffer;buffer=Buffer.alloc(0);
      try{accept(line);}catch{close();}
      offset=newline+1;
    }
  }
  input.on('data',receive);input.once('end',close);input.once('close',close);input.on('error',close);
  output.once('close',close);output.once('finish',close);output.on('error',close);
  return {gateway,signal:controller.signal,whenClosed,close,
    async drain(){if(!closed)throw Error('CLOSE_REQUIRED');await Promise.all([...work]);},
  };
}
