import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmployeeApiBridge} from '../../src/app-platform/employee/api-bridge.ts';
import {createAppApiClient,createAppSandboxClient} from '../../packages/platform-sdk/src/app-sandbox.ts';
import {SandboxBridgeBroker} from '../../src/app-platform/host/sandbox/bridge.ts';
test('public SDK through real sandbox broker pins manifest API route independently of payload',async()=>{
 const parent={},source={},origin='https://platform.example',session='a'.repeat(32);let listener:(event:any)=>void=()=>{};
 const requests:unknown[]=[];const routes=[{id:'stock-in',method:'POST',path:'/stock/in'}];
 const operations=createEmployeeApiBridge(routes,async request=>{requests.push(request);return {saved:true};});
 routes[0].path='/forged';
 const broker=new SandboxBridgeBroker({appId:'materials',session,source,operations,send:data=>listener({source:parent,origin,data})});
 const sandbox=createAppSandboxClient({appId:'materials',platformOrigin:origin,port:{parent,listen:fn=>{listener=fn;return()=>{};},send:data=>{void broker.receive({source,origin:'null',data});}}});
 listener({source:parent,origin,data:{version:'1.0',type:'init',appId:'materials',session}});
 const api=createAppApiClient(sandbox);
 try{
  const payload={apiId:'delete',method:'DELETE',path:'/all',employee:{personId:'forged'}};
  assert.equal((await api.invoke('stock-in',payload) as {saved:boolean}).saved,true);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])),{apiId:'stock-in',method:'POST',path:'/stock/in',payload});
  await assert.rejects(api.invoke('undeclared',{}),/UNKNOWN_METHOD/);
  await assert.rejects(api.invoke('../escape',{}),/INVALID_REQUEST/);
  assert.equal(requests.length,1);
 }finally{sandbox.close();broker.close();}
});
test('API bridge fails closed on ambiguous routes and never retries failed calls',async()=>{
 const route={id:'write',method:'POST',path:'/write'};
 assert.throws(()=>createEmployeeApiBridge([route,route],async()=>null));
 let calls=0;const operations=createEmployeeApiBridge([route],async()=>{calls++;throw Error('unknown');});
 await assert.rejects(operations.get('application.api.write')!.execute({},new AbortController().signal),/unknown/);
 assert.equal(calls,1);
});
