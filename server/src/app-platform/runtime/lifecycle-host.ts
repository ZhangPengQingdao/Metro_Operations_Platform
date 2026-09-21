import type { PlatformActorContext } from '../../platform/context/index.js';
import {randomUUID} from 'node:crypto';
import { AppRuntimeWorkJournal } from './work-journal.js';
import { createHostedAppApi, type HostedAppApiOptions } from './hosted-api.js';
import { isDeepStrictEqual } from 'node:util';
import { isNativeManagementActor, managementActorId, type PlatformManagementContext } from '../../platform/context/index.js';
import type { AppInstallation, AppLifecycleAction, AppRegistryService } from '../registry/index.js';
import { validateAppManifest, type AppManifest } from '../manifest/index.js';
import type { AppGateway } from '../gateway/gateway.js';
import { GatewayError } from '../gateway/model.js';
import type { ManagedAppStorageService } from '../storage/managed-storage.js';
import { AppExtensionRegistry } from '../extensions/registry.js';
import { startAppExtensionRuntime, AppExtensionRuntimeStartError, type AppExtensionRuntimeOptions, type AppExtensionRuntimeSession } from '../extensions/runtime.js';
import type { AppExtensionMapping } from '../extensions/model.js';
import { stageAppArtifacts } from './artifacts.js';
import { compileAppDockerPolicy } from './docker-policy.js';
import type { AppDockerExecutor, AppDockerImageApproval } from './docker-executor.js';
import type { AppDockerJournal, AppDockerDispatchAttempt } from './docker-journal.js';
import { AppDockerSupervisor } from './docker-supervisor.js';
import { AppDockerReadiness } from './docker-readiness.js';
import { attachAppDocker } from './docker-attach.js';
import { startAppStdioGateway, type AppStdioGatewaySession } from './stdio-gateway.js';
import { acquireAppRuntimeLease, type AppRuntimeLease } from './host-lease.js';

export class AppLifecycleHostError extends Error {
  constructor(readonly code: string, options?:ErrorOptions) { super(code,options); this.name = 'AppLifecycleHostError'; }
}
export interface AppLifecycleHostOptions {
  appId: string;
  registry: AppRegistryService;
  gateway: AppGateway;
  /** A fresh dedicated PostgreSQL session per installation; held while this host owns runtime work. */
  connectLease: Parameters<typeof acquireAppRuntimeLease>[0]['connect'];
  artifactRoot: string;
  readArtifact(manifest: AppManifest, artifactId: string, maxBytes: number): Promise<Uint8Array>;
  storage?: ManagedAppStorageService;
  docker?: { socketPath: string; runtimeImage: string; approval: AppDockerImageApproval; executor: AppDockerExecutor; journal: AppDockerJournal };
  extensions?: { registry: AppExtensionRegistry; mappings: readonly AppExtensionMapping[];
    options(installation: AppInstallation): Omit<AppExtensionRuntimeOptions, 'handle' | 'drainGateway'> };
  /** Separately approved platform external adapter. Never constructed from an app URL by this host. */
  external?: { check(installation: AppInstallation, signal: AbortSignal): Promise<void>; stop(installation: AppInstallation): Promise<void> };
  api?: Pick<HostedAppApiOptions, 'contextResolver' | 'authorize' | 'businessAuthorization'>;
  healthWaitMs?: number;
  maintenanceBlocked?:()=>boolean;
}
export interface AppLifecycleRequest { revision: number; action: AppLifecycleAction; targetManifest?: unknown }
function fail(code: string): never { throw new AppLifecycleHostError(code); }
function hosted(record: AppInstallation) { return ['trusted', 'isolated'].includes(record.manifest.backend.mode); }
function contributions(record: AppInstallation) { const m=record.manifest; return m.events.publish.length+m.events.subscribe.length+m.jobs.length+m.tools.length; }

/** One installation owner. No raw settle/health/credential over a wire API. Registry CAS, durable Docker
 * dispatch, storage lock and the session lease are all checked before activation. Recovery only quiesces
 * and cancels interrupted work; it never replays a write or assumes a migration was rolled back. */
