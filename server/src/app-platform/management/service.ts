import {previewVerifiedPackage} from './preview.js';
import {AppApprovalStore} from './approvals.js';
import {AppMigrationLedger} from '../storage/migration-ledger.js';
import {AppStorageError} from '../storage/binding.js';
import {Client} from 'pg';
import {getDatabasePool} from '../../core/database/index.js';
import {PLATFORM_CAPABILITY_CATALOG} from '@metro/platform-sdk';
import {getCoreConfig} from '../../core/config/index.js';
import {AppRegistryService,PostgresAppRegistryRepository} from '../registry/index.js';
import {AppInstaller} from '../install/service.js';
import {PostgresInstallJournal} from '../install/journal.js';
import {AppVersionService,PostgresAppVersionJournal,createVersionedArtifactReader} from '../install/version-service.js';
import {createAppRuntimeComposition} from '../runtime/composition.js';
import {type PlatformManagementContext} from '../../platform/context/index.js';
import {createPostgresPeopleDirectoryRepository} from '../../platform/people/index.js';
import {createAuthorizationService,createPostgresAuthorizationRepository} from '../../platform/authorization/index.js';
import {loadPublisherPolicy} from '../developer/publisher-policy.js';
import {loadAppManagementConfig,manifestApprovalDigest,isAppRuntimeSupported} from './config.js';
import {createManagementQueue} from './queue.js';
import {readInstalledAdminUi,AppManagementError} from './ui.js';
import {createManagedStorageComposition,createStorageArtifactReader} from './storage.js';
import {createManagementGateway,createManagementApiAuthorization} from './gateway.js';
import {GatewayError} from '../gateway/model.js';
import {EmployeeAppAccess} from '../employee/access.js';
import {admitEmployeeApplication,employeeAdmissionKey,assertEmployeeAdmissionKey} from '../employee/admission.js';
import {createSandboxResourceServer} from '../sandbox/resource-server.js';
import {buildSandboxDocument} from '../sandbox/document.js';
/** Opt-in application management composition; does not run schema migrations on startup. */
export async function createAppManagement(configFile:string,origin:string){
 const config=await loadAppManagementConfig(configFile);
 const connectionString=getCoreConfig().database.url.reveal();
 if(!connectionString)throw new AppManagementError('ADMIN_DATABASE_UNAVAILABLE');
 const connect=async()=>{const client=new Client({connectionString});await client.connect();return client;};
 const db=await getDatabasePool()!.connect();const queue=createManagementQueue();
 let resources:Awaited<ReturnType<typeof createSandboxResourceServer>>|undefined;
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
 const approvals=new AppApprovalStore(getDatabasePool()!);
 await approvals.initialize(()=>loadPublisherPolicy(config.publisherPolicyFile),config.approvedManifestDigests);
 const registry=new AppRegistryService(repository,{authorization,host:async()=>({platformVersion:getCoreConfig().runtime.releaseVersion.value,capabilities:PLATFORM_CAPABILITY_CATALOG.map(({id,contractVersion})=>({id,contractVersion})),applications:(await repository.list(500)).filter(record=>record.enabled).map(record=>({id:record.appId,version:record.manifest.version}))})});
 const installJournal=new PostgresInstallJournal(db);
 const versionJournal=new PostgresAppVersionJournal(db);
 const readArtifact=createVersionedArtifactReader(installJournal,versionJournal);
 const storage=config.managedStorage?await createManagedStorageComposition({apiDatabaseUrl:connectionString,
  adminDatabaseUrl:process.env.MOP_APP_STORAGE_ADMIN_DATABASE_URL,apiClient:db,
  registry:client=>new AppRegistryService(new PostgresAppRegistryRepository(client),{authorization,host:()=>{throw new Error('STORAGE_REGISTRY_READ_ONLY');}}),
  reader:createStorageArtifactReader({getInstallation:appId=>repository.findByAppId(appId),readArtifact})}):undefined;
 const gateway=createManagementGateway(getDatabasePool()!,storage?.runtimeData.operations());
 const employeeAccess=new EmployeeAppAccess(getDatabasePool()!);
 const runtime=createAppRuntimeComposition({registry,gateway,api:createManagementApiAuthorization(getDatabasePool()!),connectLease:connect,artifactRoot:config.runtimeRoot,readArtifact,...(storage?{storage}:{}),...(config.docker?{docker:{...config.docker,client:db}}:{})});
 const approve=async(_context:PlatformManagementContext,manifest:Parameters<typeof manifestApprovalDigest>[0])=>{
  const fresh=await loadAppManagementConfig(configFile);
  return isAppRuntimeSupported(manifest,config)&&isAppRuntimeSupported(manifest,fresh)&&(await approvals.current()).approvedManifestDigests.includes(manifestApprovalDigest(manifest));
 };
 const loadPolicy=async()=>(await approvals.current()).policy;
 const installer=new AppInstaller({registry,journal:installJournal,artifactRoot:config.artifactRoot,loadPublisherPolicy:loadPolicy,approve,getHost:record=>runtime.getHost(record.appId)});
 const versions=new AppVersionService({registry,journal:versionJournal,installJournal,artifactRoot:config.artifactRoot,loadPublisherPolicy:loadPolicy,approve,getHost:appId=>runtime.getHost(appId)});
 async function assertRuntimeApproval(context:PlatformManagementContext|undefined,appId:string){
  const current=context?await registry.get(context,appId):await registry.runtimeSnapshot(appId),binding=await installJournal.get(appId);
  if(!binding||!['installed','recovered'].includes(binding.state))throw new AppManagementError('INSTALL_RECOVERY_REQUIRED');
  const digest=manifestApprovalDigest(current.manifest);
  const prepared=manifestApprovalDigest(binding.prepared.manifest)===digest?binding.prepared:(await versionJournal.list(appId)).find(record=>manifestApprovalDigest(record.prepared.manifest)===digest)?.prepared;
  const policyState=await approvals.current(),policy=policyState.policy,now=Date.now();
  const key=policy.keys.find(key=>key.keyId===prepared?.publisherKeyId&&key.publisherId===current.manifest.publisherId);
  const fresh=await loadAppManagementConfig(configFile);
  if(!prepared||!key||key.revoked||!key.appIds.includes(appId)||now<Date.parse(key.validFrom)||now>=Date.parse(key.validUntil)||!isAppRuntimeSupported(current.manifest,config)||!isAppRuntimeSupported(current.manifest,fresh)||!policyState.approvedManifestDigests.includes(digest))throw new AppManagementError('APP_RUNTIME_APPROVAL_REQUIRED');
  if((await approvals.current()).revision!==policyState.revision)throw new AppManagementError('APP_RUNTIME_APPROVAL_REQUIRED');
 }

 async function admitEmployee(appId:string,resolveIdentity:Parameters<typeof gateway.invokeDelegatedFromSession>[1]){
  const host=runtime.findHost(appId);if(!host)throw new GatewayError('ACCESS_DENIED',403);
  return admitEmployeeApplication({resolveIdentity,assertAccess:personId=>employeeAccess.assert(appId,personId),snapshot:()=>host.admittedSnapshot(),assertApproval:()=>assertRuntimeApproval(undefined,appId)});
 }

 if(process.env.MOP_APP_RESOURCE_ORIGIN)resources=await createSandboxResourceServer(origin,process.env.MOP_APP_RESOURCE_ORIGIN);
 const preview=(context:PlatformManagementContext,input:{directory:string;signatureFile:string})=>previewVerifiedPackage(context,input,{
  state:()=>approvals.get(context),installed:id=>repository.findByAppId(id),
  supported:async manifest=>isAppRuntimeSupported(manifest,config)&&isAppRuntimeSupported(manifest,await loadAppManagementConfig(configFile)),
 });

 return {
  approvalPolicy:(context:PlatformManagementContext)=>approvals.get(context),
  savePublisherPolicy:(context:PlatformManagementContext,revision:number,keys:Parameters<AppApprovalStore['save']>[2]['keys'])=>queue.run(()=>approvals.save(context,revision,{keys})),
  previewPackage:(context:PlatformManagementContext,input:{directory:string;signatureFile:string})=>queue.run(()=>preview(context,input)),
  approvePackage:(context:PlatformManagementContext,input:{directory:string;signatureFile:string},revision:number,digest:string)=>queue.run(async()=>{
   const result=await preview(context,input);
   if(result.digest!==digest||result.policyRevision!==revision)throw new AppManagementError('APPROVAL_STALE_REVISION');
   if(!result.supported||!result.compatible)throw new AppManagementError('APP_CAPABILITIES_NOT_SUPPORTED');
   return approvals.save(context,revision,{approval:{digest,approved:true}});
  }),
  revokeApproval:(context:PlatformManagementContext,revision:number,digest:string)=>queue.run(()=>approvals.save(context,revision,{approval:{digest,approved:false}})),
  async employeeApps(resolveIdentity:Parameters<typeof gateway.invokeDelegatedFromSession>[1]){
   const identity=await resolveIdentity();if(identity.source==='service'||!identity.userId)throw new GatewayError('ACCESS_DENIED',403);
   const candidates=await employeeAccess.candidates(identity.userId);const applications=[];
   for(const {appId}of candidates){try{const admitted=await admitEmployee(appId,resolveIdentity);if(admitted.identity.userId!==identity.userId)throw new GatewayError('ACCESS_DENIED',403);const m=admitted.installation.manifest;if(m.ui.mode==='sandbox')applications.push({appId,name:m.name,description:m.description,version:m.version,navigation:m.navigation,routes:m.routes});}catch(e){if(e instanceof GatewayError||e instanceof AppManagementError)continue;throw e;}}
   const fresh=await resolveIdentity();if(fresh.userId!==identity.userId)throw new GatewayError('ACCESS_DENIED',403);
   return {applications};
  },
  async employeeUi(appId:string,path:string,resolveIdentity:Parameters<typeof gateway.invokeDelegatedFromSession>[1]){
   const first=await admitEmployee(appId,resolveIdentity),m=first.installation.manifest;
   if(m.ui.mode!=='sandbox'||!m.routes.some(r=>r.path===path))throw new GatewayError('ACCESS_DENIED',403);
   const canonical=new URL(origin);if(!resources&&(canonical.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(canonical.hostname)))throw new AppManagementError('APP_RESOURCE_ORIGIN_NOT_CONFIGURED');
   const artifact=m.artifacts.find(a=>m.ui.mode==='sandbox'&&a.id===m.ui.entryArtifactId);if(!artifact)throw new AppManagementError('APP_UI_ARTIFACT_MISSING');
   const bytes=await readArtifact(m,artifact.id,artifact.bytes);
   const document=buildSandboxDocument({platformOrigin:origin,script:{text:Buffer.from(bytes).toString('utf8'),bytes:artifact.bytes,sha256:artifact.sha256}});
   const fresh=await admitEmployee(appId,resolveIdentity);
   if(fresh.identity.userId!==first.identity.userId||fresh.access.revision!==first.access.revision||fresh.installation.revision!==first.installation.revision)throw new GatewayError('ACCESS_DENIED',403);
   return {appId,name:m.name,api:m.api.map(({id,method,path})=>({id,method,path})),admissionKey:employeeAdmissionKey(first),instanceKey:`${employeeAdmissionKey(first)}:${path}`,resource:resources?resources.publish(document,async()=>{assertEmployeeAdmissionKey(await admitEmployee(appId,resolveIdentity),employeeAdmissionKey(first));}):{mode:'local-demo' as const,html:document.html,platformOrigin:origin}};
  },
  async invokeEmployee(appId:string,resolveIdentity:Parameters<typeof gateway.invokeDelegatedFromSession>[1],request:unknown,admissionKey:string){
   const host=runtime.findHost(appId);
   if(!host)throw new GatewayError('ACCESS_DENIED',403);
   return host.invokeDelegated(async()=>{const admission=await admitEmployee(appId,resolveIdentity);assertEmployeeAdmissionKey(admission,admissionKey);return admission.identity;},request);
  },
  async invokeEmployeeApi(appId:string,resolveIdentity:Parameters<typeof gateway.invokeDelegatedFromSession>[1],request:Parameters<Awaited<ReturnType<typeof runtime.getHost>>['invokeEmployeeApi']>[1],admissionKey:string){
   const host=runtime.findHost(appId);if(!host)throw new GatewayError('ACCESS_DENIED',403);
   return host.invokeEmployeeApi(async()=>{const admission=await admitEmployee(appId,resolveIdentity);assertEmployeeAdmissionKey(admission,admissionKey);return admission.identity;},request);
  },
  migrationHistory:(context:PlatformManagementContext,appId:string,afterSequence:number)=>queue.run(async()=>{
   const installation=await registry.get(context,appId);
   const attempts=await new AppMigrationLedger(registry,db).listHistory(context,appId,afterSequence,100);
   if(!(await context.authorize('platform.authorization.read',{})).allowed)throw new AppStorageError('STORAGE_ACCESS_DENIED');
   return {revision:installation.revision,enabled:installation.enabled,attempts,nextSequence:attempts.length===100?attempts[attempts.length-1].sequence:null};
  }),
  writeHistory:(context:PlatformManagementContext,appId:string,after:string|null)=>queue.run(async()=>{
   const installation=await registry.get(context,appId);
   if(!(await context.authorize('platform.authorization.read',{})).allowed)throw new AppStorageError('STORAGE_ACCESS_DENIED');
   const result=await db.query(`SELECT request_id AS "requestId",status,created_at AS "createdAt",completed_at AS "completedAt" FROM public.platform_app_runtime_storage_writes
    WHERE installation_id=$1 AND ($2::uuid IS NULL OR request_id>$2::uuid) ORDER BY request_id LIMIT 100`,[installation.id,after]);
   if(!(await context.authorize('platform.authorization.read',{})).allowed)throw new AppStorageError('STORAGE_ACCESS_DENIED');
   return {revision:installation.revision,enabled:installation.enabled,writes:result.rows,nextCursor:result.rows.length===100?result.rows[99].requestId:null};
  }),
  reconcileWrite:(context:PlatformManagementContext,appId:string,revision:number,requestId:string)=>queue.run(()=>{
   if(!storage)throw new AppStorageError('STORAGE_NOT_CONFIGURED');
   return storage.reconcileWrite(context,appId,revision,requestId);
  }),
  reconcileMigration:(context:PlatformManagementContext,appId:string,revision:number,attemptId:string)=>queue.run(()=>{
   if(!storage)throw new AppStorageError('STORAGE_NOT_CONFIGURED');
   return storage.reconcile(context,appId,revision,attemptId);
  }),
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
  ui:(context:PlatformManagementContext,appId:string,path:string)=>queue.run(async()=>{await assertRuntimeApproval(context,appId);return readInstalledAdminUi({context,appId,path,origin,host:await runtime.getHost(appId),readArtifact,publish:resources?(document,authorize)=>resources!.publish(document,async()=>{await assertRuntimeApproval(context,appId);await authorize();}):undefined});}),
  close:()=>queue.close(async()=>{await resources?.close();await runtime.close();db.release();}),
 };
 }catch(error){await resources?.close();db.release();throw error;}
}
export type AppManagement=Awaited<ReturnType<typeof createAppManagement>>;
