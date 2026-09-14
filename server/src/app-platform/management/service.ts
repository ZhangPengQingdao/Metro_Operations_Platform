import {Client} from 'pg';
import {getDatabasePool} from '../../core/database/index.js';
import {PLATFORM_CAPABILITY_CATALOG} from '@metro/platform-sdk';
import {getCoreConfig} from '../../core/config/index.js';
import {AppRegistryService,PostgresAppRegistryRepository} from '../registry/index.js';
import {AppInstaller} from '../install/service.js';
import {PostgresInstallJournal} from '../install/journal.js';
import {AppVersionService,PostgresAppVersionJournal,createVersionedArtifactReader} from '../install/version-service.js';
import {createAppRuntimeComposition} from '../runtime/composition.js';
import {AppGateway} from '../gateway/gateway.js';
import {createPlatformActorContextResolver,type PlatformManagementContext} from '../../platform/context/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {createAuthorizationService,createPostgresAuthorizationRepository} from '../../platform/authorization/index.js';
import {loadPublisherPolicy} from '../developer/publisher-policy.js';
import {loadAppManagementConfig,manifestApprovalDigest,isAppRuntimeSupported} from './config.js';
import {createManagementQueue} from './queue.js';
import {readInstalledAdminUi,AppManagementError} from './ui.js';
/** Opt-in application management composition; does not run schema migrations on startup. */
export async function createAppManagement(configFile:string,origin:string){
 const config=await loadAppManagementConfig(configFile);
 const connectionString=getCoreConfig().database.url.reveal();
 if(!connectionString)throw new AppManagementError('ADMIN_DATABASE_UNAVAILABLE');
 const connect=async()=>{const client=new Client({connectionString});await client.connect();return client;};
 const db=await getDatabasePool()!.connect();const queue=createManagementQueue();
 try{
 const required=await db.query("SELECT to_regclass('platform_app_install_requests') AS installs,to_regclass('platform_app_runtime_work') AS work,to_regclass('platform_app_docker_dispatches') AS docker,to_regclass('platform_app_versions') AS versions");
 if(!required.rows[0].installs||!required.rows[0].work||!required.rows[0].versions||(config.docker&&!required.rows[0].docker))throw new AppManagementError('APP_MANAGEMENT_MIGRATIONS_REQUIRED');
 if(config.docker){
  const migration=await db.query("SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('platform_app_docker_dispatches') AND conname='platform_app_docker_rejected_create_check' AND convalidated");
  if(!migration.rowCount)throw new AppManagementError('APP_MANAGEMENT_MIGRATIONS_REQUIRED');
 }
 const repository=new PostgresAppRegistryRepository(db);
 const people=createPostgresPeopleDirectoryRepository(db);
 const authorization=createAuthorizationService(createPostgresAuthorizationRepository(db),{findPerson:id=>people.findPersonById(id)});
 const registry=new AppRegistryService(repository,{authorization,host:async()=>({platformVersion:getCoreConfig().runtime.releaseVersion.value,capabilities:PLATFORM_CAPABILITY_CATALOG.map(({id,contractVersion})=>({id,contractVersion})),applications:(await repository.list(500)).filter(record=>record.enabled).map(record=>({id:record.appId,version:record.manifest.version}))})});
 const resolver=createPlatformActorContextResolver({people,authorization,resolveAppGrant:registry.createGrantResolver()});
 // No implicit business operations. Named adapters must be composed explicitly before admission.
 const gateway=new AppGateway({registry,contextResolver:resolver,operations:[]});
 const installJournal=new PostgresInstallJournal(db);
 const versionJournal=new PostgresAppVersionJournal(db);
 const readArtifact=createVersionedArtifactReader(installJournal,versionJournal);
 const runtime=createAppRuntimeComposition({registry,gateway,connectLease:connect,artifactRoot:config.runtimeRoot,readArtifact,...(config.docker?{docker:{...config.docker,client:db}}:{})});
 const approve=async(_context:PlatformManagementContext,manifest:Parameters<typeof manifestApprovalDigest>[0])=>{
  const fresh=await loadAppManagementConfig(configFile);
  return isAppRuntimeSupported(manifest,config)&&fresh.approvedManifestDigests.includes(manifestApprovalDigest(manifest));
 };
 const loadPolicy=()=>loadPublisherPolicy(config.publisherPolicyFile);
 const installer=new AppInstaller({registry,journal:installJournal,artifactRoot:config.artifactRoot,loadPublisherPolicy:loadPolicy,approve,getHost:record=>runtime.getHost(record.appId)});
 const versions=new AppVersionService({registry,journal:versionJournal,installJournal,artifactRoot:config.artifactRoot,loadPublisherPolicy:loadPolicy,approve,getHost:appId=>runtime.getHost(appId)});
 async function assertRuntimeApproval(context:PlatformManagementContext,appId:string){
  const current=await registry.get(context,appId),binding=await installJournal.get(appId);
  if(!binding||!['installed','recovered'].includes(binding.state))throw new AppManagementError('INSTALL_RECOVERY_REQUIRED');
  const digest=manifestApprovalDigest(current.manifest);
  const prepared=manifestApprovalDigest(binding.prepared.manifest)===digest?binding.prepared:(await versionJournal.list(appId)).find(record=>manifestApprovalDigest(record.prepared.manifest)===digest)?.prepared;
  const policy=await loadPolicy(),now=Date.now();
  const key=policy.keys.find(key=>key.keyId===prepared?.publisherKeyId&&key.publisherId===current.manifest.publisherId);
  if(!prepared||!key||key.revoked||!key.appIds.includes(appId)||now<Date.parse(key.validFrom)||now>=Date.parse(key.validUntil)||!await approve(context,current.manifest))throw new AppManagementError('APP_RUNTIME_APPROVAL_REQUIRED');
 }

 return {
  uploadRoot:config.uploadRoot,
  install:(context:PlatformManagementContext,input:Parameters<AppInstaller['install']>[1])=>queue.run(()=>installer.install(context,input)),
  status:(context:PlatformManagementContext,appId:string)=>queue.run(()=>installer.status(context,appId)),
  recover:(context:PlatformManagementContext,appId:string,revision:number)=>queue.run(()=>installer.recover(context,appId,revision)),
  versionUpdate:(context:PlatformManagementContext,input:Parameters<AppVersionService['update']>[1])=>queue.run(()=>versions.update(context,input)),
  versionStatus:(context:PlatformManagementContext,appId:string)=>queue.run(()=>versions.status(context,appId)),
  versionRecover:(context:PlatformManagementContext,appId:string,requestId:string)=>queue.run(()=>versions.recover(context,appId,requestId)),
  async getHost(appId:string){
   const host=await runtime.getHost(appId);
   return {status:(context:PlatformManagementContext)=>queue.run(()=>host.status(context)),
    execute:(context:PlatformManagementContext,input:Parameters<typeof host.execute>[1])=>queue.run(async()=>{
     if(['upgrade','rollback'].includes(input.action))throw new AppManagementError('SIGNED_PACKAGE_REQUIRED');
     if(input.action==='install')throw new AppManagementError('SIGNED_PACKAGE_REQUIRED');
     if(input.action==='enable'){await versions.assertActivationAllowed(context,appId);await assertRuntimeApproval(context,appId);}
     return host.execute(context,input);
    }),
    recover:(context:PlatformManagementContext,revision:number)=>queue.run(()=>host.recover(context,revision)),
    prepareCredential:(context:PlatformManagementContext,revision:number)=>queue.run(()=>host.prepareCredential(context,revision)),
   };
  },
  ui:(context:PlatformManagementContext,appId:string,path:string)=>queue.run(async()=>{await assertRuntimeApproval(context,appId);return readInstalledAdminUi({context,appId,path,origin,host:await runtime.getHost(appId),readArtifact});}),
  close:()=>queue.close(async()=>{await runtime.close();db.release();}),
 };
 }catch(error){db.release();throw error;}
}
export type AppManagement=Awaited<ReturnType<typeof createAppManagement>>;
