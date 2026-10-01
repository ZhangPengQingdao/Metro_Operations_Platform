import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandlers} from './handlers.mjs';
import config from './app.json' with {type:'json'};
const org='00000000-0000-4000-8000-000000000001';
const person='00000000-0000-4000-8000-000000000002';
test('rejects unauthorised employees and binds directory lookup to host organization',async()=>{
 const calls=[];const handler=createHandlers({invoke:async(...args)=>{calls.push(args);return {organizationUnitId:org,rows:[]};}}).get('members');
 const signal=new AbortController().signal;
 assert.equal((await handler.execute({},signal)).ok,false);assert.equal(calls.length,0);
 const employee={personId:person,organizationUnitId:org,businessAuthorization:{grants:[{permission:`app.${config.id}.read`,all:false,self:false,organizationIds:[org]}]}};
 assert.equal((await handler.execute({organizationUnitId:'other'},signal,employee)).ok,false);assert.equal(calls.length,0);
 assert.equal((await handler.execute({search:'姓名'},signal,employee)).ok,true);
 assert.equal(calls[0][0],'platform.people.members');assert.deepEqual(calls[0][1],{organizationUnitId:org,search:'姓名'});
 employee.businessAuthorization.grants[0].organizationIds=[];
 assert.equal((await handler.execute({},signal,employee)).ok,false);assert.equal(calls.length,1);
});
