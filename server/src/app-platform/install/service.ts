import { isDeepStrictEqual } from 'node:util';
import { runAtomicOperation } from '../../core/database/index.js';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import type { AppFrontendRunMode } from '../registry/index.js';
import type { AppLifecycleHost } from '../runtime/lifecycle-host.js';
import { prepareAppInstallation } from '../developer/install-preparation.js';
import { validateAppDirectory } from '../developer/package.js';
import { verifyAppWithPublisherPolicy } from '../developer/publisher-policy.js';
import { InstallError, type InstallJournal, type InstallRecord, type InstallState } from './journal.js';
export interface AppInstallerOptions {
 /** Configure explicitly approved platform grants while the installation is still disabled. */
 beforeInstall?(context:PlatformManagementContext,record:InstallRecord):Promise<void>;
 supportsTrusted?:boolean;
 registry:AppRegistryService; journal:InstallJournal; artifactRoot:string;
 loadPublisherPolicy():Promise<unknown>;
 /** Native platform policy: separately approve UI trust, network/runtime and resources. No grants implied. */
 approve(context:PlatformManagementContext,manifest:InstallRecord['prepared']['manifest']):Promise<boolean>;
 /** Stable platform-owned host, pinned to record.prepared bytes. Must never be constructed from client options. */
 getHost(record:InstallRecord):Promise<Pick<AppLifecycleHost,'execute'|'status'|'recover'>>;
}
export async function assertInstallAdmin(context:PlatformManagementContext){
 if(!isNativeManagementActor(context)||!(await context.authorize('platform.authorization.manage',{})).allowed)throw new InstallError('INSTALL_ACCESS_DENIED');
}
export class AppInstaller {
 constructor(private readonly options:AppInstallerOptions){}
 private async change(appId:string,expected:number,state:InstallState){return runAtomicOperation([this.options.journal],async()=>{
  const old=await this.options.journal.get(appId,true);if(!old||old.revision!==expected)throw new InstallError('INSTALL_CONFLICT');
  const next={...old,state,revision:expected+1,updatedAt:new Date().toISOString()};await this.options.journal.save(next,expected);return next;
 });}
 async status(context:PlatformManagementContext,appId:string){await assertInstallAdmin(context);const record=await this.options.journal.get(appId);if(!record)throw new InstallError('INSTALL_NOT_FOUND');return this.public(record);}
 private public(record:InstallRecord){return {appId:record.appId,requestId:record.requestId,installationId:record.installationId,revision:record.revision,state:record.state};}
 async install(context:PlatformManagementContext,input:{requestId:string;directory:string;signatureFile:string;frontendRunMode?:AppFrontendRunMode}){
  await assertInstallAdmin(context);
  const frontendMode=input.frontendRunMode??'standard';
  if(frontendMode!=='standard'&&frontendMode!=='trusted'||frontendMode==='trusted'&&!this.options.supportsTrusted)throw new InstallError('INVALID_FRONTEND_MODE');
  if(!/^[a-zA-Z0-9-]{16,64}$/.test(input.requestId))throw new InstallError('INVALID_INSTALL_REQUEST');
  const {manifest}=await validateAppDirectory(input.directory);
  const prior=await this.options.journal.get(manifest.id);
  if(prior){if(prior.requestId!==input.requestId||!isDeepStrictEqual(prior.prepared.manifest,manifest))throw new InstallError('INSTALL_EXISTS');return this.public(prior);}
  if(!await this.options.approve(context,manifest))throw new InstallError('INSTALL_POLICY_DENIED');
  const prepared=await prepareAppInstallation({...input,context,artifactRoot:this.options.artifactRoot,loadPublisherPolicy:this.options.loadPublisherPolicy});
  // From this point keep the immutable bundle on uncertain DB outcomes; never delete bytes possibly bound by a committed transaction.
  const record=await runAtomicOperation([this.options.registry,this.options.journal],async()=>{
   await assertInstallAdmin(context);
   const verified=await verifyAppWithPublisherPolicy(input.directory,input.signatureFile,this.options.loadPublisherPolicy);
   if(verified.manifestSha256!==prepared.signatureManifestSha256||verified.policySha256!==prepared.publisherPolicySha256||!await this.options.approve(context,prepared.manifest))throw new InstallError('INSTALL_ADMISSION_CHANGED');
   const installation=await this.options.registry.register(context,prepared.manifest,'Signed package first installation',frontendMode);
   const record:InstallRecord={appId:installation.appId,requestId:input.requestId,installationId:installation.id,revision:1,state:'registered',prepared,actorId:context.actorType==='administrator'?`administrator:${context.administrator.id}`:managementActorId(context),updatedAt:new Date().toISOString()};
   await this.options.journal.insert(record);return record;
  });
  const running=await this.change(record.appId,record.revision,'installing');
  try{
   // Final admission immediately before runtime work. The host independently repeats native authorization and revision checks.
   await assertInstallAdmin(context);
   const verified=await verifyAppWithPublisherPolicy(input.directory,input.signatureFile,this.options.loadPublisherPolicy);
   if(verified.manifestSha256!==prepared.signatureManifestSha256||verified.policySha256!==prepared.publisherPolicySha256||!await this.options.approve(context,prepared.manifest))throw new InstallError('INSTALL_ADMISSION_CHANGED');
   const host=await this.options.getHost(running);
   await this.options.beforeInstall?.(context,running);
   const current=await this.options.registry.get(context,record.appId);
   if(current.id!==record.installationId)throw new InstallError('INSTALL_IDENTITY_CHANGED');
   const installed=await host.execute(context,{revision:current.revision,action:'install'});
   if(!installed.enabled||installed.id!==record.installationId||installed.lifecycle?.action!=='install'||installed.lifecycle.status!=='completed')throw new InstallError('INSTALL_UNCONFIRMED');
   return this.public(await this.change(record.appId,running.revision,'installed'));
  }catch{
   // Runtime outcome may be unknown. No retry/rollback assertion and no artifact deletion.
   try{await this.change(record.appId,running.revision,'recovery_required');}catch{throw new InstallError('INSTALL_OUTCOME_UNKNOWN');}
   throw new InstallError('INSTALL_RECOVERY_REQUIRED');
  }
 }
 async recover(context:PlatformManagementContext,appId:string,revision:number){
  await assertInstallAdmin(context);const record=await this.options.journal.get(appId);
  if(!record||record.revision!==revision||!['registered','installing','recovery_required','recovering'].includes(record.state))throw new InstallError('INSTALL_CONFLICT');
  const claimed=await this.change(appId,revision,'recovering');
  try{
   const host=await this.options.getHost(claimed);const current=await this.options.registry.get(context,appId);
   if(current.id!==record.installationId)throw new InstallError('INSTALL_IDENTITY_CHANGED');
   const result=await host.recover(context,current.revision);
   if(result.enabled)throw new InstallError('INSTALL_UNCONFIRMED');
   return this.public(await this.change(appId,claimed.revision,'recovered'));
  }catch{throw new InstallError('INSTALL_RECOVERY_REQUIRED');}
 }
}
