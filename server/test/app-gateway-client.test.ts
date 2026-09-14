import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppGatewayClient,AppGatewayClientError} from '../../packages/platform-sdk/src/app-gateway.ts';
test('client snapshots immutable parameters and uses only injected transport once',async()=>{
  let calls=0;
  const client=createAppGatewayClient(async request=>{calls++;assert.ok(Object.isFrozen(request.params));return {version:'1.0',requestId:'r',traceId:'t',result:{ok:true}};});
  assert.deepEqual(JSON.parse(JSON.stringify(await client.invoke('demo.read',{}))),{ok:true});assert.equal(calls,1);
});
test('client preserves uncertain write outcome and never retries failed transport',async()=>{
  let calls=0;const c=createAppGatewayClient(async()=>{calls++;throw new Error('secret upstream detail');});
  await assert.rejects(c.invoke('demo.write',{}),error=>error instanceof AppGatewayClientError&&error.code==='TRANSPORT_FAILED'&&error.writeOutcome==='unknown');assert.equal(calls,1);
  const denied=createAppGatewayClient(async()=>({version:'1.0',error:{code:'DENIED',writeOutcome:'not_started'}}));
  await assert.rejects(denied.invoke('demo.read',{}),error=>error instanceof AppGatewayClientError&&error.writeOutcome==='not_started');
});
test('client rejects malformed/large responses and invalid params without invoking accessors',async()=>{
  for(const response of [{version:'9.0'}, {version:'1.0',requestId:'r',traceId:'t',result:'x'.repeat(1048576)}, {version:'1.0',error:{code:'secret message',writeOutcome:'unknown'}}]){
    await assert.rejects(createAppGatewayClient(async()=>response).invoke('demo.read',{}),/INVALID_RESPONSE|INVALID_JSON/);
  }
  let calls=0;const c=createAppGatewayClient(async()=>{calls++;return null;});let accessed=false;
  await assert.rejects(c.invoke('demo.read',{get bad(){accessed=true;return 'x';}}),/INVALID_JSON/);assert.equal(accessed,false);assert.equal(calls,0);
  const controller=new AbortController();controller.abort();await assert.rejects(c.invoke('demo.read',{},controller.signal),/ABORTED/);assert.equal(calls,0);
});
