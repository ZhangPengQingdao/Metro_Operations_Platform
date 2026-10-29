import test from 'node:test';
import assert from 'node:assert/strict';
import {employeeRequest,EmployeeRequestError} from '../../src/app-platform/employee/client.ts';

test('employee network failures and incomplete responses remain unknown and are never replayed',async t=>{
 for(const failure of ['network','body'] as const){
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(failure==='network')throw new TypeError('Load failed');return new Response('{');});
  await assert.rejects(employeeRequest('/apps/demo/api',{method:'POST',body:{requestId:'one'}}),error=>error instanceof EmployeeRequestError&&error.writeOutcome==='unknown'&&error.code===(failure==='network'?'EMPLOYEE_NETWORK_ERROR':'EMPLOYEE_RESPONSE_INCOMPLETE'));
  assert.equal(calls,1);
  t.mock.restoreAll();
 }
});

test('employee permission denial preserves the error and write outcome without replay or logout',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(JSON.stringify({error:{code:'ACCESS_DENIED',writeOutcome:'not_started'}}),{status:403});});
 await assert.rejects(employeeRequest('/apps/demo/api',{method:'POST',body:{}}),error=>error instanceof EmployeeRequestError&&error.status===403&&error.code==='ACCESS_DENIED'&&error.writeOutcome==='not_started');
 assert.equal(calls,1);
});

test('cancelled employee requests cannot expire the current login or publish late data',async t=>{
 for(const status of [200,401]){
  const controller=new AbortController();
  t.mock.method(globalThis,'fetch',async()=>{controller.abort();return new Response('{}',{status});});
  // No window: any attempted logout dispatch from this obsolete request would fail.
  await assert.rejects(employeeRequest('/auth/me',{signal:controller.signal}),{name:'AbortError'});
  t.mock.restoreAll();
 }
 const controller=new AbortController();
 t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,json:async()=>{controller.abort();return {id:'obsolete'};}} as Response));
 await assert.rejects(employeeRequest('/auth/me',{signal:controller.signal}),{name:'AbortError'});
});

test('employee requests send the pinned admission and successful response',async t=>{
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  assert.equal(input,'/api/employee/apps/demo/api');
  assert.equal(new Headers(init?.headers).get('X-Mop-Employee-Admission'),'pinned');
  assert.equal(init?.credentials,'same-origin');
  return new Response(JSON.stringify({result:{ok:true}}));
 });
 assert.deepEqual(await employeeRequest('/apps/demo/api',{method:'POST',body:{},admissionKey:'pinned'}),{result:{ok:true}});
});

test('confirmed 401 expires the employee session even with a malformed body, but failed login does not',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),events:string[]=[];
 Object.defineProperty(globalThis,'window',{configurable:true,value:{dispatchEvent:(event:Event)=>{events.push(event.type);return true;}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');});
 t.mock.method(globalThis,'fetch',async()=>new Response('{',{status:401}));
 await assert.rejects(employeeRequest('/auth/me'),error=>error instanceof EmployeeRequestError&&error.status===401);
 assert.deepEqual(events,['mop-employee-session-expired']);
 await assert.rejects(employeeRequest('/auth/login',{method:'POST',body:{}}));
 assert.equal(events.length,1);
});
