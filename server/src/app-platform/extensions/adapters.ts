import { createCoreEvent, type CoreEventBus } from '../../core/events/index.js';
import type { CoreJobDefinition } from '../../core/jobs/index.js';
import { CallToolResultSchema, type AuthInfo, type CoreMcpToolRegistration, type ServerContext } from '../../core/integrations/mcp/index.js';
import type { PlatformActorContext } from '../../platform/context/index.js';
import type { AuthorizationResource } from '../../platform/authorization/index.js';
import type { AppGatewayOperation, GatewayJson } from '../gateway/index.js';
import type { AppExtensionHandle } from './model.js';

export class AppExtensionAdapterError extends Error {
  constructor(readonly code: 'EXTENSION_ADAPTER_DENIED' | 'EXTENSION_ADAPTER_INVALID') { super(code); this.name='AppExtensionAdapterError'; }
}
/** Platform-owned named gateway operation. Publication is inside registry/gateway invocation, never after cached success. */
export function createAppEventPublication(options: {
  appId: string;
  eventType: string;
  operation: string;
  permissionCode: string;
  bus: Pick<CoreEventBus,'publish'>;
  validatePayload(value: GatewayJson): boolean;
  resolveResources(context: PlatformActorContext, value: GatewayJson): Promise<readonly AuthorizationResource[]>;
}): AppGatewayOperation {
  const {appId,eventType,operation,permissionCode,bus,validatePayload,resolveResources}=options;
  if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(appId) || !eventType.startsWith(`app.${appId}.`) || !/^app\.[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9]\d*$/.test(eventType)) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_INVALID');
  return {
    name:operation,permissionCode,mode:'write',
    validateParams:value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&validatePayload(value),
    resolveResources,
    async execute(context,value,signal){
      if(signal.aborted || context.execution.type==='platform' || context.execution.appId!==appId) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_DENIED');
      const event=createCoreEvent({type:eventType,source:`app.${appId}`,payload:value as Record<string,unknown>,correlationId:context.request.traceId});
      await bus.publish(event);
      return {eventId:event.id};
    },
    validateResult:value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as {eventId?:unknown}).eventId==='string',
  };
}
export function attachAppEventSubscriptions(handle:AppExtensionHandle,bus:Pick<CoreEventBus,'subscribe'>,resolveActor:()=>Promise<PlatformActorContext>) {
  const controller=new AbortController();
  const subscriptions=handle.descriptors.filter(d=>d.kind==='event-subscribe').map(d=>bus.subscribe(d.id,async event=>{
    if(controller.signal.aborted) return;
    const actor=await resolveActor();
    if(actor.actorType!=='service'||actor.execution.appId!==handle.appId) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_DENIED');
    await handle.invoke(actor,'event-subscribe',d.id,{eventId:event.id,type:event.type,source:event.source,payload:event.payload},controller.signal,event.id);
  }));
  return {stop(){controller.abort();for(const subscription of subscriptions)subscription.unsubscribe();}};
}
export function createAppJobDefinitions(handle:AppExtensionHandle,resolveActor:()=>Promise<PlatformActorContext>):CoreJobDefinition[] {
  const jobs=handle.descriptors.filter(d=>d.kind==='job');
  // Node would clamp an overflowing interval to 1ms. Reject before creating any definitions.
  if(jobs.some(d=>!Number.isSafeInteger(d.intervalSeconds)||d.intervalSeconds!*1000>2_147_483_647||d.intervalSeconds!<60)) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_INVALID');
  return jobs.map(d=>({
    // Length-prefix the application segment to preserve an unambiguous Core kebab-case ID.
    id:`app-${handle.appId.length}-${handle.appId}-job-${d.id}`,title:`${handle.appId}: ${d.id}`,intervalMs:d.intervalSeconds!*1000,maxAttempts:1,
    async run(context){
      const actor=await resolveActor();
      if(actor.actorType!=='service'||actor.execution.appId!==handle.appId) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_DENIED');
      await handle.invoke(actor,'job',d.id,{},context.signal);
    }
  }));
}
export async function listAppNavigation(handle:AppExtensionHandle,actor:PlatformActorContext) {
  return (await handle.list(actor)).filter(d=>d.kind==='route').flatMap(d=>(d.navigation??[]).map(n=>({
    ...n,id:`${handle.appId}:${n.id}`,routeId:d.id,path:`/platform/apps/${handle.appId}${d.path==='/'?'':d.path}`,
  }))).sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
}
export function createAppMcpToolRegistrations(handle:AppExtensionHandle,definitions:ReadonlyMap<string,CoreMcpToolRegistration['definition']>,resolveActor:(proof:AuthInfo,request:ServerContext)=>Promise<PlatformActorContext>):CoreMcpToolRegistration[] {
  const descriptors=handle.descriptors.filter(d=>d.kind==='tool');
  if(definitions.size!==descriptors.length) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_INVALID');
  return descriptors.map(d=>{
    const definition=definitions.get(d.id);
    if(!definition||definition.name!==`app_${handle.appId}__${d.id}`||definition._meta) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_INVALID');
    return {definition:structuredClone(definition),async call(args,request){
      if(!request.http?.authInfo) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_DENIED');
      const actor=await resolveActor(request.http.authInfo,request);
      if(!(await actor.authorize('platform.mcp.use')).allowed) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_DENIED');
      const result=await handle.invoke(actor,'tool',d.id,args);
      const parsed=CallToolResultSchema.safeParse(result);
      if(!parsed.success) throw new AppExtensionAdapterError('EXTENSION_ADAPTER_INVALID');
      return parsed.data;
    }};
  });
}