export class AppLifecycleHost {
  private lease?: AppRuntimeLease;
  private busy = false;
  private apiCalls = 0;
  private credential?: { identityId: string; value: string };
  private bridge?: AppStdioGatewaySession;
  private extensions?: AppExtensionRuntimeSession;
  private active?: AppInstallation;
  private api?: ReturnType<typeof createHostedAppApi>;
  private readonly options: AppLifecycleHostOptions;
  private readonly workJournal: AppRuntimeWorkJournal;
  private readonly gatedGateway: Pick<AppGateway,'invokeService'|'drain'>;
  constructor(options: AppLifecycleHostOptions) {
    this.options = { ...options, ...(options.docker ? { docker: { ...options.docker, approval: structuredClone(options.docker.approval) } } : {}) };
    this.workJournal=new AppRuntimeWorkJournal(options.connectLease);
    this.gatedGateway={
      invokeService:async(...args)=>{
        if(this.options.maintenanceBlocked?.()&&this.apiCalls===0)throw new GatewayError('ACCESS_DENIED',503);
        if(!this.active||!this.lease||this.lease.signal.aborted)throw new GatewayError('ACCESS_DENIED',403);
        await this.lease.assertHeld();
        if(!this.active)throw new GatewayError('ACCESS_DENIED',403);
        const installation=this.active;const lease=this.lease;
        return this.workJournal.track(installation.id,async()=>{await lease.assertHeld();if(this.active!==installation)throw new GatewayError('ACCESS_DENIED',403);},
          ()=>this.options.gateway.invokeService(...args),()=>this.options.gateway.drain(installation.appId));
      },
      drain:appId=>this.options.gateway.drain(appId),
    };
    const wait=options.healthWaitMs??30_000;
    if (!Number.isInteger(wait)||wait<1||wait>60_000) fail('INVALID_HEALTH_WAIT');
  }
  async invokeApi(context: PlatformActorContext, request: Parameters<ReturnType<typeof createHostedAppApi>['invoke']>[1], signal?: AbortSignal, assertAdmission?:()=>Promise<void>) {
    if(this.options.maintenanceBlocked?.())fail('PLATFORM_MAINTENANCE');
    if(!this.active||!this.api||!this.lease)fail('API_NOT_READY');
    const lease=this.lease,api=this.api,installation=this.active,transport=this.bridge!.api;
    this.apiCalls++;
    try{return await this.workJournal.track(installation.id,async()=>{await lease.assertHeld();if(this.active!==installation)fail('API_NOT_READY');},
      ()=>api.invoke(context,request,signal,assertAdmission),()=>transport.drain(),{kind:'api',requestId:context.request.requestId,apiId:request.apiId});}
    finally{this.apiCalls--;}
  }
  /** Verified employee session callback is retained for every nested service authorization. */
  async invokeEmployeeApi(resolveIdentity:Parameters<AppGateway['invokeDelegatedFromSession']>[1],request:Parameters<ReturnType<typeof createHostedAppApi>['invoke']>[1],signal?:AbortSignal){
    if(!this.active||!this.api||!this.options.api)throw new GatewayError('ACCESS_DENIED',403);
    const input=structuredClone(request),identity=structuredClone(await resolveIdentity());
    if(identity.source==='service')throw new GatewayError('ACCESS_DENIED',403);
    const assertAdmission=async()=>{await this.admittedSnapshot();if(!isDeepStrictEqual(identity,await resolveIdentity()))throw new GatewayError('ACCESS_DENIED',403);};
    await assertAdmission();
    const actor=await this.options.api.contextResolver.resolve({actorType:'person',trustedIdentity:identity,execution:{type:'application',appId:this.options.appId},requestId:randomUUID(),traceId:randomUUID()});
    await assertAdmission();
    return this.invokeApi(actor,input,signal,assertAdmission);
  }
  /** Employee ingress uses the same durable work boundary as backend service requests. */
  async invokeDelegated(resolveIdentity:Parameters<AppGateway['invokeDelegatedFromSession']>[1],request:unknown,signal?:AbortSignal){
    if(this.options.maintenanceBlocked?.())throw new GatewayError('ACCESS_DENIED',503);
    if(!this.active||!this.lease||this.lease.signal.aborted)throw new GatewayError('ACCESS_DENIED',403);
    const installation=this.active,lease=this.lease;
    return this.workJournal.track(installation.id,async()=>{await lease.assertHeld();if(this.active!==installation)throw new GatewayError('ACCESS_DENIED',403);},
      ()=>this.options.gateway.invokeDelegatedFromSession(installation.appId,resolveIdentity,request,signal),()=>this.options.gateway.drain(installation.appId));
  }
  async status(context: PlatformManagementContext) {
    const installation=await this.options.registry.get(context,this.options.appId);
    return { installation, pendingWork:await this.workJournal.pending(installation.id), owned:!!this.lease&&!this.lease.signal.aborted, serving:!!this.active&&this.active.revision===installation.revision&&installation.enabled };
  }
  async admittedSnapshot(){
    const lease=this.lease,active=this.active;
    if(!lease||!active||lease.signal.aborted)throw new GatewayError('ACCESS_DENIED',403);
    await lease.assertHeld();
    const installation=await this.options.registry.runtimeSnapshot(this.options.appId);
    await lease.assertHeld();
    if(lease.signal.aborted||this.active!==active||this.lease!==lease||!installation.enabled||installation.revision!==active.revision)throw new GatewayError('ACCESS_DENIED',403);
    return installation;
  }
  /** Prepare a host-only credential before administrators approve service grants. Never returns the secret. */
  prepareCredential(context: PlatformManagementContext, revision: number) {
    return this.exclusive(context,revision,async record=>{
      if(record.enabled)fail('DISABLE_REQUIRED');
      const issued=await this.options.registry.issueServiceCredential(context,record.appId,record.revision);
      this.credential={identityId:issued.installation.serviceIdentityId!,value:issued.credential};
      return issued.installation;
    });
  }
  execute(context: PlatformManagementContext, request: AppLifecycleRequest) {
    const input=structuredClone(request);
    return this.exclusive(context,input.revision,async record=>{
      if(!['install','enable','disable','upgrade','rollback','uninstall'].includes(input.action))fail('INVALID_ACTION');
      const starting=['install','enable'].includes(input.action);
      if(record.enabled&&!this.active)fail('RECOVERY_REQUIRED');
      let target: AppManifest|undefined;
      if(['upgrade','rollback'].includes(input.action)) {
        const parsed=validateAppManifest(input.targetManifest);if(!parsed.ok)fail('INVALID_MANIFEST');target=parsed.manifest;
      } else if(input.targetManifest!==undefined)fail('UNEXPECTED_MANIFEST');
      if(starting) {
        await this.workJournal.assertDrained(record.id);
        if(hosted(record)&&(!this.options.docker||!record.manifest.health))fail('HOSTED_RUNTIME_NOT_CONFIGURED');
        if(record.manifest.backend.mode==='external'&&!this.options.external)fail('EXTERNAL_RUNTIME_NOT_CONFIGURED');
        if(record.manifest.api.length&&!this.options.api)fail('API_NOT_CONFIGURED');
        if(contributions(record)&&!this.options.extensions)fail('EXTENSIONS_NOT_CONFIGURED');
        if(record.manifest.storage.mode==='managed'&&!this.options.storage)fail('STORAGE_NOT_CONFIGURED');
        // Under the runtime lease, renew only a stopped, drained installation; grants stay unchanged.
        if(hosted(record)&&(!this.credential||this.credential.identityId!==record.serviceIdentityId)) {
          const issued=record.serviceIdentityId
            ?await this.options.registry.renewServiceCredential(context,record.appId,record.revision)
            :await this.options.registry.issueServiceCredential(context,record.appId,record.revision);
          record=issued.installation;this.credential={identityId:record.serviceIdentityId!,value:issued.credential};
        }
      }
      record=await this.options.registry.beginLifecycle(context,record.appId,record.revision,input.action,target);
      try {
        await this.quiesce(context,record);
        if(starting) return await this.start(context,record);
        if(record.manifest.storage.mode==='managed') {
          if(!this.options.storage)fail('STORAGE_NOT_CONFIGURED');
          await this.options.storage.recover(context,record.appId,record.revision);
          if(input.action==='uninstall')await this.options.storage.preserve(context,record.appId,record.revision);
          if(target)await this.options.storage.validateVersion(context,record.appId,record.revision,target);
        }
        if(target) await this.stage(target);
        await this.lease!.assertHeld();
        const result=await this.options.registry.settleLifecycle(context,record.appId,record.revision,record.lifecycle!.operationId,'completed');
        if(target&&result.manifest.storage.mode==='managed'){
          await this.options.storage!.adoptVersion(context,result.appId,result.revision);
          await this.migrate(context,result);
        }
        if(target||input.action==='uninstall')this.credential=undefined;
        await this.release();return result;
      } catch(cause) {
        await this.failClosed(context,record);throw new AppLifecycleHostError('LIFECYCLE_RECOVERY_REQUIRED',{cause});
      }
    });
  }
  /** Reacquire exclusive ownership, disable first, reconcile durable effects, then stop/remove.
   * Never completes an interrupted install or replays an uncertain write. */
  recover(context: PlatformManagementContext, revision: number) {
    return this.exclusive(context,revision,async record=>{
      if(!record.lifecycle||['completed','cancelled'].includes(record.lifecycle.status)) {
        if(!record.enabled&&record.lifecycle?.status==='completed'&&['upgrade','rollback'].includes(record.lifecycle.action)&&record.manifest.storage.mode==='managed') {
          if(!this.options.storage)fail('STORAGE_NOT_CONFIGURED');
          await this.options.storage.adoptVersion(context,record.appId,record.revision);await this.release();return record;
        }
        record=await this.options.registry.beginLifecycle(context,record.appId,record.revision,'disable');
      }
      try {
        await this.quiesce(context,record);
        if(record.manifest.storage.mode==='managed') {
          if(!this.options.storage)fail('STORAGE_NOT_CONFIGURED');
          await this.options.storage.recover(context,record.appId,record.revision);
        }
        await this.lease!.assertHeld();
        const result=await this.options.registry.settleLifecycle(context,record.appId,record.revision,record.lifecycle!.operationId,'cancelled');
        await this.release();return result;
      } catch {await this.failClosed(context,record);throw new AppLifecycleHostError('LIFECYCLE_RECOVERY_REQUIRED');}
    });
  }
  private async exclusive<T>(context: PlatformManagementContext, revision: number, work:(record:AppInstallation)=>Promise<T>):Promise<T> {
    if(this.busy)fail('LIFECYCLE_BUSY');this.busy=true;
    try {
      if(!isNativeManagementActor(context)||!(await context.authorize('platform.authorization.manage',{})).allowed)fail('LIFECYCLE_ACCESS_DENIED');
      const record=await this.options.registry.get(context,this.options.appId);
      if(record.revision!==revision)fail('STALE_REVISION');
      if(this.lease?.signal.aborted) {
        // A fresh lease permits recovery, not activation; local cleanup handles remain retained.
        await this.lease.release();this.lease=undefined;
      }
      if(!this.lease) {
        this.lease=await acquireAppRuntimeLease({installationId:record.id,connect:this.options.connectLease});
        this.lease.signal.addEventListener('abort',()=>{
          this.active=undefined;this.api?.close();
          void this.extensions?.stop().catch(()=>{});void this.bridge?.stop().catch(()=>{});
        },{once:true});
      }
      await this.lease.assertHeld();return await work(record);
    } finally {this.busy=false;}
  }
  private stage(manifest: AppManifest) {return stageAppArtifacts({root:this.options.artifactRoot,manifest,read:(id,max)=>this.options.readArtifact(manifest,id,max)});}
  private async migrate(context:PlatformManagementContext,record:AppInstallation){
    if(record.manifest.storage.mode!=='managed')return;
    for(let index=0;index<=record.manifest.storage.migrations.length;index++){
      await this.lease!.assertHeld();
      const step=await this.options.storage!.executeNext(context,record.appId,record.revision);
      if(step.status==='complete')return;
      if(step.status!=='applied')fail('MIGRATION_NOT_CONFIRMED');
    }
    fail('MIGRATION_LIMIT');
  }
  private async start(context:PlatformManagementContext,record:AppInstallation):Promise<AppInstallation> {
    const bundle=await this.stage(record.manifest);
    if(record.manifest.storage.mode==='managed') {
      const storage=this.options.storage!;await storage.provision(context,record.appId,record.revision);
      await this.migrate(context,record);
    }
    let checkRuntime=async()=>{};
    if(hosted(record)) {
      const d=this.options.docker!;
      const supervisor=new AppDockerSupervisor(this.options.registry,d.journal,d.executor);
      const policy=compileAppDockerPolicy({installation:record,operationId:record.lifecycle!.operationId,runtimeImage:d.runtimeImage,verifiedBundlePath:bundle.path,network:'none',gateway:'stdio'});
      const previous=await d.journal.latest(record.id);
      let attempt=await supervisor.dispatch(context,{appId:record.appId,revision:record.revision,operationId:record.lifecycle!.operationId,expectedSequence:previous?.sequence??0,action:'create',containerId:null,policy,approval:d.approval});
      const attachment=await attachAppDocker({socketPath:d.socketPath,executor:d.executor,policy,approval:d.approval,containerId:attempt.observation!.containerId});
      try {this.bridge=startAppStdioGateway({appId:record.appId,serviceCredential:this.credential!.value,gateway:this.gatedGateway,stdout:attachment.stdout,stdin:attachment.stdin,requireApiContext:record.manifest.api.length>0});}
      catch(error){attachment.close();throw error;}
      attempt=await supervisor.dispatch(context,{appId:record.appId,revision:record.revision,operationId:record.lifecycle!.operationId,expectedSequence:attempt.sequence,action:'start',containerId:attempt.observation!.containerId,policy,approval:d.approval});
      const readiness=new AppDockerReadiness(this.options.registry,d.journal,d.executor);
      checkRuntime=async()=>{await this.lease!.assertHeld();await readiness.check(context,record.appId,record.revision,record.lifecycle!.operationId);};
      const end=Date.now()+(this.options.healthWaitMs??30_000);
      while(true) {
        try {await checkRuntime();break;} catch(error) {
          const code=error instanceof Error?error.message:'';
          if(!['RUNTIME_NOT_HEALTHY','HEALTH_EVIDENCE_STALE'].includes(code)||Date.now()>=end)throw error;
          await new Promise<void>(resolve=>setTimeout(resolve,250));
        }
      }
    } else if(record.manifest.backend.mode==='external') checkRuntime=()=>this.options.external!.check(record,this.lease!.signal);
    // Prepare resources against the exact predicted committed generation. All ingress stays closed.
    if(this.options.extensions&&contributions(record)) {
      const ext=this.options.extensions;
      const predicted={...structuredClone(record),enabled:true,revision:record.revision+1};
      const lease=this.lease!;
      const handle=ext.registry.activate(predicted,ext.mappings,work=>this.workJournal.track(record.id,async()=>{
        if(this.options.maintenanceBlocked?.())fail('PLATFORM_MAINTENANCE');
        await lease.assertHeld();if(!this.active||this.active.revision!==predicted.revision)fail('RUNTIME_NOT_ACTIVE');
      },work,()=>this.options.gateway.drain(record.appId)));
      try {this.extensions=await startAppExtensionRuntime({...ext.options(predicted),handle,deferActivation:true,drainGateway:()=>this.options.gateway.drain(record.appId)});}
      catch(error){if(error instanceof AppExtensionRuntimeStartError)this.extensions=error.session;else handle.deactivate();throw error;}
    }
    const activate=async()=>{
      await checkRuntime();await this.lease!.assertHeld();
      const current=await this.options.registry.get(context,record.appId);
      if(current.revision!==record.revision||!isDeepStrictEqual(current.manifest,record.manifest))fail('STALE_REVISION');
      return this.options.registry.settleLifecycle(context,record.appId,record.revision,record.lifecycle!.operationId,'completed');
    };
    const enabled=record.manifest.storage.mode==='managed'?await this.options.storage!.withReady(context,record.appId,record.revision,activate):await activate();
    try {
      await this.extensions?.activate();
      if(enabled.manifest.api.length) {
        if(!this.options.api||!this.bridge)fail('API_NOT_CONFIGURED');
        this.api=createHostedAppApi({...this.options.api,installation:enabled,getInstallation:id=>this.options.registry.get(context,id),transport:this.bridge.api});
      }
      await this.lease!.assertHeld();this.active=enabled;return enabled;
    } catch {
      await this.disableFresh(context,enabled.appId);
      throw new AppLifecycleHostError('ACTIVATION_FAILED');
    }
  }
  private async quiesce(context:PlatformManagementContext,record:AppInstallation) {
    this.active=undefined;this.api?.close();
    // Close ingress synchronously. Retain cleanup handles until actual work is confirmed.
    const extensionStop=this.extensions?.stop();void extensionStop?.catch(()=>{});
    const bridgeStop=this.bridge?.stop();void bridgeStop?.catch(()=>{});
    const d=this.options.docker;
    if(d) {
      const supervisor=new AppDockerSupervisor(this.options.registry,d.journal,d.executor);
      let latest=await d.journal.latest(record.id);
      if(latest&&!['confirmed','rejected'].includes(latest.status))latest=await supervisor.reconcile(context,record.appId,latest.id);
      if(latest&&latest.status!=='rejected'&&latest.observation?.state!=='absent') {
        const dispatch=async(action:'stop'|'remove',attempt:AppDockerDispatchAttempt)=>{
          await this.lease!.assertHeld();
          return supervisor.dispatch(context,{appId:record.appId,revision:record.revision,operationId:record.lifecycle!.operationId,expectedSequence:attempt.sequence,action,containerId:attempt.observation!.containerId,policy:attempt.policy,approval:attempt.approval});
        };
        if(latest.observation?.state==='running')latest=await dispatch('stop',latest);
        // A created container has never run; stopped is also confirmed quiescent.
        latest=await dispatch('remove',latest);
      }
    }
    if(record.manifest.backend.mode==='external') {
      if(!this.options.external)fail('EXTERNAL_RUNTIME_NOT_CONFIGURED');await this.options.external.stop(record);
    }
    this.bridge?.api.confirmContainerStopped();
    // stop may have timed out while awaiting the now-confirmed container stop.
    await this.bridge?.stop();await this.api?.drain();await extensionStop;await this.options.gateway.drain(record.appId);
    await this.workJournal.assertDrained(record.id);
    this.bridge=undefined;this.extensions=undefined;this.api=undefined;
  }
  private async disableFresh(context:PlatformManagementContext,appId:string) {
    for(let attempt=0;attempt<3;attempt++){
      const current=await this.options.registry.get(context,appId);if(!current.enabled)return;
      try {await this.options.registry.setEnabled(context,appId,current.revision,false);return;}
      catch(error){if(!(error instanceof Error)||error.message!=='STALE_REVISION')throw error;}
    }
    fail('CONCURRENT_REGISTRY_CHANGE');
  }
  private async failClosed(context:PlatformManagementContext,record:AppInstallation) {
    this.active=undefined;this.api?.close();
    void this.bridge?.stop().catch(()=>{});void this.extensions?.stop().catch(()=>{});
    try {
      await this.disableFresh(context,record.appId);
      const current=await this.options.registry.get(context,record.appId);
      if(current.lifecycle?.operationId===record.lifecycle?.operationId&&['running','failed'].includes(current.lifecycle!.status))
        await this.options.registry.settleLifecycle(context,current.appId,current.revision,current.lifecycle!.operationId,'failed');
    } catch { /* Existing durable pending state remains the recovery blocker. */ }
  }
  async drainForMaintenance(){
    const deadline=Date.now()+60_000;
    while(true){
      const record=await this.options.registry.runtimeSnapshot(this.options.appId);
      const pending=await this.workJournal.pending(record.id);
      if(!pending.records.length&&!pending.hasMore&&this.apiCalls===0)return;
      if(Date.now()>=deadline)fail('RUNTIME_WORK_PENDING');
      await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  /** Process shutdown closes ingress without claiming the container stopped or settling registry state. */
  async close() {
    if(this.busy)fail('LIFECYCLE_BUSY');
    this.active=undefined;this.api?.close();
    await this.extensions?.stop();
    // Actual work must drain before ownership is released. A timeout retains the lease for recovery.
    await this.bridge?.stop();await this.api?.drain();await this.options.gateway.drain(this.options.appId);
    await this.release();
  }
  private async release() {const lease=this.lease;if(lease){await lease.release();this.lease=undefined;}}
}
