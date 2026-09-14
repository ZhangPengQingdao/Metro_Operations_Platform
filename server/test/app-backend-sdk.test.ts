import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {createAppBackend} from '../../packages/platform-sdk/src/app-backend.ts';
import {startAppStdioGateway} from '../src/app-platform/runtime/stdio-gateway.ts';

test('public backend SDK interoperates with real host API and credential-free Gateway',async()=>{
 const input=new PassThrough(),output=new PassThrough();let calls=0;
 let wire='';output.on('data',chunk=>{wire+=String(chunk);});
 const backend=createAppBackend({input,output,handlers:new Map([['echo',{method:'POST',path:'/echo',execute:async payload=>payload}]])});
 const host=startAppStdioGateway({appId:'backend-sample',serviceCredential:'host-secret',stdout:output,stdin:input,gateway:{
  invokeService:async(appId,credential)=>{assert.equal(appId,'backend-sample');assert.equal(credential,'host-secret');calls++;return {version:'1.0',requestId:'r',traceId:'t',result:{ok:true}};},drain:async()=>{},
 }});
 try {
  assert.equal(JSON.stringify(await backend.gateway.invoke('fixture.read',{})),JSON.stringify({ok:true}));
  assert.equal(JSON.stringify(await host.api.invoke({handler:'echo',method:'POST',path:'/echo',payload:{echo:1}})),JSON.stringify({echo:1}));
  assert.equal(calls,1);assert.equal(wire.includes('host-secret'),false);
 }finally{backend.close();await backend.drain();host.api.confirmContainerStopped();await host.stop();}
});

test('wrong handler, method, duplicate ID, invalid UTF-8 and unbounded frame close the backend',async()=>{
 for(const mode of ['handler','method','duplicate','utf8','large']){
  const input=new PassThrough(),output=new PassThrough();let calls=0;
  const backend=createAppBackend({input,output,handlers:new Map([['echo',{method:'POST',path:'/echo',execute:async()=>{calls++;return null;}}]])});
  const message='AFC_API_V1 '+JSON.stringify({id:randomUUID(),request:{handler:mode==='handler'?'other':'echo',method:mode==='method'?'GET':'POST',path:'/echo',payload:{}}})+'\n';
  if(mode==='utf8')input.write(Buffer.from([255,10]));else if(mode==='large')input.write('x'.repeat(262145));else{input.write(message);if(mode==='duplicate')input.write(message);}
  await backend.whenClosed;await backend.drain();assert.equal(calls,0,mode);
 }
});

test('handler timeout aborts work, suppresses late result and drain waits for actual settlement',async()=>{
 const input=new PassThrough(),output=new PassThrough();let finish!:(value:null)=>void;let signal:AbortSignal|undefined;
 const backend=createAppBackend({input,output,timeoutMs:10,handlers:new Map([['wait',{method:'GET',path:'/wait',execute:async(_payload,current)=>{signal=current;return new Promise(resolve=>{finish=resolve;});}}]])});
 input.write('AFC_API_V1 '+JSON.stringify({id:randomUUID(),request:{handler:'wait',method:'GET',path:'/wait',payload:{}}})+'\n');
 await backend.whenClosed;assert.equal(signal?.aborted,true);
 let drained=false;const drain=backend.drain().then(()=>{drained=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 finish(null);await drain;assert.equal(drained,true);
});

test('lost Gateway responses do not retry and retain unknown write outcome',async()=>{
 const input=new PassThrough(),output=new PassThrough();let messages=0;output.on('data',()=>messages++);
 const backend=createAppBackend({input,output,timeoutMs:10,handlers:new Map()});
 await assert.rejects(backend.gateway.invoke('fixture.write',{}),error=>typeof error==='object'&&error!==null&&'writeOutcome'in error&&error.writeOutcome==='unknown');
 assert.equal(messages,1);assert.equal(backend.signal.aborted,true);await backend.drain();
});
