import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { request as httpsRequest, RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { AppOutboundClient } from '../src/app-platform/gateway/outbound.ts';
import type { PlatformActorContext } from '../src/platform/context/index.ts';
const context = { actorType:'service',trustedIdentity:{source:'service'},execution:{type:'service',appId:'demo',serviceIdentityId:'identity'},request:{requestId:'r',traceId:'t',startedAt:new Date().toISOString()},authorize:async()=>{throw new Error('not used');} } satisfies PlatformActorContext;
const origin='https://public.example.com';
const input={url:origin+'/api',method:'GET' as const};
const signal=()=>new AbortController().signal;
function fixture(options: {status?:number;body?:string;encoding?:string;hang?:boolean}={}) {
  let captured:RequestOptions | undefined, sent=0;const written:string[]=[];
  const request=((_url:URL,config:RequestOptions,callback:(response:IncomingMessage)=>void)=>{
    captured=config;sent++;
    const req=new EventEmitter() as ClientRequest;
    req.write=((body:string)=>{written.push(body);return true;}) as ClientRequest['write'];
    req.destroy=(()=>req) as ClientRequest['destroy'];
    req.end=(()=>{
      if(options.hang)return req;
      queueMicrotask(()=>{
        const res=new EventEmitter() as IncomingMessage;res.statusCode=options.status??200;res.headers=options.encoding?{'content-encoding':options.encoding}:{};
        res.destroy=(()=>res) as IncomingMessage['destroy'];
        callback(res);res.emit('data',Buffer.from(options.body??'{"ok":true}'));res.emit('end');
      });return req;
    }) as ClientRequest['end'];
    return req;
  }) as typeof httpsRequest;
  return {request,get captured(){return captured;},get sent(){return sent;},written};
}
const policy=async()=>({declaredOrigins:[origin],approvedOrigins:[origin]});
test('outbound validates all DNS answers and pins transport without credential/header forwarding',async()=>{
  const f=fixture();let lookups=0;
  const client=new AppOutboundClient({policy,request:f.request,lookup:async()=>{lookups++;return[{address:'93.184.216.34',family:4}];}});
  assert.deepEqual(await client.execute(context,input,signal()),{status:200,body:'{"ok":true}'});
  assert.equal(lookups,1);assert.equal(f.captured?.agent,false);
  const pinned=await new Promise(resolve=>f.captured!.lookup!('public.example.com',{},(error,address,family)=>resolve({error,address,family})));
  assert.deepEqual(pinned,{error:null,address:'93.184.216.34',family:4});
  assert.deepEqual(f.captured?.headers,{accept:'application/json','accept-encoding':'identity'});
});
test('outbound rejects undeclared, unapproved, private, mixed, invalid and fake DNS without sending',async()=>{
  for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}],[{address:'198.18.0.1',family:4}],[{address:'not-ip',family:4}],[{address:'::1',family:6}],[{address:'2001:4860:4860::8888',family:6}],[]]){
    const f=fixture();const c=new AppOutboundClient({policy,lookup:async()=>addresses,request:f.request});
    await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_DENIED/);assert.equal(f.sent,0);
  }
  for(const p of [null,{declaredOrigins:[],approvedOrigins:[origin]},{declaredOrigins:[origin],approvedOrigins:[]}]){
    const f=fixture();const c=new AppOutboundClient({policy:async()=>p,request:f.request});await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_DENIED/);assert.equal(f.sent,0);
  }
});
test('outbound rejects URL credentials, fragments, non-HTTPS, nondefault ports and ambient headers',async()=>{
  const f=fixture();const c=new AppOutboundClient({policy,request:f.request});
  for(const url of ['http://public.example.com/api','https://u:p@public.example.com/api',origin+'/api#secret',origin+':8443/api'])await assert.rejects(c.execute(context,{...input,url},signal()),/OUTBOUND_DENIED/);
  await assert.rejects(c.execute(context,{...input,headers:{cookie:'secret'}} as typeof input,signal()),/OUTBOUND_INVALID/);assert.equal(f.sent,0);
});
test('outbound redirect, compressed response and excessive response fail closed',async()=>{
  for(const config of [{status:302},{encoding:'gzip'},{body:'x'.repeat(20)}]){
    const f=fixture(config);const c=new AppOutboundClient({policy,request:f.request,lookup:async()=>[{address:'93.184.216.34',family:4}],maxResponseBytes:16});
    await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_FAILED|OUTBOUND_LIMIT/);assert.equal(f.sent,1);
  }
});
test('outbound checks approval again after DNS and before exposing response',async()=>{
  for(const revokeAt of [2,3]){
    let checks=0;const f=fixture();const c=new AppOutboundClient({policy:async()=>++checks>=revokeAt?null:policy(),request:f.request,lookup:async()=>[{address:'93.184.216.34',family:4}]});
    await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_DENIED/);assert.equal(f.sent,revokeAt===2?0:1);
  }
});
test('outbound total deadline covers DNS and abort prevents delayed DNS from making requests',async()=>{
  let resolveDns!:(addresses:{address:string;family:number}[])=>void;const f=fixture();
  const c=new AppOutboundClient({policy,request:f.request,timeoutMs:10,lookup:()=>new Promise(resolve=>resolveDns=resolve)});
  await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_ABORTED/);
  resolveDns([{address:'93.184.216.34',family:4}]);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent,0);
  const aborted=new AbortController();aborted.abort();await assert.rejects(c.execute(context,input,aborted.signal),/OUTBOUND_ABORTED/);
});
test('outbound concurrency is bounded, cancellation rejects and oversized body never sends',async()=>{
  const f=fixture({hang:true});const c=new AppOutboundClient({policy,request:f.request,maxConcurrent:1,lookup:async()=>[{address:'93.184.216.34',family:4}]});
  const controller=new AbortController();const pending=c.execute(context,input,controller.signal);
  await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_LIMIT/);controller.abort();await assert.rejects(pending,/OUTBOUND_ABORTED/);
  await assert.rejects(c.execute(context,{url:input.url,method:'POST',body:'x'.repeat(65537)},signal()),/OUTBOUND_INVALID/);
});
test('outbound timeout retains unresolved DNS admission until settlement',async()=>{
  let finish!:(value:{address:string;family:number}[])=>void;
  const f=fixture();const c=new AppOutboundClient({policy,request:f.request,maxConcurrent:1,timeoutMs:10,lookup:()=>new Promise(resolve=>finish=resolve)});
  await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_ABORTED/);
  await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_LIMIT/);
  finish([{address:'93.184.216.34',family:4}]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sent,0);
  await assert.rejects(c.execute(context,input,signal()),/OUTBOUND_ABORTED/);
  finish([{address:'93.184.216.34',family:4}]);
});
test('outbound POST body snapshot uses fixed safe headers without ambient credentials',async()=>{
  const f=fixture();const c=new AppOutboundClient({policy,request:f.request,lookup:async()=>[{address:'93.184.216.34',family:4}]});
  const request={url:input.url,method:'POST' as const,body:'{"demo":true}'};
  const pending=c.execute(context,request,signal());request.body='mutated';await pending;
  assert.deepEqual(f.written,['{"demo":true}']);assert.deepEqual(f.captured?.headers,{accept:'application/json','accept-encoding':'identity','content-type':'application/json','content-length':13});
});
