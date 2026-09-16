import assert from 'node:assert/strict';
import test from 'node:test';
import {admitEmployeeApplication,employeeAdmissionKey,assertEmployeeAdmissionKey} from '../src/app-platform/employee/admission.ts';
import {GatewayError} from '../src/app-platform/gateway/model.ts';
import type {AppInstallation} from '../src/app-platform/registry/index.ts';
import type {TrustedActorIdentity} from '../src/core/identity/index.ts';

function fixture(){
 let identity:TrustedActorIdentity={source:'session',userId:'employee-1'};
 let access={installationId:'installation-1',revision:'grant-1'};
 // Admission only uses immutable installation identifiers; the host owns manifest validation.
 let installation={id:'installation-1',revision:1} as AppInstallation;
 let revoked=false,stopped=false;
 const deps={resolveIdentity:async()=>structuredClone(identity),assertAccess:async()=>{if(revoked)throw new GatewayError('ACCESS_DENIED',403);return structuredClone(access);},snapshot:async()=>{if(stopped)throw new GatewayError('ACCESS_DENIED',403);return structuredClone(installation);},assertApproval:async()=>{}};
 return {deps,identity:(v:TrustedActorIdentity)=>{identity=v;},grant:()=>{access={...access,revision:'grant-2'};},upgrade:()=>{installation={...installation,revision:2};},replace:()=>{installation={...installation,id:'installation-2'};},revoke:()=>{revoked=true;},stop:()=>{stopped=true;}};
}
test('employee admission returns pinned identity and installation after fresh approval',async()=>{
 const f=fixture();const result=await admitEmployeeApplication(f.deps);
 assert.equal(result.identity.userId,'employee-1');assert.equal(result.access.revision,'grant-1');assert.equal(result.installation.revision,1);
});
for(const mutation of ['revoke','grant','upgrade','replace','stop'] as const){
 test(`employee admission blocks ${mutation} while approval is being read`,async()=>{
  const f=fixture();f.deps.assertApproval=async()=>{f[mutation]();};
  await assert.rejects(admitEmployeeApplication(f.deps),{code:'ACCESS_DENIED'});
 });
}
test('employee admission rejects identity switching, including source and additional identity fields',async()=>{
 for(const identity of [{source:'session',userId:'employee-2'},{source:'wecom',userId:'employee-1'},{source:'session',userId:'employee-1',employeeId:'another'}] as TrustedActorIdentity[]){
  const f=fixture();f.deps.assertApproval=async()=>f.identity(identity);
  await assert.rejects(admitEmployeeApplication(f.deps),{code:'ACCESS_DENIED'});
 }
});
test('employee admission denies missing identity, service identity, mismatched installation and approval failures',async()=>{
 for(const identity of [{source:'session'},{source:'service',userId:'employee-1'}] as TrustedActorIdentity[]){const f=fixture();f.identity(identity);await assert.rejects(admitEmployeeApplication(f.deps),{code:'ACCESS_DENIED'});}
 const f=fixture();f.replace();await assert.rejects(admitEmployeeApplication(f.deps),{code:'ACCESS_DENIED'});
 const failed=fixture();failed.deps.assertApproval=async()=>{throw new Error('policy unavailable');};await assert.rejects(admitEmployeeApplication(failed.deps),/policy unavailable/);
});

test('a frame binding cannot resume after regrant, upgrade or employee switching',async()=>{
 const f=fixture(),first=await admitEmployeeApplication(f.deps),key=employeeAdmissionKey(first);
 assert.doesNotThrow(()=>assertEmployeeAdmissionKey(first,key));
 for(const change of [()=>f.grant(),()=>f.upgrade(),()=>f.identity({source:'session',userId:'employee-2'})]){
  change();const fresh=await admitEmployeeApplication(f.deps);
  assert.throws(()=>assertEmployeeAdmissionKey(fresh,key),{code:'ACCESS_DENIED'});
 }
});
