import {isAppDashboardSnapshot} from '@metro/platform-sdk/app-dashboard';
import {GatewayError} from '../gateway/model.js';
import {employeeAdmissionKey,assertEmployeeAdmissionKey} from './admission.js';
import type {EmployeeAppSession} from './app-session.js';
import type {AppManifest} from '@metro/platform-sdk/app-manifest';

export async function readEmployeeDashboard(deps:{
 admit():Promise<EmployeeAppSession>;
 navigation(admission:EmployeeAppSession):Promise<{routes:{id:string}[]}>;
 invoke(api:AppManifest['api'][number],resolveIdentity:()=>Promise<EmployeeAppSession['identity']>):Promise<unknown>;
}){
 const first=await deps.admit(),manifest=first.installation.manifest;
 const declaration=manifest.dashboard,api=manifest.api.find(api=>api.id===declaration?.apiId);
 if(!declaration||!api||api.expose?.mode!=='read'||!['GET','POST'].includes(api.method)||!(await deps.navigation(first)).routes.some(route=>route.id===declaration.routeId))throw new GatewayError('ACCESS_DENIED',403);
 const key=employeeAdmissionKey(first);
 const result=await deps.invoke(api,async()=>{const admission=await deps.admit();assertEmployeeAdmissionKey(admission,key);return admission.identity;});
 assertEmployeeAdmissionKey(await deps.admit(),key);
 if(result&&typeof result==='object'&&!Array.isArray(result)){
  const envelope=result as Record<string,unknown>;
  if(envelope.ok===false&&envelope.error&&typeof envelope.error==='object'&&'code' in envelope.error&&envelope.error.code==='ACCESS_DENIED')throw new GatewayError('ACCESS_DENIED',403);
  if(Object.keys(envelope).sort().join(',')==='ok,result'&&envelope.ok===true&&isAppDashboardSnapshot(envelope.result))return envelope.result;
 }
 throw new GatewayError('INVALID_RESULT',502);
}
