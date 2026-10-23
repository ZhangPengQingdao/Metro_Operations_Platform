import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseAppBackendEmployeeContext, type AppBackendEmployeeContext } from '@metro/platform-sdk/app-backend';
import type { TrustedActorIdentity } from '../../core/identity/index.js';
import type { PlatformActorContext, PlatformActorContextResolver, PlatformManagementContext, PlatformPersonActorContext } from '../../platform/context/index.js';
import type { AppGateway } from '../gateway/gateway.js';
import { GatewayError, jsonSnapshot, type GatewayJson } from '../gateway/model.js';
import type { AppInstallation, AppRegistryService } from '../registry/index.js';
import type { AppLifecycleRequest } from '../runtime/lifecycle-host.js';
import { AppProcessError, AppProcessV2, type AppProcessStatus } from './process.js';
import type { AppPackageStoreV2 } from './store.js';

/** Error returned to the employee client; `code` may be the application's own error code. */
export class AppV2CallError extends Error {
  constructor(readonly code: string, readonly statusCode = 400, readonly writeOutcome: 'not_started' | 'unknown' = 'not_started') { super(code); this.name = 'AppV2CallError'; }
}
export interface AppHostV2Options {
  appId: string;
  registry: Pick<AppRegistryService, 'get' | 'runtimeSnapshot' | 'beginLifecycle' | 'settleLifecycle'>;
  store: AppPackageStoreV2;
  gateway: Pick<AppGateway, 'invokeHosted' | 'drain'>;
  api: {
    contextResolver: Pick<PlatformActorContextResolver, 'resolve'>;
    authorize(context: PlatformActorContext, permission: string): Promise<boolean>;
    businessAuthorization(context: PlatformActorContext): Promise<AppBackendEmployeeContext['businessAuthorization']>;
  };
  maintenanceBlocked?(): boolean;
  log?(line: string): void;
}
type ApiRequest = { apiId: string; method: string; path: string; payload: unknown };
const PLATFORM_FAILURE = new Set(['APP_NOT_RUNNING', 'APP_BUSY', 'APP_PROCESS_EXITED', 'TIMEOUT', 'ABORTED', 'APP_START_FAILED', 'APP_START_TIMEOUT']);

