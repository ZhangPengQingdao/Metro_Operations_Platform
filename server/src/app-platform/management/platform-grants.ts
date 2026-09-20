import {runAtomicOperation} from '../../core/database/index.js';
import type {PlatformManagementContext} from '../../platform/context/index.js';
import type {AppManifest} from '../manifest/index.js';
import type {AppRegistryService} from '../registry/index.js';
import {AppManagementError} from './ui.js';

const supported=new Set(['platform.app_data.read','platform.app_data.write','platform.people.read','platform.locations.read','platform.assets.read']);
export function requestedPlatformCapabilities(manifest:AppManifest){
 const defined=new Set(manifest.permissions.defined.map(p=>p.code));
 if(manifest.permissions.requested.some(code=>!code.startsWith('platform.')&&!defined.has(code)))throw new AppManagementError('APP_CAPABILITIES_NOT_SUPPORTED');
 const permissions=manifest.permissions.requested.filter(code=>code.startsWith('platform.'));
 if(permissions.some(code=>!supported.has(code)))throw new AppManagementError('APP_CAPABILITIES_NOT_SUPPORTED');
 return permissions;
}
/** Atomic ceilings only. Business permissions and employee role assignments remain application-owned. */
export async function approveInstalledPlatformGrants(registry:AppRegistryService,context:PlatformManagementContext,appId:string){
 return runAtomicOperation([registry],async()=>{
  let record=await registry.get(context,appId);
  if(record.enabled)throw new AppManagementError('DISABLE_REQUIRED');
  const mode=record.manifest.backend.mode==='none'?'delegated_user':'service';
  for(const permissionCode of requestedPlatformCapabilities(record.manifest)){
   record=await registry.approveGrant(context,appId,record.revision,{permissionCode,mode,scope:{kind:'all',targets:[]},...(mode==='service'?{serviceIdentityId:record.serviceIdentityId!}:{})},'Approved with signed application package');
  }
  return record;
 });
}
