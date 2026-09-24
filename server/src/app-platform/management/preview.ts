import {createHash} from 'node:crypto';
import type {PlatformManagementContext} from '../../platform/context/index.js';
import type {AppInstallation} from '../registry/index.js';
import type {AppManifest} from '../manifest/index.js';
import {verifyAppWithPublisherPolicy} from '../developer/publisher-policy.js';
import {assertInstallAdmin} from '../install/service.js';
import {isAppendOnlyStorageVersion} from '../manifest/storage-version.js';
import {manifestApprovalDigest} from './config.js';
import type {ApprovalDocument} from './approvals.js';
import {AppManagementError} from './ui.js';
export async function previewVerifiedPackage(context:PlatformManagementContext,input:{directory:string;signatureFile:string},options:{
 state():Promise<ApprovalDocument>;
 installed(appId:string):Promise<AppInstallation|null>;
 supported(manifest:AppManifest):Promise<boolean>;
}){
 await assertInstallAdmin(context);
 const verified=await verifyAppWithPublisherPolicy(input.directory,input.signatureFile,async()=>(await options.state()).policy);
 const manifest=verified.manifest,digest=manifestApprovalDigest(manifest),current=await options.installed(manifest.id);
 const supported=await options.supported(manifest),state=await options.state();
 if(createHash('sha256').update(JSON.stringify(state.policy)).digest('hex')!==verified.policySha256)throw new AppManagementError('APPROVAL_STALE_REVISION');
 const compatible=!current||(current.manifest.publisherId===manifest.publisherId&&isAppendOnlyStorageVersion(current.manifest,manifest));
 const oldPermissions=new Set(current?.manifest.permissions.requested??[]),newPermissions=new Set(manifest.permissions.requested);
 await assertInstallAdmin(context);
 return {manifest,digest,policyRevision:state.revision,approved:state.approvedManifestDigests.includes(digest),supported,compatible,keyId:verified.keyId,
  installed:current?{version:current.manifest.version,revision:current.revision,enabled:current.enabled,frontendRunMode:current.frontendRunMode==='trusted'?'trusted':'standard'}:null,
  changes:{addedPermissions:[...newPermissions].filter(p=>!oldPermissions.has(p)),removedPermissions:[...oldPermissions].filter(p=>!newPermissions.has(p)),
   addedMigrations:manifest.storage.mode==='managed'?manifest.storage.migrations.slice(current?.manifest.storage.mode==='managed'?current.manifest.storage.migrations.length:0).map(m=>m.id):[]}};
}