/** One installed v2 application: its child process, lifecycle and employee API dispatch. */
export class AppHostV2 {
  private process: AppProcessV2 | null = null;
  private active: AppInstallation | null = null;
  /** Employee actor for each in-flight call, so the app's platform calls run with that employee bound. */
  private readonly employees = new Map<string, PlatformPersonActorContext>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AppHostV2Options) {}

  /** Serializes lifecycle changes for this app. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Starts the process for an installation that is (or is about to become) enabled. Used at boot and inside lifecycle steps. */
  serve(installation: AppInstallation): Promise<void> {
    return this.exclusive(() => this.startProcess(installation));
  }

  private async startProcess(installation: AppInstallation) {
    const runtime = installation.runtime;
    if (runtime?.model !== 'v2' || installation.appId !== this.options.appId) throw new AppV2CallError('INVALID_INSTALLATION', 409);
    await this.stopProcess();
    if (installation.manifest.backend.mode !== 'none') {
      const directory = this.options.store.directory(installation.appId, runtime.sha256);
      const process = new AppProcessV2({
        appId: installation.appId, serverPath: join(directory, 'server.js'), cwd: directory,
        memoryMiB: runtime.manifest.limits?.memoryMiB, timeoutMs: (runtime.manifest.limits?.timeoutSeconds ?? 30) * 1000,
        onPlatform: (operation, params, callId) => this.platform(operation, params, callId), ...(this.options.log ? { log: this.options.log } : {}),
      });
      this.process = process;
      await process.start();
    }
    this.active = installation;
  }

  private async stopProcess() {
    const process = this.process;
    this.process = null; this.active = null;
    if (process) await process.stop();
    await this.options.gateway.drain(this.options.appId);
  }

  /** Lifecycle: begin → start/stop the process → settle. A failed start settles as failed and leaves the app disabled. */
  private async transition(context: PlatformManagementContext, revision: number, action: 'install' | 'enable' | 'disable') {
    let record = await this.options.registry.beginLifecycle(context, this.options.appId, revision, action);
    const operationId = record.lifecycle!.operationId;
    try {
      if (action === 'disable') await this.stopProcess();
      else await this.startProcess(record);
    } catch (error) {
      await this.stopProcess().catch(() => undefined);
      await this.options.registry.settleLifecycle(context, this.options.appId, record.revision, operationId, 'failed');
      throw error instanceof AppProcessError ? new AppV2CallError(error.code, 409) : error;
    }
    record = await this.options.registry.settleLifecycle(context, this.options.appId, record.revision, operationId, 'completed');
    if (action !== 'disable') this.active = record;
    return record;
  }

  install(context: PlatformManagementContext, revision: number) { return this.exclusive(() => this.transition(context, revision, 'install')); }

  execute(context: PlatformManagementContext, request: AppLifecycleRequest) {
    if (request.action !== 'enable' && request.action !== 'disable') return Promise.reject(new AppV2CallError('UPLOAD_PACKAGE_REQUIRED', 409));
    return this.exclusive(() => this.transition(context, request.revision, request.action as 'enable' | 'disable'));
  }

  /** Restarts a process that stopped after repeated crashes, without changing the installation. */
  recover(context: PlatformManagementContext, _revision: number) {
    return this.exclusive(async () => {
      const installation = await this.options.registry.get(context, this.options.appId);
      if (installation.enabled) await this.startProcess(installation);
      return installation;
    });
  }
  prepareCredential(): Promise<never> { return Promise.reject(new AppV2CallError('NOT_APPLICABLE', 409)); }

  async status(context: PlatformManagementContext) { return this.statusOf(await this.options.registry.get(context, this.options.appId)); }
  private statusOf(installation: AppInstallation) {
    const process: AppProcessStatus | null = this.process?.status() ?? null;
    const serving = !!this.active && this.active.revision === installation.revision && installation.enabled && (installation.manifest.backend.mode === 'none' || process?.state === 'running');
    return { installation, pendingWork: { records: [] as unknown[], hasMore: false }, owned: true, serving, process };
  }

  async admittedSnapshot(): Promise<AppInstallation> {
    const active = this.active;
    if (!active) throw new GatewayError('ACCESS_DENIED', 403);
    const installation = await this.options.registry.runtimeSnapshot(this.options.appId);
    if (!installation.enabled || installation.revision !== active.revision || this.active !== active) throw new GatewayError('ACCESS_DENIED', 403);
    return installation;
  }

  async drainForMaintenance() { await this.exclusive(() => this.stopProcess()); }
  async close() { await this.exclusive(() => this.stopProcess()); }

  /** Employee API call: same permission rules as v1 hosted APIs, dispatched over IPC instead of Docker stdio. */
  async invokeEmployeeApi(resolveIdentity: () => Promise<TrustedActorIdentity>, request: ApiRequest, signal?: AbortSignal): Promise<GatewayJson> {
    if (this.options.maintenanceBlocked?.()) throw new AppV2CallError('PLATFORM_MAINTENANCE', 503);
    const identity = structuredClone(await resolveIdentity());
    if (identity.source === 'service') throw new GatewayError('ACCESS_DENIED', 403);
    const installation = await this.admittedSnapshot();
    const manifest = installation.manifest;
    const api = manifest.api.find(item => item.id === request.apiId && item.method === request.method && item.path === request.path);
    if (!api?.permission) throw new AppV2CallError('API_DENIED', 403);
    const requestId = randomUUID();
    const actor = await this.options.api.contextResolver.resolve({ actorType: 'person', trustedIdentity: identity, execution: { type: 'application', appId: this.options.appId }, requestId, traceId: requestId });
    if (actor.actorType !== 'person' || !actor.person?.organization?.id) throw new GatewayError('ACCESS_DENIED', 403);
    const business = await this.options.api.businessAuthorization(actor);
    const allowed = business && api.businessEntry ? business.grants.length > 0 : await this.options.api.authorize(actor, business ? api.businessPermission ?? api.permission : api.permission);
    if (!allowed) throw new GatewayError('ACCESS_DENIED', 403);
    const permissions: string[] = [];
    for (const permission of manifest.permissions.defined) if (await this.options.api.authorize(actor, permission.code)) permissions.push(permission.code);
    const employee = parseAppBackendEmployeeContext({ version: '1.0', personId: actor.person.id, organizationUnitId: actor.person.organization.id, requestId, traceId: requestId, permissions, ...(business ? { businessAuthorization: business } : {}) });
    let payload: GatewayJson;
    try { payload = jsonSnapshot(request.payload, 60 * 1024); } catch { throw new AppV2CallError('INVALID_PAYLOAD', 400); }
    const process = this.process;
    if (!process) throw new AppV2CallError('APP_NOT_RUNNING', 503);
    this.employees.set(requestId, actor as PlatformPersonActorContext);
    try {
      return jsonSnapshot(await process.call(api.handler, payload, employee, signal, requestId), 256 * 1024);
    } catch (error) {
      if (error instanceof AppProcessError) throw new AppV2CallError(error.code, PLATFORM_FAILURE.has(error.code) ? 503 : 400, error.writeOutcome);
      throw new AppV2CallError('INVALID_RESULT', 502, 'unknown');
    } finally { this.employees.delete(requestId); }
  }

  /** Platform operation requested by the app process, executed as the app's service identity (and the bound employee). */
  private async platform(operation: string, params: unknown, callId: string | undefined): Promise<unknown> {
    const employee = callId ? this.employees.get(callId) : undefined;
    if (callId && !employee) throw new GatewayError('ACCESS_DENIED', 403);
    const response = await this.options.gateway.invokeHosted(this.options.appId, async () => {
      const record = await this.options.registry.runtimeSnapshot(this.options.appId);
      if (!record.enabled || !record.serviceIdentityId || record.runtime?.model !== 'v2') throw new GatewayError('ACCESS_DENIED', 403);
      return record.serviceIdentityId;
    }, { version: '1.0', operation, params: params ?? null }, undefined, employee ? async () => employee : undefined);
    return response.result;
  }

  /** v1-only entry points: sandbox bridge gateway and cross-application capability calls. */
  invokeDelegated(): Promise<never> { return Promise.reject(new GatewayError('ACCESS_DENIED', 403)); }
  invokeApi(): Promise<never> { return Promise.reject(new GatewayError('OPERATION_DENIED', 403)); }
}
