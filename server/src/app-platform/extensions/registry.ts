import { validateAppManifest } from '../manifest/index.js';
import type { AppInstallation } from '../registry/model.js';
import { jsonSnapshot, type GatewayJson } from '../gateway/model.js';
import type { PlatformActorContext } from '../../platform/context/index.js';
import { AppExtensionError, type AppExtensionDescriptor, type AppExtensionHandle, type AppExtensionKind, type AppExtensionLimits, type AppExtensionMapping, type AppExtensionRegistryOptions } from './model.js';

export type AppExtensionExecutionBoundary = <T>(work:()=>Promise<T>)=>Promise<T>;
interface Generation {
  boundary?: AppExtensionExecutionBoundary;
  handle: AppExtensionHandle;
  controller: AbortController;
  pending: Set<Promise<unknown>>;
}
interface Delivery { expires: number; pending: boolean }
const defaults: AppExtensionLimits = { installations:128, contributions:512, concurrency:32, timeoutMs:10000, dedupeEntries:4096, dedupeTtlMs:3600000 };
function fail(code:string):never { throw new AppExtensionError(code); }

/** Single-process, trusted-host registry. Activation neither loads packages nor grants access. */
export class AppExtensionRegistry {
  private readonly generations = new Map<string, Generation>();
  private readonly deliveries = new Map<string, Delivery>();
  private serial = 0;
  private active = 0;
  private readonly limits: AppExtensionLimits;
  constructor(private readonly options: AppExtensionRegistryOptions) {
    this.limits = { ...defaults, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key as keyof AppExtensionLimits]) fail('INVALID_LIMIT');
    }
  }

  activate(installation: AppInstallation, mappings: readonly AppExtensionMapping[], boundary?: AppExtensionExecutionBoundary): AppExtensionHandle {
    const parsed = validateAppManifest(installation.manifest);
    if (!parsed.ok || !installation.enabled || installation.appId !== parsed.manifest.id || !installation.id || !Number.isSafeInteger(installation.revision) || installation.revision < 1) fail('INVALID_INSTALLATION');
    const manifest = parsed.manifest;
    if (!Array.isArray(mappings) || mappings.length > this.limits.contributions) fail('REGISTRY_FULL');
    const declarations: AppExtensionDescriptor[] = [
      ...manifest.events.publish.map(id => ({kind:'event-publish' as const,id,key:'' ,permissionCode:''})),
      ...manifest.events.subscribe.map(({event:id}) => ({kind:'event-subscribe' as const,id,key:'',permissionCode:''})),
      ...manifest.jobs.map(({id,intervalSeconds}) => ({kind:'job' as const,id,key:'',permissionCode:'',intervalSeconds})),
      ...manifest.tools.map(({name:id}) => ({kind:'tool' as const,id,key:'',permissionCode:''})),
      ...manifest.routes.map(({id,path,permission}) => ({kind:'route' as const,id,key:'',permissionCode:permission??'',path,
        navigation:manifest.navigation.filter(n=>n.routeId===id).map(({id,label,order})=>({id,label,order}))})),
    ];
    if (declarations.length !== mappings.length) fail('MANIFEST_MISMATCH');
    const permissions = new Set([...manifest.permissions.requested, ...manifest.permissions.defined.map(p=>p.code)]);
    const descriptors = declarations.map(declaration => {
      const matches = mappings.filter(m=>m.kind===declaration.kind && m.id===declaration.id);
      if (matches.length !== 1) fail('MANIFEST_MISMATCH');
      const mapping = matches[0];
      if (!permissions.has(mapping.permissionCode) || (declaration.permissionCode && mapping.permissionCode !== declaration.permissionCode)) fail('PERMISSION_MISMATCH');
      if (declaration.kind !== 'route' && (!mapping.operation || !/^[a-z][a-z0-9._-]{0,99}$/.test(mapping.operation))) fail('INVALID_OPERATION');
      if (declaration.kind === 'route' && mapping.operation !== undefined) fail('INVALID_OPERATION');
      return { ...declaration, permissionCode:mapping.permissionCode, ...(mapping.operation?{operation:mapping.operation}:{}), key:`${manifest.id}:${declaration.kind}:${declaration.id}` };
    });
    // Fully validate the candidate before aborting or replacing the current generation.
    const others = [...this.generations.values()].filter(g=>g.handle.appId!==manifest.id);
    if (others.length >= this.limits.installations || others.reduce((n,g)=>n+g.handle.descriptors.length,descriptors.length)>this.limits.contributions) fail('REGISTRY_FULL');
    const keys = new Set(others.flatMap(g=>g.handle.descriptors.map(d=>d.key)));
    if (descriptors.some(d=>keys.has(d.key))) fail('NAME_CONFLICT');
    const frozen = jsonSnapshot(descriptors,262144) as unknown as readonly AppExtensionDescriptor[];
    const generation: Generation = {boundary,controller:new AbortController(),pending:new Set(),handle:undefined as unknown as AppExtensionHandle};
    const handle: AppExtensionHandle = Object.freeze({
      appId:manifest.id, installationId:installation.id, version:manifest.version, revision:installation.revision,
      generation:++this.serial, descriptors:frozen, signal:generation.controller.signal,
      list:(context:PlatformActorContext)=>this.list(generation,context),
      invoke:(context:PlatformActorContext,kind:AppExtensionKind,id:string,payload:unknown,signal?:AbortSignal,deliveryKey?:string)=>this.invoke(generation,context,kind,id,payload,signal,deliveryKey),
      drain:async()=>{
        if(!generation.controller.signal.aborted) fail('DRAIN_REQUIRES_DEACTIVATION');
        await Promise.allSettled([...generation.pending]);
      },
      deactivate:()=>{ if(this.generations.get(manifest.id)===generation) this.deactivate(manifest.id); },
    });
    generation.handle=handle;
    const previous=this.generations.get(manifest.id);
    this.generations.set(manifest.id,generation);
    previous?.controller.abort();
    if(this.generations.get(manifest.id)!==generation) fail('STALE_EXTENSION');
    return handle;
  }

  deactivate(appId: string): void {
    const generation = this.generations.get(appId);
    this.generations.delete(appId);
    generation?.controller.abort();
  }

  private async current(g: Generation, context: PlatformActorContext): Promise<void> {
    const h=g.handle;
    if(g.controller.signal.aborted || this.generations.get(h.appId)!==g) fail('STALE_EXTENSION');
    if(context.execution.type==='platform' || context.execution.appId!==h.appId) fail('ACCESS_DENIED');
    const current=await this.options.getInstallation(h.appId);
    if(g.controller.signal.aborted || this.generations.get(h.appId)!==g || !current?.enabled || current.appId!==h.appId || current.id!==h.installationId || current.revision!==h.revision || current.manifest.version!==h.version) fail('STALE_EXTENSION');
    if(context.actorType==='service' && context.execution.serviceIdentityId!==current.serviceIdentityId) fail('ACCESS_DENIED');
  }

  private async list(g: Generation, context: PlatformActorContext): Promise<readonly AppExtensionDescriptor[]> {
    return this.bounded(g,undefined,async signal=>{
      await this.current(g,context);
      const visible: AppExtensionDescriptor[]=[];
      for(const descriptor of g.handle.descriptors) {
        if(signal.aborted) fail('ABORTED');
        if(await this.options.authorize(context,descriptor.permissionCode)) visible.push(descriptor);
      }
      await this.current(g,context);
      return Object.freeze(visible);
    });
  }

  private async invoke(g:Generation, context:PlatformActorContext, kind:AppExtensionKind, id:string, payload:unknown, signal?:AbortSignal, deliveryKey?:string):Promise<GatewayJson> {
    const descriptor=g.handle.descriptors.find(d=>d.kind===kind&&d.id===id);
    if(!descriptor?.operation || kind==='route') fail('EXTENSION_DENIED');
    const snapshot=jsonSnapshot(payload,65536);
    if(deliveryKey!==undefined && (!['event-publish','event-subscribe','job'].includes(kind) || !/^[\x21-\x7e]{1,192}$/.test(deliveryKey))) fail('INVALID_DELIVERY_KEY');
    return this.bounded(g,signal,async abort=>{
      await this.current(g,context);
      if(!await this.options.authorize(context,descriptor.permissionCode)) fail('ACCESS_DENIED');
      await this.current(g,context);
      if(abort.aborted) fail('ABORTED');
      let delivery:Delivery|undefined;
      if(deliveryKey!==undefined) {
        const now=Date.now();
        for(const [key,value] of this.deliveries) if(!value.pending&&value.expires<=now) this.deliveries.delete(key);
        const key=JSON.stringify([g.handle.installationId,g.handle.version,kind,id,deliveryKey]);
        if(this.deliveries.has(key)) fail('DUPLICATE_DELIVERY');
        if(this.deliveries.size>=this.limits.dedupeEntries) fail('DEDUPE_FULL');
        delivery={expires:now+this.limits.dedupeTtlMs,pending:true};this.deliveries.set(key,delivery);
      }
      try {
        const execute=()=>this.options.executeGateway(context,descriptor.operation!,snapshot,abort);
        const result=await (g.boundary?g.boundary(execute):execute());
        if(abort.aborted) fail('ABORTED');
        await this.current(g,context);
        if(!await this.options.authorize(context,descriptor.permissionCode)) fail('ACCESS_DENIED');
        await this.current(g,context);
        return jsonSnapshot(result,262144);
      } finally { if(delivery) { delivery.pending=false; delivery.expires=Date.now()+this.limits.dedupeTtlMs; } }
    });
  }

  /** Timeout releases the caller, but only actual settlement releases execution capacity. */
  private async bounded<T>(g:Generation, external:AbortSignal|undefined, work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
    if(g.controller.signal.aborted) fail('STALE_EXTENSION');
    if(external?.aborted) fail('ABORTED');
    if(this.active>=this.limits.concurrency) fail('BUSY');
    this.active++;
    const controller=new AbortController();
    let rejectAbort!:(error:Error)=>void;
    const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
    const stop=(code:string)=>{controller.abort();rejectAbort(new AppExtensionError(code));};
    const onExternal=()=>stop('ABORTED'), onGeneration=()=>stop('STALE_EXTENSION');
    external?.addEventListener('abort',onExternal,{once:true});
    g.controller.signal.addEventListener('abort',onGeneration,{once:true});
    const timer=setTimeout(()=>stop('TIMEOUT'),this.limits.timeoutMs);
    const running=Promise.resolve().then(()=>work(controller.signal)).finally(()=>{this.active--;g.pending.delete(running);});
    g.pending.add(running);
    try { return await Promise.race([running,aborted]); }
    catch(error) { if(error instanceof AppExtensionError) throw error; throw new AppExtensionError('EXTENSION_FAILED'); }
    finally { clearTimeout(timer);external?.removeEventListener('abort',onExternal);g.controller.signal.removeEventListener('abort',onGeneration); }
  }
}
