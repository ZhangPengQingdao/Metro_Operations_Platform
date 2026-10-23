/** Application model v2 back end. `server.js` default-exports `defineServer(...)`; the platform runs it in a managed child process. */
import { randomUUID } from 'node:crypto';
import { allowsAppResource, type AppBackendEmployeeContext } from './app-backend.js';
import { createAppDataClient, type AppGatewayJson, type createAppGatewayClient } from './app-gateway.js';
import { appPermissionCode } from './manifest.js';

type Gateway = Pick<ReturnType<typeof createAppGatewayClient>, 'invoke'>;
export interface AppResource { organizationUnitId: string; ownerPersonId?: string | null }

export class AppServerError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'AppServerError'; }
}

export interface AppServerBaseContext {
  readonly appId: string;
  readonly data: ReturnType<typeof createAppDataClient>;
  /** Platform capabilities, e.g. `platform.people.members`; limited by app.json `platformAccess`. */
  readonly platform: Gateway;
  readonly signal: AbortSignal;
  log(message: string, details?: AppGatewayJson): void;
  uuid(): string;
}
export interface AppServerContext extends AppServerBaseContext {
  readonly employee: Readonly<AppBackendEmployeeContext>;
  /** Short (`inspect`) or full (`app.<id>.inspect`) permission code, checked against the employee's data scope. */
  can(permission: string, resource?: AppResource): boolean;
  require(permission: string, resource?: AppResource): void;
}
export type AppServerHandler = (input: AppGatewayJson, context: AppServerContext) => AppGatewayJson | Promise<AppGatewayJson>;
export interface AppServerHooks {
  /** Runs once after the process starts; use for timers such as recurring tasks. */
  start?(context: AppServerBaseContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}
export interface AppServerDefinition {
  readonly kind: 'mop-server';
  readonly version: 1;
  readonly handlers: Readonly<Record<string, AppServerHandler>>;
  readonly hooks: Readonly<AppServerHooks>;
}

const API_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Handler names must match the `api[].id` values in app.json; `mop build` checks this. */
export function defineServer(handlers: Record<string, AppServerHandler>, hooks: AppServerHooks = {}): AppServerDefinition {
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) throw new TypeError('defineServer: handlers 应为对象');
  const names = Object.keys(handlers);
  if (names.length > 128) throw new TypeError('defineServer: 接口不超过 128 个');
  for (const name of names) {
    if (name.length > 64 || !API_ID.test(name)) throw new TypeError(`defineServer: 接口名无效 ${name}`);
    if (typeof handlers[name] !== 'function') throw new TypeError(`defineServer: ${name} 不是函数`);
  }
  for (const key of ['start', 'stop'] as const) if (hooks[key] !== undefined && typeof hooks[key] !== 'function') throw new TypeError(`defineServer: ${key} 不是函数`);
  return Object.freeze({ kind: 'mop-server', version: 1, handlers: Object.freeze({ ...handlers }), hooks: Object.freeze({ ...hooks }) });
}

export function isAppServerDefinition(value: unknown): value is AppServerDefinition {
  return !!value && typeof value === 'object' && (value as AppServerDefinition).kind === 'mop-server' && (value as AppServerDefinition).version === 1;
}

/** Builds the per-call context. Used by the platform runtime and by app tests with a fake gateway. */
export function createAppServerContext(options: {
  appId: string; gateway: Gateway; employee: Readonly<AppBackendEmployeeContext>; signal: AbortSignal;
  log?: (message: string, details?: AppGatewayJson) => void;
}): AppServerContext {
  const { appId, employee } = options;
  const can = (permission: string, resource?: AppResource) => {
    const code = appPermissionCode(appId, permission);
    if (!resource) return !!employee.businessAuthorization?.grants.some(grant => grant.permission === code) || !!employee.permissions?.includes(code);
    return allowsAppResource(employee, code, resource);
  };
  return Object.freeze({
    appId, employee, signal: options.signal, platform: options.gateway,
    data: createAppDataClient(options.gateway),
    log: options.log ?? ((message: string) => { console.log(message); }),
    uuid: () => randomUUID(),
    can,
    require(permission: string, resource?: AppResource) { if (!can(permission, resource)) throw new AppServerError('ACCESS_DENIED', '没有执行该操作的权限'); },
  });
}
