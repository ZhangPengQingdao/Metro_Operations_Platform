import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PlatformMaintenance,type MaintenanceAdapter} from '../src/app-platform/updates/maintenance.js';
import type {AppInstallation} from '../src/app-platform/registry/model.js';
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'mop-maintenance-'));const task=randomUUID(),actor=randomUUID();
 const records=[{id:randomUUID(),appId:'running',revision:1,manifest:{version:'1.0.0'},enabled:true},{id:randomUUID(),appId:'disabled',revision:2,manifest:{version:'1.0.0'},enabled:false}] as AppInstallation[];
 const serving=new Set(['running']);const changes:string[]=[];let gated=false,fail=false;
 const adapter:MaintenanceAdapter={list:async()=>structuredClone(records),status:async id=>({installation:structuredClone(records.find(r=>r.appId===id)!),serving:serving.has(id)}),gate:value=>{gated=value;},drain:async()=>{if(fail)throw Error('RUNTIME_WORK_PENDING');},change:async(id,revision,action)=>{const record=records.find(r=>r.appId===id)!;assert.equal(record.revision,revision);changes.push(action+':'+id);record.enabled=action==='enable';record.revision++;if(record.enabled)serving.add(id);else serving.delete(id);return structuredClone(record);}};
 const path=join(root,'state.json');const maintenance=new PlatformMaintenance(adapter,path);await maintenance.initialize();
 return {maintenance,adapter,path,records,serving,changes,task,actor,gated:()=>gated,setFail:()=>{fail=true;},close:()=>rm(root,{recursive:true,force:true})};
}
test('snapshot survives restart and restores only previously serving applications',async()=>{const f=await fixture();try{
 const paused=await f.maintenance.prepare(f.task,f.actor);assert.equal(paused?.phase,'paused');assert.equal(f.gated(),true);assert.deepEqual(f.changes,['disable:running']);
 const restarted=new PlatformMaintenance(f.adapter,f.path);await restarted.initialize();await restarted.restore(f.task);
 assert.deepEqual(f.changes,['disable:running','enable:running']);assert.equal(f.records[1].enabled,false);assert.equal(f.gated(),false);
 await restarted.restore(f.task);assert.equal(f.changes.length,2);
}finally{await f.close();}});
test('unfinished work blocks update and cancellation preserves original running state',async()=>{const f=await fixture();try{
 f.setFail();await assert.rejects(f.maintenance.prepare(f.task,f.actor),/RUNTIME_WORK_PENDING/);assert.equal(f.maintenance.status()?.phase,'blocked');assert.equal(f.gated(),true);assert.equal(f.changes.length,0);
 await f.maintenance.restore(f.task);assert.equal(f.gated(),false);assert.equal(f.changes.length,0);
}finally{await f.close();}});
test('changed installation and wrong task cannot restore',async()=>{const f=await fixture();try{
 await f.maintenance.prepare(f.task,f.actor);await assert.rejects(f.maintenance.restore(randomUUID()),/TASK_CONFLICT/);
 f.records[0].revision++;await assert.rejects(f.maintenance.restore(f.task),/INSTALLATION_CHANGED/);assert.equal(f.gated(),true);assert.equal(f.changes.length,1);
}finally{await f.close();}});
test('lost stop acknowledgement is durable and never automatically replayed',async()=>{const f=await fixture();try{
 const change=f.adapter.change;f.adapter.change=async(...args)=>{await change(...args);throw Error('lost acknowledgement');};
 await assert.rejects(f.maintenance.prepare(f.task,f.actor),/lost acknowledgement/);
 const restarted=new PlatformMaintenance(f.adapter,f.path);await restarted.initialize();await assert.rejects(restarted.restore(f.task),/OUTCOME_UNKNOWN/);assert.equal(f.changes.length,1);
}finally{await f.close();}});
test('enabled but unowned app blocks rather than silently starting on restoration',async()=>{const f=await fixture();try{
 f.serving.clear();await assert.rejects(f.maintenance.prepare(f.task,f.actor),/NOT_SERVING/);assert.equal(f.changes.length,0);
}finally{await f.close();}});

test('failed snapshot collection belongs to the new task and can be cancelled without lifecycle changes',async()=>{const f=await fixture();try{
 await f.maintenance.prepare(f.task,f.actor);await f.maintenance.restore(f.task);
 const next=randomUUID();f.adapter.list=async()=>{throw Error('database unavailable');};
 await assert.rejects(f.maintenance.prepare(next,f.actor),/database unavailable/);
 assert.equal(f.maintenance.status()?.taskId,next);assert.equal(f.gated(),true);
 const restarted=new PlatformMaintenance(f.adapter,f.path);await restarted.initialize();await restarted.restore(next);
 assert.equal(f.gated(),false);assert.deepEqual(f.changes,['disable:running','enable:running']);
}finally{await f.close();}});
