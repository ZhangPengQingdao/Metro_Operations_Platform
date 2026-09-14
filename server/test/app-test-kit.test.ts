import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppTestHost} from '../../packages/platform-sdk/src/app-test-kit.ts';
test('test host uses real request snapshots and explicit operation allowlist',async()=>{
 const host=createAppTestHost([{name:'sample.echo',execute:async p=>p}]);
 const input={label:'before'};const result=host.client.invoke('sample.echo',input);input.label='after';
 assert.deepEqual({...await result as object},{label:'before'});
 assert.equal(host.requests().length,1);assert.ok(Object.isFrozen(host.requests()[0].params));
 await assert.rejects(host.client.invoke('platform.admin',{}),/OPERATION_DENIED/);
 host.close();await host.drain();await assert.rejects(host.client.invoke('sample.echo',{}),/ABORTED/);
});
test('test host does not retry failed writes and drains actual pending work after close',async()=>{
 let release!:()=>void,started!:()=>void;const began=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});let calls=0;
 const host=createAppTestHost([{name:'sample.write',execute:async()=>{calls++;started();await gate;throw Error('private');}}]);
 const result=assert.rejects(host.client.invoke('sample.write',{}),/TRANSPORT_FAILED/);await began;
 host.close();let done=false;const drain=host.drain().then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);
 release();await result;await drain;assert.equal(calls,1);
});
test('test host rejects duplicate handlers and drain while open',async()=>{
 const op={name:'sample.echo',execute:async()=>null};assert.throws(()=>createAppTestHost([op,op]),/INVALID_TEST_HOST/);
 const host=createAppTestHost([]);await assert.rejects(host.drain(),/DRAIN_REQUIRES_CLOSE/);host.close();await host.drain();
});
