import test from 'node:test';
import assert from 'node:assert/strict';
import {adminRequest,AdminRequestError} from '../../src/app-platform/admin/client.ts';

test('admin network failure is explained and mutations are not replayed',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new TypeError('Load failed');});
 await assert.rejects(adminRequest('/install',{method:'POST',body:{}}),(error:unknown)=>error instanceof AdminRequestError&&error.code==='ADMIN_NETWORK_ERROR'&&error.message.includes('避免重复提交'));
 assert.equal(calls,1);
});
test('incomplete successful response remains unknown rather than returning null',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('{',{status:200}));
 await assert.rejects(adminRequest('/install',{method:'POST',body:{}}),(error:unknown)=>error instanceof AdminRequestError&&error.code==='ADMIN_RESPONSE_INCOMPLETE');
});
test('intentional abort is preserved',async t=>{
 const controller=new AbortController();controller.abort();const failure=new DOMException('Aborted','AbortError');
 t.mock.method(globalThis,'fetch',async()=>{throw failure;});
 await assert.rejects(adminRequest('/apps',{signal:controller.signal}),error=>error===failure);
});
test('obsolete admin auth responses cannot expire a newer session or publish stale data',async t=>{
 for(const status of [200,401]){
  const controller=new AbortController();
  t.mock.method(globalThis,'fetch',async()=>{controller.abort();return new Response('{}',{status});});
  await assert.rejects(adminRequest('/auth/me',{signal:controller.signal}),{name:'AbortError'});
  t.mock.restoreAll();
 }
 const controller=new AbortController();
 t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,json:async()=>{controller.abort();return {id:'obsolete'};}} as Response));
 await assert.rejects(adminRequest('/auth/me',{signal:controller.signal}),{name:'AbortError'});
});
