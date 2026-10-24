import { createHash } from 'node:crypto';
import { readMopkg } from '@metro/platform-sdk/mopkg';
import type { AppManifestIssueV2 } from '@metro/platform-sdk/manifest';
import { runDatabaseTransaction, type ConnectablePool } from '../../core/database/index.js';
import type { PlatformManagementContext } from '../../platform/context/index.js';
import { previewAppPackageV2, summarizeInstallation } from './preview.js';
import { approveInstalledPlatformGrants } from '../management/platform-grants.js';
import type { AppInstallation, AppRegistryService, AppRuntimePackage } from '../registry/index.js';
import type { AppHostV2 } from './host.js';
import { applyAppMigrationsV2 } from './migration.js';
import { projectV2Manifest } from './projection.js';
import type { AppPackageStoreV2 } from './store.js';

export class AppInstallV2Error extends Error {
  constructor(readonly code: string, readonly issues: AppManifestIssueV2[] = []) { super(code); this.name = 'AppInstallV2Error'; }
}
export interface AppInstallerV2Options {
  registry: AppRegistryService;
  findInstallation(appId: string): Promise<AppInstallation | null>;
  pool: ConnectablePool;
  store: AppPackageStoreV2;
  host(appId: string): AppHostV2;
  platformVersion(): string;
}
export interface AppInstallV2Result { state: 'installed' | 'updated' | 'repaired'; appId: string; version: string; enabled: boolean }

/**
 * Installs or upgrades a `.mopkg`. Order: verify → store files → migrations (append-only, safe for the running
 * version) → registry version switch → service identity and platform grants → start. Every step is repeatable,
 * so a failed attempt can be retried by uploading the same package again.
 */
export class AppInstallerV2 {
  constructor(private readonly options: AppInstallerV2Options) {}

  /** `dev` (development mode only) also accepts a rebuilt package of the same version while the app is running. */
  async install(context: PlatformManagementContext, bytes: Uint8Array, options: { dev?: boolean } = {}): Promise<AppInstallV2Result> {
    const { registry } = this.options;
    const preview = await previewAppPackageV2(bytes, {
      platformVersion: this.options.platformVersion(), installAvailable: true,
      findInstalled: async appId => { const record = await this.options.findInstallation(appId); return record ? summarizeInstallation(record) : null; },
    });
    if (preview.issues.length || !preview.manifest || !preview.change) throw new AppInstallV2Error('PACKAGE_INVALID', preview.issues);
    if (!preview.installable) throw new AppInstallV2Error('PACKAGE_NOT_INSTALLABLE');
    const manifest = preview.manifest, appId = manifest.id, kind = preview.change.kind;
    const files = readMopkg(bytes);
    const digest = (path: string) => createHash('sha256').update(files.get(path)!).digest('hex');
    const projectFor = (installed?: AppInstallation) => projectV2Manifest(manifest, preview, digest, installed?.manifest);
    const runtime: AppRuntimePackage = { model: 'v2', sha256: preview.sha256, manifest };
    await this.options.store.write(appId, preview.sha256, files);
    const migrations = preview.migrations.map(migration => ({ id: migration.id, file: migration.file, text: files.get(migration.file)!.toString('utf8') }));
    const host = this.options.host(appId);

    let record: AppInstallation;
    const existing = await this.options.findInstallation(appId);
    if (!existing) record = await registry.register(context, projectFor(), `Install ${appId} ${manifest.version}`, 'standard', runtime);
    else {
      record = await registry.get(context, appId);
      if (existing.runtime?.model !== 'v2') throw new AppInstallV2Error('PACKAGE_NOT_INSTALLABLE');
      // Same version is only accepted as a repair of a stopped installation.
      if (kind === 'reinstall' && record.enabled && !options.dev) throw new AppInstallV2Error('VERSION_NOT_NEWER');
      if (options.dev && kind === 'reinstall' && record.runtime?.sha256 === preview.sha256 && record.enabled) return { state: 'repaired', appId, version: manifest.version, enabled: true };
      if (record.enabled) record = await host.execute(context, { revision: record.revision, action: 'disable' });
    }
    const wasEnabled = !!existing?.enabled;

    const client = await this.options.pool.connect();
    try {
      await runDatabaseTransaction(client, async () => {
        await applyAppMigrationsV2(client, record.id, migrations);
      });
    } finally { client.release(); }

    if (existing && kind === 'upgrade') {
      record = await registry.beginLifecycle(context, appId, record.revision, 'upgrade', projectFor(record));
      record = await registry.settleLifecycle(context, appId, record.revision, record.lifecycle!.operationId, 'completed');
    }
    if (existing && record.runtime?.sha256 !== preview.sha256) record = await registry.setRuntimePackage(context, appId, record.revision, runtime);
    // Upgrades clear the service identity and grants; issue them again for the new version.
    if (!record.serviceIdentityId) record = (await registry.issueServiceCredential(context, appId, record.revision)).installation;
    if (!record.grants.some(grant => grant.status === 'active')) record = await approveInstalledPlatformGrants(registry, context, appId);

    const start = !existing || kind === 'reinstall' || wasEnabled;
    if (start) record = record.lifecycle ? await host.execute(context, { revision: record.revision, action: 'enable' }) : await host.install(context, record.revision);
    return { state: !existing ? 'installed' : kind === 'upgrade' ? 'updated' : 'repaired', appId, version: manifest.version, enabled: record.enabled };
  }
}
