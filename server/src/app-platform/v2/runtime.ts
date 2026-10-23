import type { ConnectablePool } from '../../core/database/index.js';
import type { AppGateway } from '../gateway/gateway.js';
import type { AppInstallation, AppRegistryService } from '../registry/index.js';
import { AppHostV2, type AppHostV2Options } from './host.js';
import { AppInstallerV2 } from './installer.js';
import { AppPackageStoreV2 } from './store.js';

export interface AppRuntimeV2Options {
  root: string;
  registry: AppRegistryService;
  pool: ConnectablePool;
  gateway: Pick<AppGateway, 'invokeHosted' | 'drain'>;
  api: AppHostV2Options['api'];
  findInstallation(appId: string): Promise<AppInstallation | null>;
  listInstallations(): Promise<AppInstallation[]>;
  platformVersion(): string;
  maintenanceBlocked?(): boolean;
  log?(line: string): void;
}

/** Application model v2 composition: package store, one host per installed v2 app, and the installer. */
export function createAppRuntimeV2(options: AppRuntimeV2Options) {
  const store = new AppPackageStoreV2(options.root);
  const hosts = new Map<string, AppHostV2>();
  let closed = false;
  const host = (appId: string) => {
    if (closed) throw new Error('APP_RUNTIME_CLOSED');
    let value = hosts.get(appId);
    if (!value) {
      value = new AppHostV2({ appId, registry: options.registry, store, gateway: options.gateway, api: options.api,
        ...(options.maintenanceBlocked ? { maintenanceBlocked: options.maintenanceBlocked } : {}), ...(options.log ? { log: options.log } : {}) });
      hosts.set(appId, value);
    }
    return value;
  };
  return {
    store,
    host,
    findHost: (appId: string) => closed ? undefined : hosts.get(appId),
    isV2: async (appId: string) => (await options.findInstallation(appId))?.runtime?.model === 'v2',
    installer: new AppInstallerV2({ registry: options.registry, findInstallation: options.findInstallation, pool: options.pool, store, host, platformVersion: options.platformVersion }),
    /** Starts every enabled v2 app. A failing app is logged and left for the administrator; others still start. */
    async boot() {
      for (const installation of await options.listInstallations()) {
        if (installation.runtime?.model !== 'v2' || !installation.enabled) continue;
        await host(installation.appId).serve(installation).catch(error => (options.log ?? console.error)(`[app:${installation.appId}] start failed: ${(error as Error).message}`));
      }
    },
    async close() { closed = true; await Promise.allSettled([...hosts.values()].map(value => value.close())); hosts.clear(); },
  };
}
export type AppRuntimeV2 = ReturnType<typeof createAppRuntimeV2>;
