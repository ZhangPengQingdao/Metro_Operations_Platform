import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagementQueue} from '../src/app-platform/management/queue.ts';
test('management queue keeps transaction session commands separate even after failure',async()=>{
 const q=createManagementQueue();const trace:string[]=[];
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const first=q.run(async()=>{trace.push('begin');await gate;trace.push('rollback');throw Error('failed');});
 const second=q.run(async()=>{trace.push('next');});
 await Promise.resolve();assert.deepEqual(trace,['begin']);release();
 await assert.rejects(first,/failed/);await second;assert.deepEqual(trace,['begin','rollback','next']);
 await q.close(async()=>{});await assert.rejects(q.run(async()=>{}),/CLOSED/);
});
