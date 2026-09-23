import test from 'node:test';
import assert from 'node:assert/strict';
import {EmployeeAppSessions} from '../src/app-platform/employee/app-session.ts';
import type {EmployeeAppSession} from '../src/app-platform/employee/app-session.ts';

const admission=(revision:string):EmployeeAppSession=>({
 identity:{source:'session',userId:'person-1'},
 access:{installationId:'installation-1',revision},
 installation:{id:'installation-1',appId:'demo',revision:1} as EmployeeAppSession['installation'],
});

test('employee app session reuses admission for a person and app, and coalesces concurrent loads',async()=>{
 const sessions=new EmployeeAppSessions();let loads=0;
 const load=async()=>{loads++;return admission('grant-1');};
 const identity=admission('grant-1').identity;
 const values=await Promise.all(Array.from({length:6},()=>sessions.get(identity,'demo',load)));
 assert.equal(loads,1);
 assert.ok(values.every(value=>value.access.revision==='grant-1'));
 await sessions.get(identity,'demo',load);
 assert.equal(loads,1);
 await sessions.get({...identity,userId:'person-2'},'demo',async()=>{loads++;return {...admission('grant-1'),identity:{...identity,userId:'person-2'}};});
 assert.equal(loads,2);
});

test('employee app session invalidation does not restore an in-flight stale result',async()=>{
 const sessions=new EmployeeAppSessions();let finish!:(value:EmployeeAppSession)=>void;
 let loads=0;
 const identity=admission('grant-1').identity;
 const stale=sessions.get(identity,'demo',()=>++loads===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(admission('grant-2')));
 sessions.clear();finish(admission('grant-1'));await stale;
 const fresh=await sessions.get(identity,'demo',async()=>{loads++;return admission('grant-3');});
 assert.equal(fresh.access.revision,'grant-2');
 assert.equal(loads,2);
});

test('employee app session does not reuse a previous organization identity',async()=>{
 const sessions=new EmployeeAppSessions();let loads=0;
 const initial={...admission('grant-1'),identity:{...admission('grant-1').identity,organizationUnitId:'old'}};
 const changed={...initial,identity:{...initial.identity,organizationUnitId:'new'}};
 await sessions.get(initial.identity,'demo',async()=>{loads++;return initial;});
 const result=await sessions.get(changed.identity,'demo',async()=>{loads++;return changed;});
 assert.equal(result.identity.organizationUnitId,'new');
 assert.equal(loads,2);
});

test('employee app session expiration recomputes access',async()=>{
 const sessions=new EmployeeAppSessions(1);let loads=0;
 const load=async()=>admission(String(++loads));
 const identity=admission('grant-1').identity;
 await sessions.get(identity,'demo',load);
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal((await sessions.get(identity,'demo',load)).access.revision,'2');
});
