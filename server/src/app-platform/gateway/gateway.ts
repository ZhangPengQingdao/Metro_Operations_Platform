import type { PlatformPersonActorContext } from '../../platform/context/index.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TrustedActorIdentity } from '../../core/identity/index.js';
import { createCoreTraceContext, type CoreTechnicalAuditRepository } from '../../core/observability/index.js';
import type { PlatformActorContextResolver } from '../../platform/context/index.js';
import type { AppRegistryService } from '../registry/index.js';
import { GatewayAdmission, type GatewayLimits } from './limits.js';
import { GatewayError, jsonSnapshot, parseGatewayRequest, type AppGatewayOperation, type AppGatewayResponse } from './model.js';
/** Additional maximum wait for terminal audit acknowledgment after execution deadline. */
const AUDIT_ACK_GRACE_MS = 100;
export interface AppGatewayOptions {
  registry: Pick<AppRegistryService,'authenticateServiceCredential'>;
  contextResolver: Pick<PlatformActorContextResolver,'resolve'>;
  operations: readonly AppGatewayOperation[];
  limits?: Partial<GatewayLimits>;
  auditRepository?: Pick<CoreTechnicalAuditRepository,'append'>;
}
export class AppGateway {
  readonly admission: GatewayAdmission;
  private readonly pending = new Map<string, Set<Promise<void>>>();
  /** Trusted lifecycle: close application ingress first. Waits actual local work and terminal audit. */
  async drain(appId: string): Promise<void> {
    while(this.pending.get(appId)?.size) await Promise.allSettled([...this.pending.get(appId)!]);
  }
  private readonly operations = new Map<string,Readonly<AppGatewayOperation>>();
  constructor(private readonly options: AppGatewayOptions) {
    this.admission = new GatewayAdmission(options.limits);
    if (options.operations.length > 256) throw new Error('Too many gateway operations');
    for(const op of options.operations) {
      if(!/^[a-z][a-z0-9._-]{0,99}$/.test(op.name) || !/^[a-z][a-z0-9._-]{0,199}$/.test(op.permissionCode) || !['read','write'].includes(op.mode) || this.operations.has(op.name)) throw new Error('Invalid gateway operation');
      this.operations.set(op.name,Object.freeze({...op}));
    }
  }
  invokeService(appId:string,credential:string,request:unknown,signal?:AbortSignal,assertAdmission?:()=>Promise<void>,resolveEmployee?:()=>Promise<PlatformPersonActorContext>):Promise<AppGatewayResponse> {
    return this.invokeServiceFromTransport(appId,async()=>({credential,request:parseGatewayRequest(request,this.admission.limits.requestBytes)}),signal,assertAdmission,resolveEmployee);
  }
  /** Trusted transport reader runs inside the same admission slot and total deadline. */
  invokeServiceFromTransport(appId:string,readRequest:(signal:AbortSignal)=>Promise<{credential:string;request:unknown}>,signal?:AbortSignal,assertAdmission?:()=>Promise<void>,resolveEmployee?:()=>Promise<PlatformPersonActorContext>):Promise<AppGatewayResponse> {
    let credential='';
    return this.invoke(appId,async(signal)=>{const input=await readRequest(signal);credential=input.credential;return input.request;},async()=>{
      if(typeof credential!=='string'||credential.length>1024) throw new GatewayError('INVALID_CREDENTIAL',401);
      try {return await this.options.registry.authenticateServiceCredential(appId,credential);} catch {throw new GatewayError('INVALID_CREDENTIAL',401);}
    },signal,assertAdmission,resolveEmployee);
  }
  /** Host-only entry point: identity MUST come from verified L1 session/Bridge composition. */
  invokeDelegated(appId:string,trustedIdentity:TrustedActorIdentity,request:unknown,signal?:AbortSignal):Promise<AppGatewayResponse> {
    const identity=structuredClone(trustedIdentity);
    return this.invokeDelegatedFromSession(appId,async()=>identity,request,signal);
  }
  /** Trusted host callback, re-authenticated before execution and before result delivery. */
  invokeDelegatedFromSession(appId:string,resolveIdentity:()=>Promise<TrustedActorIdentity>,request:unknown,signal?:AbortSignal):Promise<AppGatewayResponse> {
    let pinned:TrustedActorIdentity|undefined;
    return this.invoke(appId,async()=>parseGatewayRequest(request,this.admission.limits.requestBytes),async()=>{
      const identity=structuredClone(await resolveIdentity());
      if(identity.source==='service') throw new GatewayError('INVALID_IDENTITY',401);
      if(pinned&&!isDeepStrictEqual(pinned,identity))throw new GatewayError('INVALID_IDENTITY',401);
      pinned??=identity;
      return {actorType:'person' as const,trustedIdentity:identity,execution:{type:'application' as const,appId}};
    },signal);
  }
  private async invoke(appId:string,readInput:(signal:AbortSignal)=>Promise<unknown>,identity:()=>Promise<Omit<Parameters<PlatformActorContextResolver['resolve']>[0],'requestId'|'traceId'>>,signal?:AbortSignal,assertAdmission?:()=>Promise<void>,resolveEmployee?:()=>Promise<PlatformPersonActorContext>):Promise<AppGatewayResponse> {
    this.admission.preauth();
    if(typeof appId!=='string'||!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(appId)||appId.length>100) throw new GatewayError('INVALID_REQUEST');
    const releaseSlot=this.admission.enter();
    let finish!:()=>void;
    const settled=new Promise<void>(resolve=>{finish=resolve;});
    const pending=this.pending.get(appId)??new Set<Promise<void>>();
    this.pending.set(appId,pending);pending.add(settled);
    const release=()=>{
      releaseSlot();pending.delete(settled);finish();
      if(!pending.size&&this.pending.get(appId)===pending)this.pending.delete(appId);
    };
    const controller=new AbortController();
    let writeStarted=false;
    const trace=createCoreTraceContext({requestId:randomUUID(),appId});
    const check=()=>{if(controller.signal.aborted) throw new GatewayError(signal?.aborted?'ABORTED':'TIMEOUT',signal?.aborted?499:504);};
    const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted) abort();
    let rejectDeadline:(reason:unknown)=>void=()=>{};
    const deadline=new Promise<never>((_,reject)=>{rejectDeadline=reject;});
    // One terminal audit attempt per invocation. A hung sink cannot hold the reply
    // indefinitely; AUDIT_FAILED means persistence was not confirmed (it may complete later).
    let terminalAudit: Promise<void> | undefined;
    const recordTerminal=(outcome:'succeeded'|'failed',errorCode?:string,mode?:'read'|'write')=>{
      if(!terminalAudit) terminalAudit=Promise.resolve().then(async()=>{
        await this.options.auditRepository?.append({category:'app',action:trace.operation??'gateway',outcome,context:{...trace},...(errorCode?{errorCode}:{}),metadata:{phase:'operation',deliveryConfirmed:false,...(mode?{mode}:{}),...(outcome==='failed'?{writeOutcome:writeStarted?'unknown':'not_started'}:{})}});
      });
      return terminalAudit;
    };
    const boundedAudit=async(audit:Promise<void>)=>{
      let auditTimer:ReturnType<typeof setTimeout>|undefined;
      try {
        await Promise.race([audit,new Promise<never>((_,reject)=>{auditTimer=setTimeout(()=>reject(new Error('audit deadline')),AUDIT_ACK_GRACE_MS);})]);
      }catch{throw new GatewayError('AUDIT_FAILED',503,writeStarted?'unknown':'not_started');}
      finally{if(auditTimer) clearTimeout(auditTimer);}
    };
    const onAbort=()=>{
      const failure=new GatewayError(signal?.aborted?'ABORTED':'TIMEOUT',signal?.aborted?499:504,writeStarted?'unknown':'not_started');
      void boundedAudit(recordTerminal('failed',failure.code)).then(()=>rejectDeadline(failure),rejectDeadline);
    };
    controller.signal.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(abort,this.admission.limits.timeoutMs);
    const run=async():Promise<AppGatewayResponse>=>{
      check();
      const input=await readInput(controller.signal);check();
      const request=parseGatewayRequest(input,this.admission.limits.requestBytes);
      const operation=this.operations.get(request.operation);
      if(!operation) throw new GatewayError('OPERATION_DENIED',403);
      trace.operation=operation.name;
      const fresh=async()=>{
        const guard=async()=>{check();try{await assertAdmission?.();}catch{throw new GatewayError('ACCESS_DENIED',403);}check();};
        check();const authenticated=await identity();check();
        // The identity factory is trusted; the union remains correlated at runtime.
        const actor=await this.options.contextResolver.resolve({...authenticated,requestId:trace.requestId!,traceId:trace.traceId} as Parameters<PlatformActorContextResolver['resolve']>[0]);
        // Storage reuses these methods immediately before COMMIT. Retain the host admission
        // guard on the operation context, not just at initial Gateway authentication.
        const employeeActor=resolveEmployee?await resolveEmployee():undefined;
        if(employeeActor&&(employeeActor.execution.type!=='application'||employeeActor.execution.appId!==appId))throw new GatewayError('INVALID_IDENTITY',401);
        // One admission check after resolving the checkpoint, before exposing its context.
        await guard();
        return {...actor,...(employeeActor?{employeeActor}:{}),authorize:async(...args:Parameters<typeof actor.authorize>)=>{check();const result=await actor.authorize(args[0],args[1]);await guard();return result;},
          ...(actor.authorizeApplication?{authorizeApplication:async(...args:Parameters<typeof actor.authorize>)=>{check();const result=await actor.authorizeApplication!(args[0],args[1]);await guard();return result;}}:{})};
      };
      let context=await fresh();check();
      trace.actorId=context.actorType==='person'?context.person.id:context.execution.serviceIdentityId;
      this.admission.authenticated(appId,context.actorType==='person'?context.person.id:'service');
      if(!operation.validateParams(request.params)) throw new GatewayError('INVALID_PARAMS');
      const authorize=async(refresh=true)=>{
        if(refresh)context=await fresh();check();
        const resources=await operation.resolveResources(context,request.params);check();
        if(!Array.isArray(resources)||resources.length<1||resources.length>128) throw new GatewayError('ACCESS_DENIED',403);
        for(const resource of resources) {if(!(await context.authorize(operation.permissionCode,resource)).allowed) throw new GatewayError('ACCESS_DENIED',403);check();}
      };
      await authorize(false);check();
      writeStarted=operation.mode==='write';
      const result=jsonSnapshot(await operation.execute(context,request.params,controller.signal),this.admission.limits.resultBytes);check();
      if(!operation.validateResult(result)) throw new GatewayError('INVALID_RESULT',502);
      await authorize();check();
      if(operation.resolveResultResources){
        const resources=await operation.resolveResultResources(context,result);check();
        if(!Array.isArray(resources)||!resources.length||resources.length>128)throw new GatewayError('ACCESS_DENIED',403);
        for(const resource of resources){if(!(await context.authorize(operation.permissionCode,resource)).allowed)throw new GatewayError('ACCESS_DENIED',403);check();}
      }
      await boundedAudit(recordTerminal('succeeded',undefined,operation.mode));check();
      return {version:'1.0',requestId:trace.requestId!,traceId:trace.traceId,result};
    };
    // Keep the slot until actual work settles, even if a noncooperative adapter ignores abort.
    const work=run().catch(async(error:unknown)=>{
      const safe=error instanceof GatewayError?error:new GatewayError('GATEWAY_FAILED',500);
      await boundedAudit(recordTerminal('failed',safe.code));
      throw new GatewayError(safe.code,safe.statusCode,writeStarted?'unknown':safe.writeOutcome);
    }).finally(()=>{
      // A stuck audit sink also retains its slot; bounded replies must not create unbounded background writes.
      if(terminalAudit) void terminalAudit.then(release,release); else release();
    });
    try { return await Promise.race([work,deadline]); }
    finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);}
  }
}
