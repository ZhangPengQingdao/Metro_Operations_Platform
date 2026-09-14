/** Node-only adapter for the existing credential-free L4 stdio channel. */
import {randomUUID} from 'node:crypto';
import type {Readable, Writable} from 'node:stream';
import {createAppGatewayClient, AppGatewayClientError, type AppGatewayJson} from './app-gateway.js';

const GATEWAY = 'AFC_GATEWAY_V1 ', API = 'AFC_API_V1 ';
export interface AppBackendHandler {
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  path: string;
  execute(payload: AppGatewayJson, signal: AbortSignal): Promise<AppGatewayJson>;
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
    void write(GATEWAY,{id,request},64*1024).catch(close);
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
    if(Object.keys(frame).sort().join(',')!=='id,request'||!frame.request||typeof frame.request!=='object'||Array.isArray(frame.request)||Object.keys(frame.request).sort().join(',')!=='handler,method,path,payload')throw Error('INVALID_API_REQUEST');
    if(ids.has(frame.id)||ids.size>=4096||work.size>=16)throw Error('BACKEND_LIMIT');
    const handler=handlers.get(frame.request.handler);
    if(!handler||handler.method!==frame.request.method||handler.path!==frame.request.path)throw Error('API_DENIED');
    ids.add(frame.id);
    const task=Promise.resolve().then(async()=>{
      if(closed)return;
      const timer=setTimeout(close,timeout);
      try {
        const result=await handler.execute(frame.request.payload,controller.signal);
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
