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

import {manifestApprovalDigest} from '../src/app-platform/management/config.ts';
import type {AppManifest} from '../src/app-platform/manifest/index.ts';
test('manifest approval survives PostgreSQL JSONB property ordering',()=>{
 const left={id:'sample',version:'1.0.0',ui:{mode:'sandbox',entryArtifactId:'entry'}} as AppManifest;
 const right={ui:{entryArtifactId:'entry',mode:'sandbox'},version:'1.0.0',id:'sample'} as AppManifest;
 assert.equal(manifestApprovalDigest(left),manifestApprovalDigest(right));
 assert.notEqual(manifestApprovalDigest(left),manifestApprovalDigest({...left,version:'1.1.0'}));
});
