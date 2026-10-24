/** Back-end helpers: employee context, business-scope checks and the handler-map back end. */
import {createAppGatewayClient, type AppGatewayJson} from './app-gateway.js';

/** Host-supplied audit identity, never a credential or a substitute for fresh authorization. */
export interface AppBackendEmployeeContext {
  readonly version: '1.0';
  readonly personId: string;
  readonly organizationUnitId: string;
  readonly requestId: string;
  readonly traceId: string;
  /** Fresh host-authorized permissions declared by this application. */
  readonly permissions?: readonly string[];
  /** Resolved application business grants. Absent only for legacy authorization. */
  readonly businessAuthorization?: {revision:string;grants:readonly AppBusinessGrant[];organizations:readonly {id:string;name:string}[]};

}
export interface AppBusinessGrant{permission:string;all:boolean;self:boolean;organizationIds:readonly string[]}
export function allowsAppResource(employee:AppBackendEmployeeContext,permission:string,resource:{organizationUnitId:string;ownerPersonId?:string|null}):boolean{
 const grant=employee.businessAuthorization?.grants.find(g=>g.permission===permission);
 return !!grant&&(grant.all||grant.organizationIds.includes(resource.organizationUnitId)||grant.self&&resource.ownerPersonId===employee.personId);
}
export function parseAppBackendEmployeeContext(value: unknown): Readonly<AppBackendEmployeeContext> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_EMPLOYEE_CONTEXT');
  const record=value as Record<string,unknown>;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!['organizationUnitId,personId,requestId,traceId,version','organizationUnitId,permissions,personId,requestId,traceId,version'].includes(Object.keys(record).filter(k=>k!=='businessAuthorization').sort().join(','))||record.version!=='1.0'||
    ![record.personId,record.organizationUnitId].every(v=>typeof v==='string'&&uuid.test(v))||
    ![record.requestId,record.traceId].every(v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f\u007f]/.test(v)))throw Error('INVALID_EMPLOYEE_CONTEXT');
  if(record.permissions!==undefined&&(!Array.isArray(record.permissions)||record.permissions.length>128||record.permissions.some(p=>typeof p!=='string'||!/^app\.[a-z0-9._-]+$/.test(p))||new Set(record.permissions).size!==record.permissions.length))throw Error('INVALID_EMPLOYEE_CONTEXT');
  if(record.businessAuthorization!==undefined){
   const a=record.businessAuthorization as {revision?:unknown;grants?:unknown;organizations?:unknown};
   if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).sort().join(',')!=='grants,organizations,revision'||typeof a.revision!=='string'||!uuid.test(a.revision)||!Array.isArray(a.grants)||a.grants.length>128)throw Error('INVALID_EMPLOYEE_CONTEXT');
   if(!Array.isArray(a.organizations)||a.organizations.length>128||a.organizations.some(o=>!o||Object.keys(o).sort().join(',')!=='id,name'||typeof o.id!=='string'||!uuid.test(o.id)||typeof o.name!=='string'||o.name.length>200))throw Error('INVALID_EMPLOYEE_CONTEXT');
   for(const g of a.grants){if(!g||typeof g!=='object'||Object.keys(g).sort().join(',')!=='all,organizationIds,permission,self'||typeof g.permission!=='string'||!/^app\.[a-z0-9._-]+$/.test(g.permission)||typeof g.all!=='boolean'||typeof g.self!=='boolean'||!Array.isArray(g.organizationIds)||g.organizationIds.length>2000||g.organizationIds.some((id:unknown)=>typeof id!=='string'||!uuid.test(id)))throw Error('INVALID_EMPLOYEE_CONTEXT');}
   record.businessAuthorization=Object.freeze({revision:a.revision,organizations:Object.freeze(a.organizations.map(o=>Object.freeze({...o}))),grants:Object.freeze(a.grants.map(g=>Object.freeze({...g,organizationIds:Object.freeze([...g.organizationIds])})))});
  }
  return Object.freeze({...record,...(record.permissions?{permissions:Object.freeze([...(record.permissions as string[])])}:{})}) as unknown as Readonly<AppBackendEmployeeContext>;
}
export interface AppBackendHandler {
  method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  path: string;
  execute(payload: AppGatewayJson, signal: AbortSignal, employee?: Readonly<AppBackendEmployeeContext>): Promise<AppGatewayJson>;
}
/**
 * Set by the platform's application process before it loads the app bundle. A handler-map back end
 * (`createAppBackend`) registers its handlers here and reaches the platform over IPC.
 */
export interface AppHostedRuntimeHook {
  register(handlers: ReadonlyMap<string, AppBackendHandler>): void;
  /** Platform operation bound to the employee call in progress, if any. Resolves to the result or throws `{code, writeOutcome}`. */
  platform(operation: string, params: AppGatewayJson): Promise<AppGatewayJson>;
  readonly signal: AbortSignal;
}
const HOSTED_HOOK = '__MOP_V2_CHILD__';
function hostedBackend(hook: AppHostedRuntimeHook, handlers: ReadonlyMap<string, AppBackendHandler>) {
  hook.register(new Map([...handlers].map(([key, value]) => [key, {...value}])));
  const gateway = createAppGatewayClient(async request => {
    try { return {version: '1.0', requestId: 'hosted', traceId: 'hosted', result: await hook.platform(request.operation, request.params)}; }
    catch (error) {
      const failure = error as {code?: unknown; writeOutcome?: unknown};
      return {version: '1.0', error: {code: typeof failure?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code) ? failure.code : 'GATEWAY_FAILED', writeOutcome: failure?.writeOutcome === 'not_started' ? 'not_started' : 'unknown'}};
    }
  });
  const whenClosed = new Promise<void>(resolve => { if (hook.signal.aborted) resolve(); else hook.signal.addEventListener('abort', () => resolve(), {once: true}); });
  return {gateway, signal: hook.signal, whenClosed, close() {}, async drain() {}};
}

/**
 * Back end written as a handler map. The platform's application process loads the bundle and serves these
 * handlers; platform operations go through `backend.gateway`. Prefer `defineServer` for new applications.
 */
export function createAppBackend(options: {handlers: ReadonlyMap<string, AppBackendHandler>}) {
  const hook = (globalThis as {[HOSTED_HOOK]?: AppHostedRuntimeHook})[HOSTED_HOOK];
  if (!hook) throw Error('APP_BACKEND_REQUIRES_PLATFORM_PROCESS');
  if (!options?.handlers || options.handlers.size > 128) throw Error('INVALID_BACKEND_OPTIONS');
  return hostedBackend(hook, options.handlers);
}
