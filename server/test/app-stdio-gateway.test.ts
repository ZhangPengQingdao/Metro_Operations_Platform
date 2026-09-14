import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { startAppStdioGateway, APP_STDIO_GATEWAY_PREFIX as prefix } from '../src/app-platform/runtime/stdio-gateway.ts';
import { GatewayError } from '../src/app-platform/gateway/model.ts';
import type { AppGateway } from '../src/app-platform/gateway/gateway.ts';
const response = { version: '1.0' as const, requestId: 'server-id', traceId: 'server-trace', result: 'ok' };
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;}); return {promise,resolve}; }
function fixture(invoke?: Pick<AppGateway,'invokeService'>['invokeService'], drain?:()=>Promise<void>, stdin?:Writable) {
  const stdout = new PassThrough();
  const input = stdin ?? new PassThrough();
  let received='';
  if(input instanceof PassThrough) input.on('data',chunk=>{received+=chunk.toString();});
  const gateway = {invokeService: invoke ?? (async()=>response),drain:drain ?? (async()=>{})};
  const session=startAppStdioGateway({appId:'demo',serviceCredential:'app-secret',gateway,stdout,stdin:input,shutdownTimeoutMs:25,writeTimeoutMs:25});
  const send=(value:unknown)=>stdout.write(prefix+JSON.stringify(value)+'\n');
  const frame=(id=randomUUID())=>({id,request:{version:'1.0',operation:'assets.read',params:{}}});
  return {stdout,input,session,gateway,send,frame,received:()=>received};
}
test('stdio pins app identity, injects host credential and forwards request and bounded fragmented frames',async()=>{
  let seen:unknown[]=[];
  const f=fixture(async(...args)=>{seen=args;return response;});
  const request=f.frame(); const wire=prefix+JSON.stringify(request)+'\n';
  f.stdout.write('ordinary log\n');f.stdout.write(wire.slice(0,12));f.stdout.write(wire.slice(12));
  await tick();
  assert.equal(seen[0],'demo');assert.equal(seen[1],'app-secret');assert.deepEqual(seen[2],request.request);
  assert.deepEqual(JSON.parse(f.received().slice(prefix.length)),{id:request.id,response});
  await f.session.stop();
});
test('stdio closes on malformed, invalid UTF8, oversized lines and identity override',async()=>{
  const cases=[prefix+'{bad}\n',prefix+JSON.stringify({id:randomUUID(),credential:'token',request:{},appId:'other'})+'\n','x'.repeat(65537),Buffer.concat([Buffer.from(prefix+'{"id":"'),Buffer.from([255]),Buffer.from('"}\n')])];
  for(const bad of cases) {
    let calls=0;const f=fixture(async()=>{calls++;return response;});
    f.stdout.write(bad);await f.session.closed;await f.session.stop();assert.equal(calls,0);
  }
});
test('stdio duplicate in-flight IDs and excess concurrency abort without replay',async()=>{
  for(const duplicate of [true,false]) {
    const gate=deferred();let calls=0;
    const f=fixture(async()=>{calls++;await gate.promise;return response;});
    const frame=f.frame();f.send(frame);await tick();
    if(duplicate)f.send({...frame,id:frame.id.toUpperCase()});
    else for(let i=0;i<16;i++)f.send(f.frame());
    await f.session.closed;assert.equal(calls,1);gate.resolve();await f.session.stop();
  }
});
test('stdio public gateway errors preserve outcome and unexpected errors hide secrets',async()=>{
  for(const error of [new GatewayError('TIMEOUT',504,'unknown'),Error('private credential')]){
    const f=fixture(async()=>{throw error;});f.send(f.frame());await tick();
    const body=JSON.parse(f.received().slice(prefix.length));
    assert.deepEqual(body.error,{code:error instanceof GatewayError?'TIMEOUT':'GATEWAY_FAILED',writeOutcome:'unknown'});
    assert.ok(!f.received().includes('private'));await f.session.stop();
  }
});
test('stdio disconnect aborts and retains ownership until actual callbacks and gateway drain settle',async()=>{
  const operation=deferred(),audit=deferred();let signal:AbortSignal|undefined;let drained=0;
  const f=fixture(async(_app,_credential,_request,s)=>{signal=s;await operation.promise;return response;},async()=>{drained++;await audit.promise;});
  f.send(f.frame());await tick();f.stdout.end();await f.session.closed;
  assert.equal(signal?.aborted,true);
  await assert.rejects(f.session.stop(),/DRAIN_TIMEOUT/);
  assert.throws(()=>startAppStdioGateway({appId:'demo',serviceCredential:'app-secret',gateway:f.gateway,stdout:new PassThrough(),stdin:new PassThrough()}),/ALREADY_OWNED/);
  operation.resolve();await tick();assert.equal(drained,1);
  await assert.rejects(f.session.stop(),/DRAIN_TIMEOUT/);assert.equal(drained,1);
  audit.resolve();await f.session.stop();assert.equal(drained,1);
  const next=startAppStdioGateway({appId:'demo',serviceCredential:'app-secret',gateway:f.gateway,stdout:new PassThrough(),stdin:new PassThrough()});await next.stop();
});
test('stdio rejected cleanup can be retried but cannot release ownership early',async()=>{
  let attempts=0;const f=fixture(undefined,async()=>{if(++attempts===1)throw Error('private');});
  await assert.rejects(f.session.stop(),/DRAIN_FAILED/);await f.session.stop();assert.equal(attempts,2);
});
test('stdio blocked writes and excessive responses close the transport',async()=>{
  const input=new Writable({write(_chunk,_encoding,_callback){}});
  const f=fixture(undefined,undefined,input);f.send(f.frame());await f.session.closed;await f.session.stop();
  const huge=fixture(async()=>({...response,result:'x'.repeat(256*1024)}));huge.send(huge.frame());await huge.session.closed;await huge.session.stop();
});


test('stdio rejects caller credential overrides and invalid host credentials before ownership',async()=>{
 const f=fixture();f.send({...f.frame(),credential:'override'});
 await f.session.closed;assert.equal(f.received(),'');await f.session.stop();
 for(const serviceCredential of ['', 'bad\nsecret', 'x'.repeat(201), undefined]) {
  const stdout=new PassThrough(),stdin=new PassThrough();
  assert.throws(()=>startAppStdioGateway({appId:'demo',gateway:f.gateway,stdout,stdin,serviceCredential:serviceCredential as string}),/INVALID_OPTIONS/);
  assert.equal(stdout.destroyed,false);assert.equal(stdin.destroyed,false);
  const session=startAppStdioGateway({appId:'demo',gateway:f.gateway,stdout,stdin,serviceCredential:'valid'});
  await session.stop();
 }
});

test('stdio snapshots host identity and credential before options can be changed',async()=>{
 const stdout=new PassThrough(),stdin=new PassThrough();stdin.resume();
 let seen:unknown[]=[];
 const gateway={invokeService:async(...args:Parameters<AppGateway['invokeService']>)=>{seen=args;return response;},drain:async()=>{}};
 const options={appId:'demo',serviceCredential:'original-secret',gateway,stdout,stdin};
 const session=startAppStdioGateway(options);
 options.appId='other';options.serviceCredential='replacement';
 stdout.write(prefix+JSON.stringify({id:randomUUID(),request:{}})+'\n');await tick();
 assert.equal(seen[0],'demo');assert.equal(seen[1],'original-secret');await session.stop();
});
