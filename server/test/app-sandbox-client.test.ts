import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppSandboxClient,type AppSandboxPort} from '../../packages/platform-sdk/src/app-sandbox.ts';
import {SandboxBridgeBroker} from '../../src/app-platform/host/sandbox/bridge.ts';
const session='a'.repeat(32),origin='https://platform.example';
function fixture(timeoutMs=100){
 const parent={},child={},sent:unknown[]=[];let listener:Parameters<AppSandboxPort['listen']>[0]=()=>{};let calls=0;
 const broker=new SandboxBridgeBroker({appId:'sample',session,source:child,send:data=>listener({source:parent,origin,data}),operations:new Map([['sample.echo',{validate:()=>true,authorize:async()=>true,execute:async params=>{calls++;return params;}}]])});
 const client=createAppSandboxClient({appId:'sample',platformOrigin:origin,timeoutMs,port:{parent,listen:fn=>{listener=fn;return()=>{listener=()=>{};}},send:(data,target)=>{assert.equal(target,origin);sent.push(data);void broker.receive({source:child,origin:'null',data});}}});
 const init=(source=parent,from=origin)=>listener({source,origin:from,data:{version:'1.0',type:'init',appId:'sample',session}});
 return {client,broker,init,calls:()=>calls,sent,receive:(data:unknown,source:unknown=parent,from=origin)=>listener({source,origin:from,data})};
}
test('SDK sandbox adapter interoperates with actual broker and rejects spoofed parent/origin',async()=>{
 const f=fixture();f.init({});f.init(undefined,'https://evil.example');assert.equal(f.client.ready(),false);
 await assert.rejects(f.client.invoke('sample.echo',{}),/SANDBOX_NOT_READY/);f.init();
 assert.deepEqual({...await f.client.invoke('sample.echo',{hello:'world'}) as object},{hello:'world'});
 await assert.rejects(f.client.invoke('database.query',{}),/UNKNOWN_METHOD/);assert.equal(f.calls(),1);
 f.client.close();f.broker.close();
});
test('changed session closes old client rather than adopting another app generation',async()=>{
 const f=fixture();f.init();f.receive({version:'1.0',type:'init',appId:'sample',session:'b'.repeat(32)});assert.equal(f.client.ready(),false);
 await assert.rejects(f.client.invoke('sample.echo',{}),/SANDBOX_NOT_READY/);f.broker.close();
});
test('client routing accepts only the bound parent and acknowledges a subscribed route',async()=>{
 const f=fixture(),seen:string[]=[];f.init();const route={version:'1.0',type:'route',appId:'sample',session,path:'/meeting'};
 f.receive(route,{},origin);f.receive(route,undefined,'https://evil.example');f.receive({...route,session:'b'.repeat(32)});f.receive({...route,path:'//evil.example'});
 assert.deepEqual(seen,[]);
 f.receive(route);const unsubscribe=f.client.onRouteChange(path=>seen.push(path));
 await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(seen,['/meeting']);
 assert.ok(f.sent.some(message=>typeof message==='object'&&message!==null&&(message as {type?:string}).type==='route-ready'));
 unsubscribe();f.client.close();f.broker.close();
});
test('lost sandbox response has unknown outcome and never retries',async()=>{
 const f=fixture(10);f.init();f.broker.close();
 await assert.rejects(f.client.invoke('sample.echo',{}),e=>e instanceof Error&&e.message==='TIMEOUT'&&'writeOutcome' in e&&e.writeOutcome==='unknown');f.client.close();
});

test('denied response can follow execution-time revocation and must retain unknown write outcome',async()=>{
 const f=fixture();f.init();f.broker.close();
 const result=assert.rejects(f.client.invoke('sample.echo',{}),e=>e instanceof Error&&e.message==='DENIED'&&'writeOutcome' in e&&e.writeOutcome==='unknown');
 f.receive({version:'1.0',type:'response',appId:'sample',session,id:1,ok:false,error:'DENIED'});
 await result;f.client.close();
});
