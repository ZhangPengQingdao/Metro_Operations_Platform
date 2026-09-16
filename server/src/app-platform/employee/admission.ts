import {isDeepStrictEqual} from 'node:util';
import type {TrustedActorIdentity} from '../../core/identity/index.js';
import type {AppInstallation} from '../registry/index.js';
import {GatewayError} from '../gateway/model.js';

interface AdmissionDependencies {
 resolveIdentity():Promise<TrustedActorIdentity>;
 assertAccess(personId:string):Promise<{installationId:string;revision:string}>;
 snapshot():Promise<AppInstallation>;
 assertApproval():Promise<void>;
}
/** Recheck mutable admission evidence after asynchronous policy reads. No caller-supplied identity. */
export async function admitEmployeeApplication(deps:AdmissionDependencies){
 const identity=structuredClone(await deps.resolveIdentity());
 if(identity.source==='service'||!identity.userId)throw new GatewayError('ACCESS_DENIED',403);
 const access=await deps.assertAccess(identity.userId),installation=await deps.snapshot();
 if(access.installationId!==installation.id)throw new GatewayError('ACCESS_DENIED',403);
 await deps.assertApproval();
 const freshIdentity=await deps.resolveIdentity();
 if(!isDeepStrictEqual(identity,freshIdentity))throw new GatewayError('ACCESS_DENIED',403);
 const freshAccess=await deps.assertAccess(identity.userId),freshInstallation=await deps.snapshot();
 if(!isDeepStrictEqual(access,freshAccess)||installation.id!==freshInstallation.id||installation.revision!==freshInstallation.revision)throw new GatewayError('ACCESS_DENIED',403);
 return {identity,access,installation};
}

/** Host-held frame binding; not a credential and never forwarded into the sandbox. */
export function employeeAdmissionKey(admission:Awaited<ReturnType<typeof admitEmployeeApplication>>){
 return `${admission.identity.userId}:${admission.installation.id}:${admission.installation.revision}:${admission.access.revision}`;
}
export function assertEmployeeAdmissionKey(admission:Awaited<ReturnType<typeof admitEmployeeApplication>>,expected:string){
 if(employeeAdmissionKey(admission)!==expected)throw new GatewayError('ACCESS_DENIED',403);
}
